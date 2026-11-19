<script setup lang="ts">
/**
 * 崩溃隔离名单面板（FIX-1 / P0-1）
 *
 * 爬虫 jar 有两档保护态，来源与时长都不同，必须分开列：
 * - 隔离（`spider:<jarMd5>:<api>` / `spider:<jarMd5>:*`）：同一 api 24h 内崩 2 次、同一 jar
 *   换 api 崩 2 次，或原生 tombstone 实锤落在该 jar 上 → 停 7 天；
 * - 短时冷却：崩过一次但当场没有实锤 → 只停半小时，到点自动放行，**不在隔离名单里**。
 *
 * 此前原生虽已实现 `getQuarantined`/`unquarantine`，但前端无任何入口，"源体检可手动解除"是
 * 空头承诺；P0-1 加了冷却档之后，如果面板只显隔离名单，就会出现「源打不开、名单却是空的」，
 * 所以冷却档同表展示。解除是安全的：仅清掉一条记录；若该爬虫真的还会崩，下次崩溃会重新拦。
 *
 * 本组件直接走 `Spider` 原生插件（与 SafeModeBanner 同模式），不经过 store：
 * 隔离态是原生运行时状态，不落 IndexedDB。Web 环境无此能力，整卡隐藏。
 */
import { computed, onMounted, ref } from 'vue';

import { useToast } from '@/composables/useToast';
import { Spider } from '@/native/spiderPlugin';
import { isNative } from '@/shared/platform';

const toast = useToast();

const available = ref(false);
const loading = ref(false);
const busy = ref<string | null>(null);
const items = ref<string[]>([]);

interface ParsedSignature {
  raw: string;
  /** 爬虫类名（csp_Xxx），jar 级隔离时为 `*` */
  api: string;
  /** jar 指纹前 8 位，便于同 jar 多条归组识别 */
  jarHint: string;
  /** 整 jar 级隔离（api 为 `*`） */
  wholeJar: boolean;
  /** 属于冷却档（短时、自动放行）而不是隔离档 */
  cooling: boolean;
  /** 冷却档剩余分钟（向上取整，至少 1 分钟），隔离档为 null */
  remainMin: number | null;
}

/** 把 `spider:<jarMd5>:<api>` 解析成可读条目；无法解析的签名按原文兜底展示 */
function parseSignature(raw: string, cooling = false, remainMs?: number): ParsedSignature {
  const parts = raw.split(':');
  const api = parts.length >= 3 ? parts.slice(2).join(':') : '';
  const jar = parts.length >= 2 ? parts[1] : '';
  return {
    raw,
    api: api || raw,
    jarHint: jar ? jar.slice(0, 8) : '',
    wholeJar: api === '*',
    cooling,
    remainMin:
      cooling && typeof remainMs === 'number' ? Math.max(1, Math.ceil(remainMs / 60000)) : null,
  };
}

const entries = ref<ParsedSignature[]>([]);

const quarantineCount = computed(() => entries.value.filter((e) => !e.cooling).length);
const cooldownCount = computed(() => entries.value.filter((e) => e.cooling).length);

/** 隔离在前、冷却在后：前者是 7 天的硬停，后者到点自己好 */
function sortEntries(list: ParsedSignature[]): ParsedSignature[] {
  return [...list].sort((a, b) => Number(a.cooling) - Number(b.cooling));
}

async function refresh(): Promise<void> {
  if (!isNative()) return;
  loading.value = true;
  try {
    const result = await Spider.getQuarantined();
    items.value = Array.isArray(result.items) ? result.items : [];
    // 旧版原生没有 cooldowns 字段（升级中装的半新包）：按只有隔离档渲染，不要整卡报错
    const rawCooldowns = Array.isArray(result.cooldowns) ? result.cooldowns : [];
    entries.value = sortEntries([
      ...items.value.map((sig) => parseSignature(sig)),
      ...rawCooldowns.map((row) => parseSignature(row.signature, true, row.remainMs)),
    ]);
    available.value = true;
  } catch {
    /* 查询失败：保持当前列表不变，不打断页面 */
  } finally {
    loading.value = false;
  }
}

async function release(signature: string): Promise<void> {
  if (busy.value !== null) return;
  busy.value = signature;
  try {
    await Spider.unquarantine({ signature });
    toast.success('已放行，下次播放将重新加载该爬虫');
    await refresh();
  } catch {
    toast.error('解除失败，请稍后重试');
  } finally {
    busy.value = null;
  }
}

onMounted(() => {
  void refresh();
});

defineExpose({ refresh });
</script>

<template>
  <section v-if="available && entries.length > 0" class="quarantine" aria-labelledby="quarantine-title">
    <div class="quarantine__head">
      <h2 id="quarantine-title" class="section-title">崩溃隔离名单</h2>
      <span class="quarantine__meta">
        隔离 {{ quarantineCount }} · 冷却 {{ cooldownCount }}
      </span>
    </div>

    <p class="quarantine__note">
      同一爬虫 24 小时内崩溃 2 次会被隔离 7 天；只崩过一次、当场没有实锤的只做 30 分钟冷却，到点自动放行。
      原生崩溃取证直接落在整个 jar 上时按 jar 隔离。确认不是源本身的问题后可在此解除；
      若爬虫仍会崩，解除后会再次被拦。
    </p>

    <ul class="quarantine__list">
      <li v-for="entry in entries" :key="entry.raw" class="quarantine__item">
        <div class="quarantine__id">
          <span class="quarantine__api">{{ entry.wholeJar ? '整个 jar 级隔离' : entry.api }}</span>
          <span class="quarantine__jar">
            <template v-if="entry.cooling">冷却中，约 {{ entry.remainMin }} 分钟后自动放行</template>
            <template v-else>隔离 7 天</template>
            <template v-if="entry.jarHint"> · jar {{ entry.jarHint }}</template>
          </span>
        </div>
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          :disabled="busy !== null"
          @click="release(entry.raw)"
        >
          {{ busy === entry.raw ? '处理中…' : entry.cooling ? '立即放行' : '解除隔离' }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.quarantine {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.quarantine__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.quarantine__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.quarantine__note {
  font: var(--text-caption);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.quarantine__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.quarantine__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-base);
}

.quarantine__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.quarantine__api {
  font: var(--text-label);
  color: var(--color-text-primary);
  word-break: break-all;
}

.quarantine__jar {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
