<script setup lang="ts">
/**
 * 订阅管理（CHG-12）
 *
 * 按 `Source.subscriptionId`（订阅来源标识：URL / 文件名，CHG-11 口径）聚合展示
 * 已导入的订阅：贡献源数、启用/失效概览、最近导入时间（`ImportRecord`）。
 * 操作：刷新（仅覆盖已有源，jar 判死不覆盖）/ 删除该订阅全部源 / 跳批量评测。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { Source } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { importService, listImportRecords, type ImportRecord } from '@/services/importService';
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
const loading = ref(true);
const error = ref<string | null>(null);
const refreshingId = ref<string | null>(null);
const removingId = ref<string | null>(null);

interface SubscriptionRow {
  id: string;
  sourceCount: number;
  enabledCount: number;
  unhealthyCount: number;
  importedAt: number | null;
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
      refreshable: /^https?:\/\//i.test(id),
    }))
    .sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0));
});

onMounted(async () => {
  try {
    records.value = await listImportRecords();
    await sources.load();
  } catch (e) {
    error.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
});

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
    const { updated, newCount, jarDead } = await importService.refreshSubscription(row.id);
    const parts = [`覆盖 ${updated} 个源`];
    if (newCount > 0) parts.push(`新增 ${newCount} 条未导入`);
    if (jarDead > 0) parts.push(`${jarDead} 个 jar 已失效未覆盖`);
    toast.success(`「${row.id}」已刷新：${parts.join('，')}`);
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
              <template v-if="row.importedAt"> · {{ formatRelativeTime(row.importedAt) }}</template>
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

.subs-row__actions {
  flex: 0 0 auto;
  display: flex;
  gap: var(--space-2);
}

.subs-row__remove {
  color: var(--color-danger);
}
</style>
