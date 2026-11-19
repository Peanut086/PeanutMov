<script setup lang="ts">
/**
 * 确定性坏源账本（P1-2）
 *
 * 与「崩溃隔离名单」是两套独立判据，必须分开列：
 * - 隔离/冷却看的是进程怎么死的（崩溃归因，原生侧记账）；
 * - 这里看的是 jar/规则**装得上装不上**（缺类、字节码不兼容、md5 不符、脚本语法错），
 *   由 JS 侧按 `源 + 版本 + App 运行时版本` 记账，命中只跳过后台预热，不拦真实搜索。
 *
 * 为什么值得单独一块：这类源每轮冷启动都会被重新下载、重新加载、重新失败一遍，
 * 既占爬虫池又吃搜索预算，而日志里它长得跟"网络抖动"一样（`爬虫源预热失败（静默）`），
 * 用户完全看不出来有个源一直在原地打转。记账条件与豁免口径见 `spiderLoadLedger`。
 *
 * 「复检」不是清空判定，而是让这一版重新真跑一次：清账 → 单源连接测试 → 失败会当场再记回来，
 * 成功说明源已修好。源本身已经被删掉/改名的条目只清理，不留陈账。
 */
import { computed, onMounted, ref } from 'vue';

import { useToast } from '@/composables/useToast';
import { healthService } from '@/services/healthService';
import {
  LOAD_FAILURE_LABELS,
  clearLoadFailure,
  listLoadFailures,
  sourceLedgerKey,
  type SpiderLoadFailure,
} from '@/services/spiderLoadLedger';
import { useSourceStore } from '@/stores/sourceStore';
import { logger } from '@/shared/logger';

const store = useSourceStore();
const toast = useToast();

const rows = ref<SpiderLoadFailure[]>([]);
const busy = ref<string | null>(null);
const loaded = ref(false);

interface RowView {
  row: SpiderLoadFailure;
  name: string;
  /** 账本里的源还在订阅里；不在就只能清理，没有可复检的对象 */
  exists: boolean;
  sourceId: string | null;
  label: string;
  targetHint: string;
}

const view = computed<RowView[]>(() =>
  rows.value.map((row) => {
    const match = store.sources.find((s) => sourceLedgerKey(s) === row.sourceKey) ?? null;
    return {
      row,
      name: match?.name ?? row.sourceKey,
      exists: match !== null,
      sourceId: match?.id ?? null,
      label: LOAD_FAILURE_LABELS[row.kind] ?? '加载失败',
      targetHint: row.target.replace(/^https?:\/\//, '').slice(0, 60),
    };
  }),
);

async function refresh(): Promise<void> {
  try {
    rows.value = await listLoadFailures();
    loaded.value = true;
  } catch {
    /* 读账本失败保持当前列表，不打断页面 */
  }
}

async function recheck(item: RowView): Promise<void> {
  if (busy.value !== null) return;
  busy.value = item.row.sourceKey;
  try {
    await clearLoadFailure(item.row.sourceKey);
    if (!item.exists || !item.sourceId) {
      toast.success('该源已不在订阅里，账本记录已清理');
    } else {
      // 单源体检会真走一次加载：仍失败就地重新记账，成功则该源恢复正常预热
      await healthService.check([item.sourceId]);
      await store.load();
      const after = store.sources.find((s) => s.id === item.sourceId);
      if (after?.health === 'ok') toast.success(`${item.name} 复检通过，已恢复后台预热`);
      else toast.error(`${item.name} 仍然加载失败，已重新记账`);
    }
    await refresh();
  } catch (e) {
    toast.error('复检失败，请稍后重试');
    logger.debug('确定性坏源复检异常', item.name, e);
  } finally {
    busy.value = null;
  }
}

onMounted(() => {
  // 源列表由宿主页面（健康中心）负责加载：这里再 load 一次只是重复读库，
  // 还会让「读取失败→重试」的调用次数变得不可预期。store.sources 是响应式的，
  // 宿主加载完成后本卡的源名会自动跟上。
  void refresh();
});

defineExpose({ refresh });
</script>

<template>
  <section v-if="loaded && view.length > 0" class="loadfail" aria-labelledby="loadfail-title">
    <div class="loadfail__head">
      <h2 id="loadfail-title" class="section-title">已跳过的确定性坏源</h2>
      <span class="loadfail__meta">{{ view.length }} 个</span>
    </div>

    <p class="loadfail__note">
      这些源在「同一版 jar/规则 + 当前 App 版本」下每次都装不上（缺类、字节码不兼容、jar 校验不过、
      脚本语法错）。与网络无关，重跑一遍结果一样，所以后台预热不再反复下载它们；
      搜索时仍会照常发起，不会因此少一路结果。订阅更新或 App 升级后会自动重试。
    </p>

    <ul class="loadfail__list">
      <li v-for="item in view" :key="item.row.sourceKey" class="loadfail__item">
        <div class="loadfail__id">
          <span class="loadfail__name">{{ item.name }}</span>
          <span class="loadfail__reason">{{ item.label }}</span>
          <span class="loadfail__target">{{ item.targetHint }}</span>
        </div>
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          :disabled="busy !== null"
          @click="recheck(item)"
        >
          {{ busy === item.row.sourceKey ? '复检中…' : item.exists ? '立即复检' : '清理记录' }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.loadfail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.loadfail__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.loadfail__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.loadfail__note {
  font: var(--text-caption);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.loadfail__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.loadfail__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-base);
}

.loadfail__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.loadfail__name {
  font: var(--text-label);
  color: var(--color-text-primary);
}

.loadfail__reason {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.loadfail__target {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  word-break: break-all;
}
</style>
