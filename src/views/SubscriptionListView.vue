<script setup lang="ts">
/**
 * 订阅管理（CHG-12）
 *
 * 按 `Source.subscriptionId`（订阅来源标识：URL / 文件名，CHG-11 口径）聚合展示
 * 已导入的订阅：贡献源数、启用/失效概览、最近导入时间（`ImportRecord`）。
 * 操作：刷新（仅覆盖已有源，jar 判死不覆盖）/ 删除该订阅全部源 / 跳批量评测。
 *
 * P2-1：每行显示刷新台账（最近尝试 / 最近成功 / 失败或部分成功原因 / 退避剩余），
 * 手动与自动刷新共用 `refreshTracked`，所以这里看到的口径与后台链路完全一致。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { Source } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { listImportRecords, type ImportRecord } from '@/services/importService';
import {
  describeRefreshOutcome,
  listRefreshOutcomes,
  refreshSummaryText,
  refreshTracked,
  type SubscriptionRefreshOutcome,
} from '@/services/subscriptionLifecycleService';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';
import { formatRelativeTime } from '@/shared/time';

const router = useRouter();
const sources = useSourceStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const records = ref<ImportRecord[]>([]);
/** P2-1：逐订阅刷新台账（自动与手动共用，所以这里显示的就是后台真实的尝试结果） */
const outcomes = ref<Record<string, SubscriptionRefreshOutcome>>({});
const loading = ref(true);
const error = ref<string | null>(null);
const refreshingId = ref<string | null>(null);
const removingId = ref<string | null>(null);
/* v1.7/CHG-19 */
const refreshingAll = computed(() => sources.refreshingSubscriptions);

interface SubscriptionRow {
  id: string;
  sourceCount: number;
  enabledCount: number;
  unhealthyCount: number;
  importedAt: number | null;
  outcome: SubscriptionRefreshOutcome | null;
  /** 是否可刷新（URL 形态；文件导入的订阅无法重新拉取） */
  refreshable: boolean;
}

const rows = computed<SubscriptionRow[]>(() => {
  const groups = new Map<string, Source[]>();
  for (const source of sources.sources) {
    if (!source.subscriptionId || source.type === 'demo') continue;
    const list = groups.get(source.subscriptionId) ?? [];
    list.push(source);
    groups.set(source.subscriptionId, list);
  }
  const recordAt = new Map(records.value.map((r) => [r.url, r.importedAt] as const));
  return [...groups.entries()]
    .map(([id, list]) => ({
      id,
      sourceCount: list.length,
      enabledCount: list.filter((s) => s.enabled).length,
      unhealthyCount: list.filter(
        (s) => s.healthCheckedAt !== null && s.health !== 'ok' && s.health !== 'unknown',
      ).length,
      importedAt: recordAt.get(id) ?? list.reduce((acc, s) => Math.max(acc, s.createdAt), 0),
      outcome: outcomes.value[id] ?? null,
      refreshable: /^https?:\/\//i.test(id),
    }))
    .sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0));
});

/**
 * 台账一行话（P2-1）。
 *
 * 文案与语气都由 `describeRefreshOutcome` 生成：界面只负责渲染，
 * 重启后再进这一页看到的还是同一句，不会出现两套口径。
 */
function refreshNote(row: SubscriptionRow) {
  return row.outcome ? describeRefreshOutcome(row.outcome) : null;
}

onMounted(async () => {
  try {
    const [rs, oc] = await Promise.all([listImportRecords(), listRefreshOutcomes()]);
    records.value = rs;
    outcomes.value = oc;
    await sources.load();
    void sources.loadSummaries();
  } catch (e) {
    error.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
});

/* ---------- v1.7/CHG-19：全部刷新与自动禁用恢复 ---------- */

/** 一键刷新全部订阅（TTL 内或失败退避中的直接跳过，跳过数单独披露） */
async function refreshAll(): Promise<void> {
  if (isOffline.value) {
    toast.info('当前离线，无法刷新订阅');
    return;
  }
  const summary = refreshSummaryText(await sources.refreshAllSubscriptions());
  outcomes.value = await listRefreshOutcomes();
  toast[summary.tone](summary.text);
}

/** 恢复被自动禁用的源 */
async function restoreSource(sourceId: string): Promise<void> {
  await sources.restoreAutoDisabled(sourceId);
  toast.success('已恢复该源并重新启用');
}

/** 被自动禁用的源（摘要卡下方逐个恢复） */
const autoDisabledSources = computed(() => sources.sources.filter((s) => s.autoDisabledAt));

/** 刷新订阅：重新拉取解析（含 jar 预检），仅覆盖已有源；新增不导入 */
async function refresh(row: SubscriptionRow): Promise<void> {
  if (!row.refreshable) {
    toast.info('文件导入的订阅无法刷新，请重新导入文件');
    return;
  }
  if (isOffline.value) {
    toast.info('当前离线，无法刷新订阅');
    return;
  }
  refreshingId.value = row.id;
  try {
    // 走与后台自动刷新同一个入口：手动刷新的结果同样进台账，退避状态也因此清零
    const { ok, reason, outcome, counts } = await refreshTracked(row.id);
    outcomes.value = { ...outcomes.value, [row.id]: outcome };
    if (!ok) {
      toast.error(`「${row.id}」刷新失败：${reason ?? '未知原因'}`);
      return;
    }
    const parts = [`覆盖 ${counts?.updated ?? 0} 个源`];
    if (counts && counts.newCount > 0) parts.push(`新增 ${counts.newCount} 条未导入`);
    if (counts && counts.jarDead > 0) parts.push(`${counts.jarDead} 个 jar 已失效未覆盖`);
    if (counts && counts.livesFailed > 0) parts.push(`${counts.livesFailed} 个直播源同步失败`);
    const text = `「${row.id}」已刷新：${parts.join('，')}`;
    // 直播源没同步上就不算「全绿」：用 info 说完成绩，也把缺口留在屏幕上
    if (counts && counts.livesFailed > 0) toast.info(text);
    else toast.success(text);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    refreshingId.value = null;
  }
}

/** 删除该订阅的全部源（确认后批量执行） */
async function removeSubscription(row: SubscriptionRow): Promise<void> {
  const ok = await ui.confirm({
    title: '删除该订阅的全部源？',
    message: `将删除「${row.id}」贡献的 ${row.sourceCount} 个源（含已禁用的）。已下载的文件不受影响，可在下载页单独清理。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  removingId.value = row.id;
  try {
    const removed = await sources.removeBySubscription(row.id);
    toast.success(`已删除 ${removed} 个源`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    removingId.value = null;
  }
}

function goEval(): void {
  void router.push('/settings/subscriptions/eval');
}

/** v1.7/CHG-19：订阅健康摘要查询（loadSummaries 填充） */
function summaryOf(subscriptionId: string) {
  return sources.subscriptionSummaries.find((s) => s.subscriptionId === subscriptionId) ?? null;
}

async function retry(): Promise<void> {
  error.value = null;
  loading.value = true;
  try {
    records.value = await listImportRecords();
    await sources.load();
  } catch (e) {
    error.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="subs-page" data-route="subscriptions">
    <AppHeader title="订阅管理" back>
      <template #actions>
        <button class="subs-eval" type="button" aria-label="批量订阅评测" @click="goEval">
          批量评测
        </button>
      </template>
    </AppHeader>

    <div class="subs-body">
      <button
        class="btn btn--secondary btn--md subs-refresh-all"
        type="button"
        :disabled="refreshingAll || isOffline || rows.length === 0"
        @click="refreshAll"
      >
        <LoadingSpinner v-if="refreshingAll" :size="14" />
        {{ refreshingAll ? '正在刷新全部订阅…' : '全部刷新（24h 内自动跳过）' }}
      </button>

      <div v-if="loading" class="subs-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在读取订阅…</span>
      </div>

      <ErrorState
        v-else-if="error"
        :error="{ code: 'E_DB', message: error, detail: null, retryable: true, httpStatus: null }"
        @retry="retry"
      />

      <EmptyState
        v-else-if="rows.length === 0"
        variant="source"
        title="还没有按订阅导入的源"
        description="从订阅链接导入的源会按订阅归组显示在这里；手工新增的源不在此列。"
      />

      <ul v-else class="subs-list">
        <li v-for="row in rows" :key="row.id" class="subs-row">
          <div class="subs-row__main">
            <p class="subs-row__id truncate-1">{{ row.id }}</p>
            <p class="subs-row__meta">
              {{ row.sourceCount }} 个源 · 启用 {{ row.enabledCount }}
              <template v-if="row.unhealthyCount > 0"> · 失效 {{ row.unhealthyCount }}</template>
              <template v-if="summaryOf(row.id)?.jarDead"> · jar 死 {{ summaryOf(row.id)?.jarDead }}</template>
              <template v-if="row.importedAt"> · {{ formatRelativeTime(row.importedAt) }}</template>
            </p>
            <p
              v-if="refreshNote(row)"
              class="subs-row__outcome"
              :class="`subs-row__outcome--${refreshNote(row)?.tone}`"
            >
              {{ refreshNote(row)?.text }}
            </p>
          </div>
          <div class="subs-row__actions">
            <button
              class="btn btn--secondary btn--sm"
              type="button"
              :disabled="refreshingId === row.id || !row.refreshable"
              :title="row.refreshable ? '重新拉取并覆盖已有源' : '文件导入的订阅不可刷新'"
              @click="refresh(row)"
            >
              <LoadingSpinner v-if="refreshingId === row.id" :size="14" />
              {{ refreshingId === row.id ? '刷新中' : '刷新' }}
            </button>
            <button
              class="btn btn--secondary btn--sm subs-row__remove"
              type="button"
              :disabled="removingId === row.id"
              @click="removeSubscription(row)"
            >
              <LoadingSpinner v-if="removingId === row.id" :size="14" />
              删除
            </button>
          </div>
        </li>
      </ul>

      <!-- v1.7/CHG-19：被自动禁用的源（一键恢复） -->
      <section v-if="autoDisabledSources.length > 0" class="subs-disabled">
        <h2 class="field__label">已自动禁用（连续体检失败）</h2>
        <ul class="subs-disabled__list">
          <li v-for="source in autoDisabledSources" :key="source.id" class="subs-disabled__row">
            <span class="truncate-1">{{ source.name }}</span>
            <button class="btn btn--secondary btn--sm" type="button" @click="restoreSource(source.id)">
              恢复
            </button>
          </li>
        </ul>
      </section>
    </div>
  </main>
</template>

<style scoped>
.subs-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-base);
}

.subs-body {
  flex: 1 1 auto;
  padding: var(--space-3) var(--space-4) calc(var(--space-6) + var(--safe-bottom));
}

.subs-eval {
  height: 36px;
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.subs-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) 0;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.subs-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.subs-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.subs-row__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.subs-row__id {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.subs-row__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

/* P2-1：刷新台账（成功/部分成功/失败三档，失败才用强调色） */
.subs-row__outcome {
  margin-top: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.subs-row__outcome--ok {
  color: var(--color-success);
}

.subs-row__outcome--warn {
  color: var(--color-warning);
}

.subs-row__outcome--bad {
  color: var(--color-danger);
}

.subs-row__actions {
  flex: 0 0 auto;
  display: flex;
  gap: var(--space-2);
}

.subs-row__remove {
  color: var(--color-danger);
}

/* v1.7/CHG-19 */
.subs-refresh-all {
  margin-bottom: var(--space-3);
}

.subs-disabled {
  margin-top: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.subs-disabled__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
}

.subs-disabled__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  font: var(--text-caption);
  color: var(--color-text-secondary);
}
</style>
