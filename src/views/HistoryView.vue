<script setup lang="ts">
/**
 * 观看历史（页面蓝图 §8）
 *
 * 今天 / 昨天 / 更早 分组（sticky）；行内 ⋯ 操作；清空需二次确认。
 * 纯本地数据：不显示离线横幅。源已移除时行内提示且不可播放（AC-35）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { HistoryRecord } from '@/types';
import { historyGroupOf } from '@/shared/time';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import HistoryListItem from '@/components/media/HistoryListItem.vue';
import { useHistoryStore } from '@/stores/historyStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useToast } from '@/composables/useToast';
import { beginSharedCover } from '@/composables/useSharedElement';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const history = useHistoryStore();
const sources = useSourceStore();
const toast = useToast();
const ui = useUiStore();

const menuRecord = ref<HistoryRecord | null>(null);
const menuOpen = ref(false);

const loading = computed(() => history.state === 'idle' || history.state === 'loading');
const isEmpty = computed(() => history.state === 'empty' || history.items.length === 0);

const groups = computed(() => {
  const sorted = [...history.items].sort((a, b) => b.updatedAt - a.updatedAt);
  const buckets: Record<'今天' | '昨天' | '更早', HistoryRecord[]> = { 今天: [], 昨天: [], 更早: [] };
  for (const rec of sorted) {
    buckets[historyGroupOf(rec.updatedAt)].push(rec);
  }
  return (['今天', '昨天', '更早'] as const)
    .map((label) => ({ label, items: buckets[label] }))
    .filter((g) => g.items.length > 0);
});

onMounted(async () => {
  await Promise.all([sources.load(), history.load()]);
});

function isSourceRemoved(rec: HistoryRecord): boolean {
  return !sources.sources.some((s) => s.id === rec.sourceId);
}

function play(rec: HistoryRecord, origin?: HTMLElement): void {
  if (isSourceRemoved(rec)) {
    toast.error('无法播放，源已移除');
    return;
  }
  beginSharedCover(origin);
  void router.push({
    name: 'player',
    params: { mediaId: rec.mediaId, ...(rec.episodeId ? { episodeId: rec.episodeId } : {}) },
  });
}

function openMenu(rec: HistoryRecord): void {
  menuRecord.value = rec;
  menuOpen.value = true;
}

async function removeOne(): Promise<void> {
  const rec = menuRecord.value;
  if (!rec) return;
  menuOpen.value = false;
  try {
    await history.remove(rec.id);
    toast.success('已删除该条记录');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function viewDetail(): void {
  const rec = menuRecord.value;
  menuOpen.value = false;
  if (!rec) return;
  void router.push({ name: 'detail', params: { mediaId: rec.mediaId }, query: { sourceId: rec.sourceId } });
}

function download(): void {
  const rec = menuRecord.value;
  menuOpen.value = false;
  if (!rec) return;
  void router.push({ name: 'detail', params: { mediaId: rec.mediaId }, query: { sourceId: rec.sourceId } });
  toast.info('请在详情页选择要下载的集数');
}

async function clearAll(): Promise<void> {
  const ok = await ui.confirm({
    title: '清空观看历史？',
    message: '清空后不可恢复，收藏与下载不受影响。',
    confirmText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    await history.clear();
    toast.success('已清空观看历史');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function goBack(): void {
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/');
}

function goLibrary(): void {
  void router.push('/library');
}

function goReport(): void {
  void router.push('/report');
}

async function retry(): Promise<void> {
  await history.load();
}
</script>

<template>
  <main class="history-page" data-route="history">
    <AppHeader title="观看历史" back>
      <template #actions>
        <button
          class="history-report"
          type="button"
          :disabled="history.items.length === 0"
          @click="goReport"
        >
          报告
        </button>
        <button
          class="history-clear"
          type="button"
          :disabled="history.items.length === 0"
          @click="clearAll"
        >
          清空
        </button>
      </template>
    </AppHeader>

    <div class="history-body" data-scroll="page">
      <div v-if="loading" class="history-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在读取历史…</span>
      </div>

      <ErrorState
        v-else-if="history.error"
        :error="history.error"
        back-text="返回"
        @retry="retry"
        @back="goBack"
      />

      <EmptyState
        v-else-if="isEmpty"
        variant="history"
        title="还没有观看记录"
        description="看过的内容会出现在这里"
        action-text="去媒体库"
        @action="goLibrary"
      />

      <template v-else>
        <section v-for="group in groups" :key="group.label" class="history-group">
          <h2 class="history-group__title">{{ group.label }}</h2>
          <ul>
            <li v-for="rec in group.items" :key="rec.id">
              <HistoryListItem
                :record="rec"
                :source-removed="isSourceRemoved(rec)"
                @select="play"
                @menu="openMenu"
              />
            </li>
          </ul>
        </section>
      </template>
    </div>

    <BottomSheet v-model="menuOpen" :title="menuRecord?.title ?? '操作'">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="download">下载</button></li>
        <li><button class="sheet-list__item" type="button" @click="viewDetail">查看详情</button></li>
        <li>
          <button class="sheet-list__item sheet-list__item--danger" type="button" @click="removeOne">
            删除这条记录
          </button>
        </li>
      </ul>
    </BottomSheet>
  </main>
</template>

<style scoped>
.history-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.history-clear {
  min-width: 44px;
  height: 44px;
  padding: 0 var(--space-2);
  font: var(--text-label);
  color: var(--color-brand-text);
}

.history-report {
  min-width: 44px;
  height: 44px;
  padding: 0 var(--space-2);
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.history-report:disabled {
  color: var(--color-text-disabled);
}

.history-clear:disabled {
  color: var(--color-text-disabled);
}

.history-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.history-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.history-group + .history-group {
  margin-top: var(--space-4);
}

.history-group__title {
  position: sticky;
  top: var(--layout-header-height);
  z-index: 2;
  padding: var(--space-2) 0;
  background-color: var(--color-bg-base);
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.sheet-list__item--danger {
  color: var(--color-danger);
}
</style>
