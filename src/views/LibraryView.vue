<script setup lang="ts">
/**
 * 媒体库海报墙（页面蓝图 §3）
 *
 * 分类 Tab + 工具行（源选择 / 筛选 / 刷新）+ 2:3 海报网格 + 无限滚动。
 * 四态：loading 骨架（Tab/工具行保持真实渲染）/ empty（三种原因分别给行动）/
 * error（已有数据保留）/ offline（缓存 + hasMore=false）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { LibraryFilters, MediaItem } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadMoreFooter from '@/components/common/LoadMoreFooter.vue';
import PosterGrid from '@/components/media/PosterGrid.vue';
import CategoryTabs from '@/components/media/CategoryTabs.vue';
import FilterSheet from '@/components/media/FilterSheet.vue';
import IconRefresh from '@/components/icons/IconRefresh.vue';
import IconChevron from '@/components/icons/IconChevron.vue';
import IconClose from '@/components/icons/IconClose.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useInfiniteScroll } from '@/composables/useInfiniteScroll';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const route = useRoute();
const library = useLibraryStore();
const sources = useSourceStore();
const downloads = useDownloadStore();
const favorites = useFavoriteStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const filterOpen = ref(false);
const sourceOpen = ref(false);
const quickSheetOpen = ref(false);
const quickItem = ref<MediaItem | null>(null);
const refreshing = ref(false);

const filters = computed<LibraryFilters>(() => library.filters);
const activeFilterCount = computed(() => {
  let n = 0;
  if (filters.value.type) n += 1;
  if (filters.value.area) n += 1;
  if (filters.value.yearFrom !== null || filters.value.yearTo !== null) n += 1;
  if (filters.value.ext) n += Object.keys(filters.value.ext).length;
  return n;
});

/** 当前分类的服务端筛选维度（无配置 → null，FilterSheet 回退本地模式） */
const currentDimensions = computed(() => {
  if (!library.currentCategoryId) return null;
  return library.categories.find((c) => c.id === library.currentCategoryId)?.filters ?? null;
});

/** 地区候选：源缓存推导优先，并并入当前页新出现的地区 */
const areas = computed(() => {
  const set = new Set<string>(library.areaOptions);
  for (const item of library.items) if (item.area) set.add(item.area);
  return [...set];
});

const TYPE_LABELS: Record<string, string> = {
  movie: '电影',
  series: '剧集',
  anime: '动漫',
  variety: '综艺',
  other: '其它',
};

/** 已选条件 chips：点击 × 即时清除该维度并重新加载 */
const activeChips = computed(() => {
  const chips: Array<{ label: string; remove: () => void }> = [];
  const f = filters.value;
  if (f.type) {
    chips.push({ label: `类型：${TYPE_LABELS[f.type] ?? f.type}`, remove: () => removeFilter({ type: null }) });
  }
  if (f.yearFrom !== null || f.yearTo !== null) {
    const label =
      f.yearFrom !== null && f.yearTo !== null
        ? `${f.yearFrom}–${f.yearTo}`
        : f.yearFrom !== null
          ? `${f.yearFrom} 年后`
          : `${f.yearTo} 年前`;
    chips.push({ label: `年代：${label}`, remove: () => removeFilter({ yearFrom: null, yearTo: null }) });
  }
  if (f.area) {
    chips.push({ label: `地区：${f.area}`, remove: () => removeFilter({ area: null }) });
  }
  if (f.ext) {
    for (const [key, value] of Object.entries(f.ext)) {
      const dim = currentDimensions.value?.find((d) => d.key === key);
      const optLabel = dim?.options.find((o) => o.value === value)?.label ?? value;
      chips.push({
        label: `${dim?.name ?? key}：${optLabel}`,
        remove: () => {
          const ext = { ...f.ext };
          delete ext[key];
          removeFilter({ ext: Object.keys(ext).length > 0 ? ext : null });
        },
      });
    }
  }
  return chips;
});

async function removeFilter(patch: Partial<LibraryFilters>): Promise<void> {
  try {
    await library.setFilters(patch);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

const downloadedIds = computed(() =>
  downloads.tasks.filter((t) => t.status === 'completed').map((t) => t.mediaId),
);

const noEnabledSources = computed(() => sources.enabledSources.length === 0);
const emptyReason = computed<'no-source' | 'filtered' | 'category'>(() => {
  if (noEnabledSources.value) return 'no-source';
  if (activeFilterCount.value > 0) return 'filtered';
  return 'category';
});

const showSkeleton = computed(
  () => library.state === 'loading' && library.items.length === 0,
);
const showError = computed(() => library.state === 'error' && library.items.length === 0);
/**
 * 离线且无缓存（AC-92）：应展示空态「离线且无本地缓存」，而不是错误态「网络不可用 + 重试」。
 * 文案与 `StateView` 的 offline 分支保持一致。
 */
const showOfflineEmpty = computed(
  () => library.state === 'offline' && library.items.length === 0 && !showSkeleton.value,
);
const showEmpty = computed(
  () => library.state === 'empty' && !showSkeleton.value && !showError.value,
);
const stateText = computed(() => {
  if (isOffline.value) return '离线，仅显示缓存内容';
  return '没有更多了';
});

/**
 * 错误态补充说明（AC-110 / 17.6.4）：自动切换只会发生一次；
 * 停在错误态时明确告诉用户还有其它源可用，把决定权交回用户。
 */
const errorHint = computed(() => {
  if (library.error?.code === 'E_SOURCE_DISABLED') {
    return '可能原因：该源已被禁用。请在源管理中启用，或切换其他源。';
  }
  const alternatives = sources.enabledSources.filter(
    (source) => source.id !== sources.currentSourceId && source.health === 'ok',
  );
  if (alternatives.length > 0) {
    return `可能原因：该线路已失效。可手动切换其他源（当前有 ${alternatives.length} 条可用线路）。`;
  }
  return '可能原因：该线路已失效，且没有其他可用线路。请到源管理检查或新增源。';
});

const { sentinelRef } = useInfiniteScroll({
  hasMore: () => library.hasMore && !isOffline.value,
  loading: () => library.state === 'refreshing',
  onLoadMore: async () => {
    try {
      await library.loadNextPage();
      if (library.state === 'error') toast.error(library.error?.message ?? '加载失败');
    } catch (e) {
      toast.error(toErrorShape(e).message);
    }
  },
});

onMounted(async () => {
  const sourceId = typeof route.query.sourceId === 'string' ? route.query.sourceId : null;
  try {
    await sources.load();
    await library.openSource(sourceId ?? sources.currentSource?.id ?? null);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
});

// 路由返回时保留筛选（会话级）；只处理 query 变化
watch(
  () => route.query.sourceId,
  (next) => {
    if (typeof next === 'string' && next !== sources.currentSourceId) {
      void library.openSource(next);
    }
  },
);

async function changeCategory(id: string | null): Promise<void> {
  try {
    await library.setCategory(id);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function applyFilters(next: LibraryFilters): Promise<void> {
  try {
    await library.setFilters(next);
    filterOpen.value = false;
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function resetFilters(): Promise<void> {
  await library.resetFilters();
  filterOpen.value = false;
}

async function chooseSource(sourceId: string | null): Promise<void> {
  sourceOpen.value = false;
  await library.openSource(sourceId);
  if (library.state === 'error') toast.error(library.error?.message ?? '加载失败');
}

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await library.loadFirstPage(true);
    if (library.state === 'error') toast.error(library.error?.message ?? '刷新失败');
  } finally {
    refreshing.value = false;
  }
}

function openDetail(item: MediaItem): void {
  void router.push({ name: 'detail', params: { mediaId: item.id }, query: { sourceId: item.sourceId } });
}

function openLongPress(item: MediaItem): void {
  quickItem.value = item;
  quickSheetOpen.value = true;
}

async function quickFavorite(): Promise<void> {
  const item = quickItem.value;
  if (!item) return;
  const added = await favorites.toggle({
    sourceId: item.sourceId,
    mediaId: item.id,
    title: item.title,
    posterUrl: item.posterUrl,
    type: item.type,
    year: item.year,
  });
  toast.success(added ? '已收藏' : '已取消收藏');
  quickSheetOpen.value = false;
}

function quickDownload(): void {
  const item = quickItem.value;
  if (!item) {
    return;
  }
  quickSheetOpen.value = false;
  void router.push({ name: 'detail', params: { mediaId: item.id }, query: { sourceId: item.sourceId } });
  toast.info('请在详情页选择需要下载的集数');
}

function quickDetail(): void {
  const item = quickItem.value;
  quickSheetOpen.value = false;
  if (item) openDetail(item);
}

function goSources(): void {
  void router.push('/settings/sources');
}

function openSearch(): void {
  void router.push('/search');
}

function openSettings(): void {
  void router.push('/settings');
}
</script>

<template>
  <SafeArea tabbar data-route="library">
    <AppHeader title="媒体库" :settings="true" :search="true" @search="openSearch" @settings="openSettings" />

    <OfflineBanner v-if="isOffline" />

    <div class="library-toolbar-wrap">
      <CategoryTabs
        :categories="library.categories"
        :model-value="library.currentCategoryId"
        @update:model-value="changeCategory"
      />

      <div class="library-toolbar">
        <button class="library-toolbar__btn" type="button" @click="sourceOpen = true">
          <span class="library-toolbar__label">源</span>
          <span class="library-toolbar__value truncate-1">
            {{ sources.currentSource?.name ?? '未选择' }}
          </span>
          <IconChevron :size="14" direction="down" />
        </button>

        <button class="library-toolbar__btn" type="button" @click="filterOpen = true">
          <span class="library-toolbar__label">筛选{{ activeFilterCount > 0 ? `（${activeFilterCount}）` : '' }}</span>
          <IconChevron :size="14" direction="down" />
        </button>

        <button
          class="library-toolbar__icon"
          type="button"
          aria-label="刷新"
          :disabled="refreshing"
          @click="refresh"
        >
          <IconRefresh :size="18" />
        </button>
      </div>
    </div>

    <!-- 已选条件：点 × 即时清除（不必进筛选弹层） -->
    <div v-if="activeChips.length > 0" class="library-active-filters" role="list">
      <button
        v-for="chip in activeChips"
        :key="chip.label"
        class="library-active-filters__chip"
        type="button"
        role="listitem"
        :aria-label="`清除筛选 ${chip.label}`"
        @click="chip.remove"
      >
        <span class="truncate-1">{{ chip.label }}</span>
        <IconClose :size="12" />
      </button>
    </div>

    <div class="library-body">
      <!-- loading -->
      <template v-if="showSkeleton">
        <PosterGrid :items="[]" loading :skeleton-count="6" />
      </template>

      <!-- 离线且无缓存（AC-92）：空态而非错误态 -->
      <EmptyState
        v-else-if="showOfflineEmpty"
        variant="box"
        title="离线且无本地缓存"
        description="当前没有网络，本地也没有缓存内容；连接网络后刷新即可加载。"
        action-text="连接网络后刷新"
        @action="refresh"
      />

      <!-- error（无缓存） -->
      <ErrorState
        v-else-if="showError"
        :error="library.error"
        :hint="errorHint"
        back-text="返回首页"
        @retry="refresh"
        @back="router.replace('/')"
      >
        <template #extra>
          <button class="btn btn--secondary btn--md" type="button" @click="sourceOpen = true">
            切换其他源
          </button>
        </template>
      </ErrorState>

      <!-- empty：三种原因 -->
      <template v-else-if="showEmpty">
        <EmptyState
          v-if="emptyReason === 'no-source'"
          variant="source"
          title="没有启用的源"
          description="去源管理启用一个源，或新增你自己的源"
          action-text="去启用"
          @action="goSources"
        />
        <EmptyState
          v-else-if="emptyReason === 'filtered'"
          variant="search"
          title="没有符合条件的内容"
          description="试试放宽筛选条件，或清除筛选后刷新"
          action-text="清除筛选"
          @action="resetFilters"
        />
        <EmptyState
          v-else
          variant="box"
          title="该分类暂无内容"
          description="换个分类或刷新试试"
          action-text="刷新"
          @action="refresh"
        />
      </template>

      <!-- success -->
      <template v-else>
        <div v-if="library.state === 'error' || library.error" class="library-inline-error" role="alert">
          <span>{{ library.error?.message ?? '刷新失败，以下为上次加载的内容' }}</span>
          <button class="btn btn--secondary btn--sm" type="button" @click="refresh">重试</button>
        </div>

        <PosterGrid
          :items="library.items"
          :downloaded-ids="downloadedIds"
          @select="openDetail"
          @longpress="openLongPress"
        />

        <div ref="sentinelRef" class="library-sentinel" aria-hidden="true" />

        <LoadMoreFooter
          :loading="library.state === 'refreshing'"
          :has-more="library.hasMore && !isOffline"
          :failed="library.state === 'error' && library.items.length > 0"
          :no-more-text="stateText"
          @load-more="library.loadNextPage()"
        />
      </template>
    </div>

    <!-- 源选择 -->
    <BottomSheet v-model="sourceOpen" title="选择源">
      <ul class="sheet-list">
        <li>
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': sources.currentSourceId === null }"
            type="button"
            @click="chooseSource(null)"
          >
            全部已启用源
          </button>
        </li>
        <li v-for="source in sources.sources" :key="source.id">
          <button
            class="sheet-list__item"
            :class="{
              'sheet-list__item--active': sources.currentSourceId === source.id,
              'sheet-list__item--disabled': !source.enabled,
            }"
            type="button"
            :disabled="!source.enabled"
            @click="chooseSource(source.id)"
          >
            <span class="truncate-1">{{ source.name }}</span>
            <span v-if="!source.enabled" class="sheet-list__hint">已禁用</span>
          </button>
        </li>
      </ul>
      <p v-if="sources.sources.length === 0" class="sheet-empty">还没有配置任何源</p>
    </BottomSheet>

    <!-- 筛选 -->
    <FilterSheet
      v-model="filterOpen"
      :filters="filters"
      :dimensions="currentDimensions"
      :areas="areas"
      @apply="applyFilters"
      @reset="resetFilters"
    />

    <!-- 长按快捷 -->
    <BottomSheet v-model="quickSheetOpen" :title="quickItem?.title ?? '操作'">
      <ul class="sheet-list">
        <li>
          <button class="sheet-list__item" type="button" @click="quickFavorite">
            {{ quickItem && favorites.isFavorite(quickItem.sourceId, quickItem.id) ? '取消收藏' : '收藏' }}
          </button>
        </li>
        <li>
          <button class="sheet-list__item" type="button" @click="quickDownload">下载</button>
        </li>
        <li>
          <button class="sheet-list__item" type="button" @click="quickDetail">查看详情</button>
        </li>
      </ul>
    </BottomSheet>
  </SafeArea>
</template>

<style scoped>
.library-toolbar-wrap {
  flex: 0 0 auto;
  border-bottom: var(--border-default);
}

.library-active-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--layout-page-padding-x) 0;
}

.library-active-filters__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  min-height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-brand-soft);
  border: 1px solid var(--color-brand);
  color: var(--color-brand-text);
  font: var(--text-caption);
}

.library-active-filters__chip span {
  min-width: 0;
}

.library-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--layout-page-padding-x) 0;
}

.library-toolbar__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 46%;
  height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-caption);
  font-family: var(--font-family-base);
  font-size: var(--font-size-14);
}

.library-toolbar__label {
  color: var(--color-text-tertiary);
}

.library-toolbar__value {
  min-width: 0;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
}

.library-toolbar__icon {
  margin-left: auto;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
}

.library-toolbar__icon:active {
  background-color: var(--color-overlay-press-strong);
}

.library-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) var(--space-4);
}

.library-inline-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  font: var(--text-caption);
  color: var(--color-text-primary);
}

.library-inline-error span {
  flex: 1 1 auto;
  min-width: 0;
}

.library-sentinel {
  height: 1px;
}

.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.sheet-list__item--active {
  color: var(--color-brand-text);
}

.sheet-list__item--disabled {
  color: var(--color-text-disabled);
}

.sheet-list__hint {
  margin-left: auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.sheet-empty {
  padding: var(--space-5) 0;
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
