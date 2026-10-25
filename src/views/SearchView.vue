<script setup lang="ts">
/**
 * 搜索（页面蓝图 §4）
 *
 * - 输入防抖 300ms；关键词为空显示历史
 * - 结果按「本地 → 远程」分段；本地结果先出（mock 下二者同源）
 * - 部分源失败：结果正常展示 + 底部黄字可点开明细
 * - 离线：只搜本地缓存并提示
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { MediaItem, SearchScope } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import SearchBar from '@/components/common/SearchBar.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import PosterImage from '@/components/common/PosterImage.vue';
import IconClose from '@/components/icons/IconClose.vue';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useDebounce } from '@/composables/useDebounce';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useUiStore } from '@/stores/uiStore';
import { useToast } from '@/composables/useToast';
import { mediaSubtitle } from '@/components/common/format';
import { toErrorShape } from '@/shared/errors';

defineOptions({ name: 'SearchView' });

const router = useRouter();
const route = useRoute();
const library = useLibraryStore();
const settings = useSettingsStore();
const sources = useSourceStore();
const ui = useUiStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

// CHG-28：URL 带 q 用 q（入口搜索），否则回退 store 里上次搜索的关键词——
// 从详情返回重建时（无 KeepAlive 命中的场景，如进程被杀后恢复）不丢搜索状态
const queryKeyword = typeof route.query.q === 'string' && route.query.q.trim().length > 0 ? route.query.q : '';
const keyword = ref(queryKeyword || library.searchKeyword);
const failedDetailOpen = ref(false);
const searchBarRef = ref<{ focus: () => void } | null>(null);

const history = computed(() => settings.settings?.searchHistory ?? []);
const isSearching = computed(() => library.searchState === 'loading');
const hasResults = computed(() => library.searchResults.length > 0);
const showInitial = computed(() => keyword.value.trim().length === 0);
const showEmpty = computed(
  () => !showInitial.value && library.searchState === 'empty' && !isSearching.value,
);
/** CHG-15：0 个源实际参与搜索（启用源全被体检结论/类型支持性过滤）→ 结果不可信，给诊断 */
const zeroCandidates = computed(
  () => showEmpty.value && library.searchCandidates === 0 && library.searchFilteredOut > 0,
);
const emptyDescription = computed(() =>
  zeroCandidates.value
    ? `${library.searchFilteredOut} 个启用源因体检失效或类型不支持被跳过，可强制重试或检查源`
    : '换个关键词，或检查源是否启用',
);
const showError = computed(
  () =>
    !showInitial.value &&
    library.searchState === 'error' &&
    library.searchResults.length === 0,
);

const debouncedSearch = useDebounce((value: string) => {
  void runSearch(value, false);
}, 300);

watch(keyword, (value) => {
  if (value.trim().length === 0) {
    library.clearSearch();
    return;
  }
  debouncedSearch(value);
});

onMounted(async () => {
  try {
    await sources.load();
    if (!settings.settings) await settings.load();
    // CHG-28：store 已持有本次关键词的结果（进程恢复/非缓存重建）时直接复用，不重搜
    const keywordRestored = queryKeyword === '' && keyword.value.trim().length > 0;
    const hasSessionResults =
      keywordRestored && library.searchKeyword === keyword.value.trim() && library.searchResultsAll.length > 0;
    if (keyword.value.trim().length > 0 && !hasSessionResults) await runSearch(keyword.value, false);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    searchBarRef.value?.focus();
  }
});

async function runSearch(value: string, recordHistory: boolean): Promise<void> {
  const kw = value.trim();
  if (kw.length === 0) return;
  try {
    await library.search(kw);
    if (recordHistory) await pushHistory(kw);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function pushHistory(kw: string): Promise<void> {
  const current = settings.settings?.searchHistory ?? [];
  const next = [kw, ...current.filter((v) => v !== kw)].slice(0, 10);
  try {
    await settings.update({ searchHistory: next });
  } catch {
    /* 历史写入失败不影响搜索 */
  }
}

function submitSearch(value: string): void {
  debouncedSearch.cancel();
  void runSearch(value, true);
}

function chooseHistory(word: string): void {
  keyword.value = word;
  debouncedSearch.cancel();
  void runSearch(word, true);
}

async function removeHistory(word: string): Promise<void> {
  const current = settings.settings?.searchHistory ?? [];
  try {
    await settings.update({ searchHistory: current.filter((v) => v !== word) });
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function clearHistory(): Promise<void> {
  const ok = await ui.confirm({
    title: '清空搜索历史？',
    message: '清空后不可恢复。',
    confirmText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    await settings.update({ searchHistory: [] });
    toast.success('已清空搜索历史');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function openDetail(item: MediaItem): void {
  void router.push({ name: 'detail', params: { mediaId: item.id }, query: { sourceId: item.sourceId } });
}

function sourceName(sourceId: string): string {
  return sources.sources.find((s) => s.id === sourceId)?.name ?? '本地源';
}

function goBack(): void {
  // CHG-28：直接退出，不再「先清结果再退」——返回详情/上一层是用户预期，
  // 清空关键词交给输入框的清除按钮（watcher 会同步清 store）
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/');
}

function retry(): void {
  void runSearch(keyword.value, false);
}

/** CHG-15：跳过体检结论过滤重搜（用户在空态显式要求） */
async function forceSearch(): Promise<void> {
  try {
    await library.search(keyword.value, { forceAll: true });
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

/* ---------- v1.7/CHG-20：范围筛选与视图切换 ---------- */

const scopeOptions: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'site', label: '站点' },
  { value: 'spider', label: '爬虫' },
  { value: 'douban', label: '豆瓣' },
];

function applyScope(scope: SearchScope): void {
  library.setSearchScope(scope);
  if (keyword.value.trim().length > 0) void runSearch(keyword.value, false);
}

function toggleViewMode(): void {
  library.setSearchViewMode(library.searchViewMode === 'grouped' ? 'flat' : 'grouped');
}

function openSourceManage(): void {
  void router.push({ name: 'sources' });
}
</script>

<template>
  <main class="search-page" data-route="search">
    <div class="search-head">
      <AppHeader title="" back @back="goBack">
        <template #before-title />
      </AppHeader>

      <div class="search-head__bar">
        <SearchBar
          ref="searchBarRef"
          v-model="keyword"
          placeholder="搜索片名…"
          autofocus
          @search="submitSearch"
        />
      </div>
      <OfflineBanner v-if="isOffline" />
    </div>

    <div class="search-body">
      <!-- 初始：搜索历史 -->
      <template v-if="showInitial">
        <section v-if="history.length > 0" class="search-section">
          <div class="search-section__head">
            <h2 class="section-title">搜索历史</h2>
            <button class="search-section__action" type="button" @click="clearHistory">清空</button>
          </div>
          <ul class="history-list">
            <li v-for="word in history" :key="word" class="history-row">
              <button class="history-row__main" type="button" @click="chooseHistory(word)">
                <svg class="history-row__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="8.4" />
                  <path d="M12 7.6V12l3 2" />
                </svg>
                <span class="truncate-1">{{ word }}</span>
              </button>
              <button class="history-row__remove" type="button" :aria-label="`删除历史 ${word}`" @click="removeHistory(word)">
                <IconClose :size="14" />
              </button>
            </li>
          </ul>
        </section>

        <section v-else class="search-suggest">
          <p class="search-suggest__title">试试搜索片名或演员</p>
          <div class="search-suggest__chips">
            <button
              v-for="word in ['Big Buck', 'Sintel', '示例']"
              :key="word"
              class="search-suggest__chip"
              type="button"
              @click="chooseHistory(word)"
            >
              {{ word }}
            </button>
          </div>
        </section>
      </template>

      <!-- 搜索中 -->
      <div v-else-if="isSearching && !hasResults" class="search-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在搜索…</span>
      </div>

      <!-- 错误 -->
      <ErrorState
        v-else-if="showError"
        :error="library.error ?? { code: 'E_UNKNOWN', message: '搜索失败', detail: null, retryable: true, httpStatus: null }"
        back-text="返回"
        @retry="retry"
        @back="goBack"
      />

      <!-- 空结果 -->
      <template v-else-if="showEmpty">
        <EmptyState
          variant="search"
          :title="zeroCandidates ? '没有源参与搜索' : '没有找到相关内容'"
          :description="emptyDescription"
          :action-text="zeroCandidates ? '仍要搜索全部源' : '返回'"
          @action="zeroCandidates ? forceSearch() : goBack()"
        />
        <!-- CHG-15：0 源参与时给出诊断与去路；失败明细在空结果下也要可查 -->
        <button
          v-if="zeroCandidates"
          class="search-failed"
          type="button"
          @click="openSourceManage"
        >
          被跳过的源有 {{ library.searchFilteredOut }} 个，打开源管理检查
        </button>
        <button
          v-else-if="library.searchFailed.length > 0"
          class="search-failed"
          type="button"
          @click="failedDetailOpen = true"
        >
          部分源搜索失败（{{ library.searchFailed.length }}），查看明细
        </button>
      </template>

      <!-- 结果 -->
      <template v-else-if="hasResults">
        <div v-if="isOffline" class="search-offline-hint">离线，仅搜索本地缓存</div>

        <!-- v1.7/CHG-20：视图切换 + 范围筛选 + 慢源晚到提示 -->
        <div class="search-toolbar">
          <div class="search-toolbar__chips">
            <button
              v-for="scope in scopeOptions"
              :key="scope.value"
              class="search-scope-chip"
              :class="{ 'search-scope-chip--active': library.searchScope === scope.value }"
              type="button"
              @click="applyScope(scope.value)"
            >
              {{ scope.label }}
            </button>
          </div>
          <button class="search-view-toggle" type="button" @click="toggleViewMode">
            {{ library.searchViewMode === 'grouped' ? '按源平铺' : '聚合视图' }}
          </button>
        </div>

        <section class="search-section">
          <div class="search-section__head">
            <h2 class="section-title">搜索结果</h2>
            <span class="search-section__count">
              <template v-if="library.searchViewMode === 'grouped'">
                {{ library.searchGroups.length }} 部 · 来源 {{ library.searchResultsAll.length }} 条
              </template>
              <template v-else>{{ library.searchResults.length }} 条</template>
            </span>
          </div>

          <!-- 聚合视图：组卡片（同片跨源归并，点卡片进详情换源） -->
          <ul v-if="library.searchViewMode === 'grouped'" class="result-list">
            <li v-for="group in library.searchGroups" :key="group.key">
              <button class="result-row" type="button" @click="openDetail(group.items[0]!)">
                <span class="result-row__poster">
                  <PosterImage :src="group.items[0]!.posterUrl" :alt="group.title" />
                </span>
                <span class="result-row__body">
                  <span class="result-row__title clamp-2">{{ group.title }}</span>
                  <span class="result-row__meta">
                    {{ group.items.length }} 个来源 · 首选 {{ sourceName(group.items[0]!.sourceId) }}
                    <template v-if="group.year"> · {{ group.year }}</template>
                  </span>
                </span>
              </button>
            </li>
          </ul>

          <!-- 平铺视图：按相关度排序的单条列表（原视图） -->
          <ul v-else class="result-list">
            <li v-for="item in library.searchResults" :key="item.id">
              <button class="result-row" type="button" @click="openDetail(item)">
                <span class="result-row__poster">
                  <PosterImage :src="item.posterUrl" :alt="item.title" />
                </span>
                <span class="result-row__body">
                  <span class="result-row__title clamp-2">{{ item.title }}</span>
                  <span class="result-row__meta">{{ mediaSubtitle(item) }} · {{ sourceName(item.sourceId) }}</span>
                </span>
              </button>
            </li>
          </ul>
        </section>

        <!-- 慢源晚到提示：不重排已浏览内容，计数提示可点击刷新排序 -->
        <button
          v-if="library.searchLateCount > 0 && !isSearching"
          class="search-late"
          type="button"
          @click="retry"
        >
          爬虫源晚到 {{ library.searchLateCount }} 条新结果，点击重新排序
        </button>

        <div v-if="isSearching" class="search-progress" role="status">
          <LoadingSpinner :size="16" />
          <span>
            仍在搜索其它源{{
              library.searchProgress ? `（${library.searchProgress.done}/${library.searchProgress.total}）` : '…'
            }}
          </span>
        </div>

        <button
          v-if="library.searchFailed.length > 0"
          class="search-failed"
          type="button"
          @click="failedDetailOpen = true"
        >
          部分源搜索失败（{{ library.searchFailed.length }}），查看明细
        </button>
      </template>
    </div>

    <BottomSheet v-model="failedDetailOpen" title="搜索失败明细">
      <ul class="failed-list">
        <li v-for="f in library.searchFailed" :key="f.sourceId" class="failed-row">
          <span class="failed-row__source">{{ sourceName(f.sourceId) }}</span>
          <span class="failed-row__error">{{ f.error.message }}</span>
        </li>
      </ul>
      <p v-if="library.searchFailed.length === 0" class="failed-empty">没有失败的源</p>
    </BottomSheet>
  </main>
</template>

<style scoped>
.search-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.search-head {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  flex: 0 0 auto;
  background-color: var(--color-bg-base);
}

/* 顶栏与搜索框同排：用负 margin 让 SearchBar 紧贴返回按钮 */
.search-head__bar {
  display: flex;
  align-items: center;
  padding: 0 var(--layout-page-padding-x) var(--space-2);
}

.search-head :deep(.app-header) {
  padding-bottom: 0;
  min-height: 44px;
}

.search-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--layout-page-padding-x) var(--space-6);
}

.search-section + .search-section {
  margin-top: var(--space-5);
}

.search-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.search-section__count {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.search-section__action {
  min-height: 44px;
  font: var(--text-label);
  color: var(--color-brand-text);
}

/* v1.7/CHG-20：工具行（范围筛选 + 视图切换） */
.search-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.search-toolbar__chips {
  display: flex;
  gap: var(--space-1);
  overflow-x: auto;
}

.search-scope-chip {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  border: var(--border-default);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.search-scope-chip--active {
  background-color: var(--color-brand-soft, rgba(124, 92, 255, 0.16));
  border-color: var(--color-brand-text);
  color: var(--color-brand-text);
}

.search-view-toggle {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.search-late {
  margin-top: var(--space-3);
  min-height: 36px;
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.history-list {
  display: flex;
  flex-direction: column;
}

.history-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--color-divider);
}

.history-row__main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-height: 44px;
  text-align: left;
  color: var(--color-text-primary);
  font: var(--text-label);
}

.history-row__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
}

.history-row__remove {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
}

.search-suggest {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-4);
  text-align: center;
}

.search-suggest__title {
  font: var(--text-body-strong);
  color: var(--color-text-secondary);
}

.search-suggest__chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}

.search-suggest__chip {
  min-height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-label);
}

.search-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.search-offline-hint {
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-info-soft);
  font: var(--text-caption);
  color: var(--color-info);
}

.result-list {
  display: flex;
  flex-direction: column;
}

.result-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 88px;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-divider);
  text-align: left;
}

.result-row__poster {
  flex: 0 0 auto;
  width: 64px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.result-row__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.result-row__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.result-row__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.search-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.search-failed {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: var(--space-2);
  font: var(--text-caption);
  color: var(--color-warning);
  text-align: center;
}

.failed-list {
  display: flex;
  flex-direction: column;
}

.failed-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-divider);
}

.failed-row__source {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.failed-row__error {
  font: var(--text-caption);
  color: var(--color-danger);
}

.failed-empty {
  padding: var(--space-4);
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
