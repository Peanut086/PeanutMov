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

import type { MediaItem, SearchResultGroup, SearchScope } from '@/types';

import OfflineBanner from '@/components/common/OfflineBanner.vue';
import SearchBar from '@/components/common/SearchBar.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import PosterImage from '@/components/common/PosterImage.vue';
import SearchFailurePanel from '@/components/search/SearchFailurePanel.vue';
import IconChevron from '@/components/icons/IconChevron.vue';
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
// OPT-07：搜索建议服务
import { getSearchSuggestions, getHotSearchTags } from '@/services/suggestService';

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

const history = computed(() => settings.settings?.searchHistory ?? []);
const isSearching = computed(() => library.searchState === 'loading');
const hasResults = computed(() => library.searchResults.length > 0);
const showInitial = computed(() => keyword.value.trim().length === 0);
const showEmpty = computed(
  () => !showInitial.value && library.searchState === 'empty' && !isSearching.value,
);

/* ---------- OPT-07：搜索建议与热门标签 ---------- */
const suggestions = computed(() => getSearchSuggestions(
  keyword.value,
  8,
  settings.settings?.searchHistory ?? [],
  library.items ?? [],
));
const hotSearchTags = computed(() => getHotSearchTags(10));

/* ---------- 功能扩展-7：搜索组内换源 ---------- */
const sourcePickerGroup = ref<SearchResultGroup | null>(null);
const sourcePickerOpen = computed({
  get: () => sourcePickerGroup.value !== null,
  set: (v: boolean) => { if (!v) sourcePickerGroup.value = null; },
});

function openSourcePicker(group: SearchResultGroup): void {
  sourcePickerGroup.value = group;
}

function pickSource(item: MediaItem): void {
  sourcePickerGroup.value = null;
  openDetail(item);
}

function sourceHealthLabel(health: string): string {
  switch (health) {
    case 'ok': return '正常';
    case 'timeout': return '慢';
    case 'unreachable': return '不可达';
    case 'auth_failed': return '需登录';
    default: return '未知';
  }
}

function getSourceHealth(sourceId: string): string {
  return sources.sources.find((s) => s.id === sourceId)?.health ?? 'unknown';
}
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

/* ---------- P2-9 / OPT-04：失败源汇总、折叠明细、只重试失败源 ----------
 * 展示逻辑收敛在 SearchFailurePanel（含原因聚类、折叠、重试按钮）；
 * 这里只负责把失败列表与重试动作接上 store。
 */

/** 重试仍失败的源（OPT-04：只重跑失败源，不重搜全部） */
async function retryFailed(): Promise<void> {
  await library.retryFailedSources();
}

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

// OPT-07：选中建议项
function selectSuggestion(word: string): void {
  keyword.value = word;
  debouncedSearch.cancel();
  void runSearch(word, true);
}

// OPT-07：删除建议（从历史中移除）
async function deleteSuggestion(word: string): Promise<void> {
  const current = settings.settings?.searchHistory ?? [];
  try {
    await settings.update({ searchHistory: current.filter((v) => v !== word) });
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
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

const viewToggleLabel = computed(() => (library.searchViewMode === 'grouped' ? '平铺' : '聚合'));

/** 聚合行副标题：`2024 · 科幻 · 3 个来源` */
function groupMeta(group: SearchResultGroup): string {
  const parts: string[] = [];
  if (group.year !== null) parts.push(String(group.year));
  const genre = group.items[0]?.genres[0];
  if (genre) parts.push(genre);
  parts.push(`${group.items.length} 个来源`);
  return parts.join(' · ');
}

/** 平铺行副标题：`2024 · 电影 · 科幻 · 源名` */
function itemMeta(item: MediaItem): string {
  const parts: string[] = [mediaSubtitle(item)];
  const genre = item.genres[0];
  if (genre) parts.push(genre);
  parts.push(sourceName(item.sourceId));
  return parts.join(' · ');
}

function ratingText(item: MediaItem | undefined): string | null {
  const rating = item?.rating;
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating <= 0) return null;
  return rating.toFixed(1);
}

function openSourceManage(): void {
  void router.push({ name: 'settings', query: { sources: '1' } });
}
</script>

<template>
  <main class="search-page" data-route="search">
    <header class="search-head">
      <div class="search-head__bar">
        <SearchBar
          v-model="keyword"
          placeholder="搜索片名、演员…"
          :suggestions="suggestions"
          @search="submitSearch"
          @select-suggestion="selectSuggestion"
          @delete-suggestion="deleteSuggestion"
        />
        <button class="search-cancel" type="button" @click="goBack">取消</button>
      </div>

      <div class="scope-row">
        <div class="scope-row__scroll" aria-label="搜索范围">
          <button
            v-for="scope in scopeOptions"
            :key="scope.value"
            class="scope-chip"
            :class="{ 'scope-chip--active': library.searchScope === scope.value }"
            type="button"
            :aria-pressed="library.searchScope === scope.value"
            @click="applyScope(scope.value)"
          >
            {{ scope.label }}
          </button>
        </div>
      </div>

      <OfflineBanner v-if="isOffline" />
    </header>

    <div class="search-body">
      <!-- 初始：搜索历史 -->
      <template v-if="showInitial">
        <section v-if="history.length > 0" class="search-section">
          <div class="section-head">
            <h2 class="section-title">搜索历史</h2>
            <button class="section-head__action" type="button" @click="clearHistory">清空</button>
          </div>
          <ul class="history-chips">
            <li v-for="word in history" :key="word" class="history-chip">
              <button class="history-chip__main" type="button" @click="chooseHistory(word)">
                <svg class="history-chip__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="8.4" />
                  <path d="M12 7.6V12l3 2" />
                </svg>
                <span class="truncate-1">{{ word }}</span>
              </button>
              <button
                class="history-chip__remove"
                type="button"
                :aria-label="`删除历史 ${word}`"
                @click="removeHistory(word)"
              >
                <IconClose :size="12" />
              </button>
            </li>
          </ul>
        </section>

        <section v-else class="search-suggest">
          <p class="search-suggest__title">热门搜索</p>
          <div class="search-suggest__chips">
            <button
              v-for="word in hotSearchTags"
              :key="word"
              class="suggest-chip suggest-chip--hot"
              type="button"
              @click="chooseHistory(word)"
            >
              <svg class="suggest-chip__fire" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 2c-1 4-4 6-4 10a4 4 0 0 0 8 0c0-4-3-6-4-10z" />
              </svg>
              {{ word }}
            </button>
          </div>
          <p class="search-suggest__hint">试试搜索片名、演员或年份</p>
        </section>
      </template>

      <!-- 搜索中：骨架行，避免空白等待 -->
      <div v-else-if="isSearching && !hasResults" class="search-loading" role="status">
        <span class="sr-only">正在搜索…</span>
        <ul class="result-list" aria-hidden="true">
          <li v-for="n in 3" :key="`sk-${n}`" class="skeleton-row">
            <span class="skeleton skeleton-row__poster" />
            <span class="skeleton-row__lines">
              <span class="skeleton skeleton-row__line" style="width: 62%" />
              <span class="skeleton skeleton-row__line skeleton-row__line--short" style="width: 40%" />
            </span>
          </li>
        </ul>
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
          class="search-diagnose"
          type="button"
          @click="openSourceManage"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8.4" />
            <path d="M12 8v5M12 16.2v.2" />
          </svg>
          被跳过的源有 {{ library.searchFilteredOut }} 个，打开源管理检查
        </button>
        <!-- P2-9 / OPT-04：失败源汇总（空结果下同样可展开明细 / 只重试失败源） -->
        <SearchFailurePanel
          v-else-if="library.searchFailed.length > 0"
          class="search-failed-panel"
          :failures="library.searchFailed"
          :name-of="sourceName"
          :retrying="library.searchRetrying"
          :busy="isSearching"
          @retry="retryFailed"
        />
      </template>

      <!-- 结果 -->
      <template v-else-if="hasResults">
        <div v-if="isOffline" class="search-offline-hint">离线，仅搜索本地缓存</div>

        <!-- OPT-04：失败源汇总置顶，明细默认折叠；重试只重跑失败源 -->
        <SearchFailurePanel
          v-if="library.searchFailed.length > 0"
          class="search-failed-panel"
          :failures="library.searchFailed"
          :name-of="sourceName"
          :retrying="library.searchRetrying"
          :busy="isSearching"
          @retry="retryFailed"
        />

        <section class="search-section">
          <div class="section-head">
            <h2 class="section-title">搜索结果</h2>
            <div class="section-head__tools">
              <span class="search-count">
                <template v-if="library.searchViewMode === 'grouped'">
                  {{ library.searchGroups.length }} 部 · 来源 {{ library.searchResultsAll.length }} 条
                </template>
                <template v-else>{{ library.searchResults.length }} 条</template>
              </span>
              <button
                class="view-toggle"
                type="button"
                :aria-label="`切换到${viewToggleLabel}视图`"
                @click="toggleViewMode"
              >
                <svg v-if="library.searchViewMode === 'grouped'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                  <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
                  <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
                  <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
                  <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                  <path d="M4 6.5h16M4 12h16M4 17.5h16" />
                </svg>
                {{ viewToggleLabel }}
              </button>
            </div>
          </div>

          <!-- 聚合视图：同片跨源归并，点行进详情换源 -->
          <ul v-if="library.searchViewMode === 'grouped'" class="result-list">
            <li v-for="group in library.searchGroups" :key="group.key">
              <button class="result-row" type="button" @click="openDetail(group.items[0]!)">
                <span class="result-row__poster">
                  <PosterImage :src="group.items[0]!.posterUrl" :alt="group.title" />
                </span>
                <span class="result-row__body">
                  <span class="result-row__title">{{ group.title }}</span>
                  <span class="result-row__meta">
                    {{ groupMeta(group) }}
                    <button
                      v-if="group.items.length > 1"
                      class="source-count-btn"
                      type="button"
                      @click.stop="openSourcePicker(group)"
                    >
                      切换
                      <IconChevron :size="12" class="source-count-btn__arrow" />
                    </button>
                  </span>
                </span>
                <span class="result-row__tail">
                  <span
                    v-if="ratingText(group.items[0])"
                    class="rating-tag"
                    :aria-label="`评分 ${ratingText(group.items[0])}`"
                  >
                    {{ ratingText(group.items[0]) }}
                  </span>
                  <IconChevron :size="16" class="result-row__chevron" />
                </span>
              </button>
            </li>
          </ul>

          <!-- 平铺视图：按相关度排序的单条列表 -->
          <ul v-else class="result-list">
            <li v-for="item in library.searchResults" :key="item.id">
              <button class="result-row" type="button" @click="openDetail(item)">
                <span class="result-row__poster">
                  <PosterImage :src="item.posterUrl" :alt="item.title" />
                </span>
                <span class="result-row__body">
                  <span class="result-row__title">{{ item.title }}</span>
                  <span class="result-row__meta">{{ itemMeta(item) }}</span>
                </span>
                <span class="result-row__tail">
                  <span v-if="ratingText(item)" class="rating-tag" :aria-label="`评分 ${ratingText(item)}`">
                    {{ ratingText(item) }}
                  </span>
                  <IconChevron :size="16" class="result-row__chevron" />
                </span>
              </button>
            </li>
          </ul>
        </section>

        <!-- 慢源晚到提示：不重排已浏览内容，点击刷新排序 -->
        <button
          v-if="library.searchLateCount > 0 && !isSearching"
          class="search-late"
          type="button"
          @click="retry"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5.5v6l3.6 2.2" />
            <path d="M20.4 12a8.4 8.4 0 1 1-2.6-6" />
            <path d="M20.6 4.2v4.4h-4.4" />
          </svg>
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
      </template>
    </div>

    <!-- 功能扩展-7：组内换源弹层 -->
    <BottomSheet v-model="sourcePickerOpen" :title="sourcePickerGroup?.title ?? '选择来源'">
      <ul v-if="sourcePickerGroup" class="source-picker-list">
        <li
          v-for="(item, idx) in sourcePickerGroup.items"
          :key="item.id"
          class="source-picker-item"
          :class="{ 'source-picker-item--current': idx === 0 }"
        >
          <button class="source-picker-item__btn" type="button" @click="pickSource(item)">
            <span class="source-picker-item__main">
              <span class="source-picker-item__name">{{ sourceName(item.sourceId) }}</span>
              <span class="source-picker-item__health">
                {{ sourceHealthLabel(getSourceHealth(item.sourceId)) }}
              </span>
            </span>
            <span v-if="idx === 0" class="source-picker-item__badge">推荐</span>
            <IconChevron :size="16" class="source-picker-item__arrow" />
          </button>
        </li>
      </ul>
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

/* ---------- 顶部：搜索框 + 取消 + 范围筛选（吸顶） ---------- */
.search-head {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  flex: 0 0 auto;
  padding-top: var(--safe-top);
  background-color: var(--color-bg-base);
}

/* 内容滚到顶部时的软过渡，避免硬切 */
.search-head::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -10px;
  height: 10px;
  background: linear-gradient(180deg, var(--color-bg-base) 0%, transparent 100%);
  pointer-events: none;
}

.search-head__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--layout-page-padding-x);
}

.search-head__bar :deep(.search-bar) {
  flex: 1 1 auto;
  min-width: 0;
}

.search-cancel {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  font: var(--text-label-strong);
  color: var(--color-brand-text);
  transition: var(--transition-color);
}

.search-cancel:active {
  color: var(--color-brand-strong);
}

.scope-row {
  display: flex;
  padding: 0 var(--layout-page-padding-x) var(--space-2);
}

.scope-row__scroll {
  display: flex;
  flex: 1 1 auto;
  gap: var(--space-2);
  overflow-x: auto;
  margin: 0 calc(var(--layout-page-padding-x) * -1);
  padding: 0 var(--layout-page-padding-x);
  scrollbar-width: none;
}

.scope-row__scroll::-webkit-scrollbar {
  display: none;
}

.scope-chip {
  position: relative;
  flex: 0 0 auto;
  height: 34px;
  padding: 0 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--font-weight-medium) 13px / 18px var(--font-family-base);
  transition: var(--transition-color), border-color var(--duration-fast) var(--ease-standard);
}

/* 视觉 34，命中区补到 44 */
.scope-chip::after {
  content: '';
  position: absolute;
  inset: -5px 0;
}

.scope-chip:active {
  background-color: var(--color-bg-pressed);
}

.scope-chip--active {
  background-color: var(--color-brand-soft);
  border-color: rgba(240, 168, 46, 0.42);
  color: var(--color-brand-text);
  font-weight: 600;
}

.search-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

/* ---------- 区块标题 ---------- */
.search-section + .search-section {
  margin-top: var(--space-5);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: var(--space-4) 0 var(--space-3);
}

.section-head__tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.section-head__action {
  position: relative;
  min-height: 32px;
  padding: 0 var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  transition: var(--transition-color);
}

.section-head__action::after {
  content: '';
  position: absolute;
  inset: -6px;
}

.section-head__action:active {
  color: var(--color-text-primary);
}

.search-count {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.view-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-full);
  border: var(--border-default);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-caption);
  transition: var(--transition-color);
}

.view-toggle svg {
  width: 14px;
  height: 14px;
}

.view-toggle::after {
  content: '';
  position: absolute;
  inset: -7px;
}

.view-toggle:active {
  background-color: var(--color-bg-pressed);
  color: var(--color-text-primary);
}

/* ---------- 搜索历史 / 建议 ---------- */
.history-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.history-chip {
  display: inline-flex;
  align-items: stretch;
  max-width: 100%;
  height: 40px;
  border-radius: var(--radius-full);
  border: var(--border-default);
  background-color: var(--color-bg-surface);
}

.history-chip__main {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: 0 var(--space-1) 0 var(--space-3);
  color: var(--color-text-primary);
  font: var(--text-label);
}

.history-chip__main::after {
  content: '';
  position: absolute;
  inset: -2px 0;
}

.history-chip__main:active {
  color: var(--color-brand-text);
}

.history-chip__icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
}

.history-chip__remove {
  position: relative;
  flex: 0 0 auto;
  width: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
  color: var(--color-text-tertiary);
  transition: var(--transition-color);
}

.history-chip__remove::after {
  content: '';
  position: absolute;
  inset: -2px;
}

.history-chip__remove:active {
  color: var(--color-text-primary);
  background-color: var(--color-overlay-press);
}

.search-suggest {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-6) 0;
}

.search-suggest__title {
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
}

.search-suggest__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.suggest-chip {
  position: relative;
  height: 40px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-full);
  border: var(--border-default);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-label);
  transition: var(--transition-color);
}

.suggest-chip::after {
  content: '';
  position: absolute;
  inset: -2px 0;
}

.suggest-chip:active {
  background-color: var(--color-bg-pressed);
  color: var(--color-text-primary);
}

/* OPT-07：热门搜索标签 */
.suggest-chip--hot {
  background-color: var(--color-warning-soft);
  border-color: rgba(251, 191, 36, 0.22);
  color: var(--color-warning);
}

.suggest-chip--hot:active {
  background-color: rgba(251, 191, 36, 0.22);
}

.suggest-chip__fire {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.search-suggest__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  padding-top: var(--space-1);
}

/* ---------- 加载骨架 / 结果列表 ---------- */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.search-loading {
  padding-top: var(--space-2);
}

.result-list {
  display: flex;
  flex-direction: column;
  /* 行按压反馈铺满整屏宽 */
  margin: 0 calc(var(--layout-page-padding-x) * -1);
}

.skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px var(--layout-page-padding-x);
}

.skeleton-row__poster {
  flex: 0 0 auto;
  width: 46px;
  height: 69px;
  border-radius: 9px;
}

.skeleton-row__lines {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skeleton-row__line {
  height: 12px;
  border-radius: var(--radius-sm);
}

.skeleton-row__line--short {
  height: 10px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 88px;
  padding: 10px var(--layout-page-padding-x);
  text-align: left;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.result-row:active {
  background-color: var(--color-bg-pressed);
}

.result-row__poster {
  flex: 0 0 auto;
  width: 46px;
  border-radius: 9px;
  overflow: hidden;
}

.result-row__poster :deep(.poster-image) {
  border-radius: 9px;
}

.result-row__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.result-row__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--font-weight-semibold) 14.5px / 1.35 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
}

.result-row__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.result-row__tail {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
}

.result-row__chevron {
  color: var(--color-text-tertiary);
  opacity: 0.65;
}

.rating-tag {
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--font-weight-semibold) 11px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
}

/* ---------- 进程提示条 ---------- */
.search-late,
.search-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-4);
  padding: 10px var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid rgba(96, 165, 250, 0.22);
  background-color: var(--color-info-soft);
  color: var(--color-info);
  font: var(--text-caption);
  text-align: left;
}

.search-late svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.search-late:active {
  background-color: rgba(96, 165, 250, 0.22);
}

.search-offline-hint {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-info-soft);
  font: var(--text-caption);
  color: var(--color-info);
}

.search-diagnose {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid rgba(251, 191, 36, 0.22);
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
  font: var(--text-caption);
}

.search-diagnose svg {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.search-diagnose:active {
  background-color: rgba(251, 191, 36, 0.22);
}

/* OPT-04：失败源面板与上下内容的间距（面板自身样式在组件内） */
.search-failed-panel {
  margin-top: var(--space-3);
}

/* ---------- 功能扩展-7：组内换源 ---------- */
.source-count-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: var(--space-2);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--text-caption);
  border: none;
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.source-count-btn:active {
  background-color: var(--color-brand-soft-hover, rgba(40, 160, 80, 0.25));
}

.source-count-btn__arrow {
  transform: rotate(90deg);
}

.source-picker-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.source-picker-item {
  border-bottom: 1px solid var(--color-divider);
}

.source-picker-item:last-child {
  border-bottom: none;
}

.source-picker-item__btn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 56px;
  padding: var(--space-3) var(--space-4);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background-color var(--duration-fast);
}

.source-picker-item__btn:active {
  background-color: var(--color-bg-pressed);
}

.source-picker-item__main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.source-picker-item__name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.source-picker-item__health {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.source-picker-item__badge {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--font-weight-semibold) 10px / 1.2 var(--font-family-base);
}

.source-picker-item--current .source-picker-item__badge {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.source-picker-item__arrow {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  transform: rotate(90deg);
}
</style>
