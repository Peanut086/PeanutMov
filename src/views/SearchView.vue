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
import type { PlayabilityStatus } from '@/services/playabilityService';

import OfflineBanner from '@/components/common/OfflineBanner.vue';
import SearchBar from '@/components/common/SearchBar.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import PosterImage from '@/components/common/PosterImage.vue';
import SearchFailurePanel from '@/components/search/SearchFailurePanel.vue';
import IconChevron from '@/components/icons/IconChevron.vue';
import IconClose from '@/components/icons/IconClose.vue';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useUiStore } from '@/stores/uiStore';
import { useToast } from '@/composables/useToast';
import { mediaSubtitle } from '@/components/common/format';
import { toErrorShape } from '@/shared/errors';
import { playabilityService } from '@/services/playabilityService';
import { scoreRelevance } from '@/services/searchAggregate';
// OPT-07：搜索建议服务
import { getSearchSuggestions, getHotSearchTags } from '@/services/suggestService';
// 功能扩展-7：来源切换弹层
import SourceSwitchSheet from '@/components/media/SourceSwitchSheet.vue';
import { buildSourceCandidates, type SourceCandidate } from '@/components/media/sourceCandidates';

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

const sourcePickerCandidates = computed<SourceCandidate[]>(() => {
  const group = sourcePickerGroup.value;
  if (!group) return [];
  return buildSourceCandidates(group.items, {
    sources: sources.sources,
    playabilityOf: (mediaId) => playabilityService.statusOf(mediaId),
    latencyOf: (sourceId) => sources.latencyOf(sourceId),
  });
});

function pickSource(candidate: SourceCandidate): void {
  const group = sourcePickerGroup.value;
  if (!group) return;
  sourcePickerGroup.value = null;
  const item = group.items.find((i) => i.id === candidate.mediaId);
  if (item) openDetail(item);
}
/** CHG-15：0 个源实际参与搜索（启用源全被体检结论/类型支持性过滤）→ 结果不可信，给诊断 */
const zeroCandidates = computed(
  () => showEmpty.value && library.searchCandidates === 0 && library.searchFilteredOut > 0,
);
/** SO-02：有因全局截止而未搜索的源 */
const hasSkipped = computed(() => library.searchSkippedIds.length > 0);
/** P0-1：忽略关键词的源数量 */
const keywordIgnoredCount = computed(() =>
  library.searchFailed.filter((f) => f.error.code === 'E_KEYWORD_IGNORED').length,
);
const emptyDescription = computed(() => {
  if (zeroCandidates.value) return `${library.searchFilteredOut} 个启用源因体检失效或类型不支持被跳过，可强制重试或检查源`;
  if (keywordIgnoredCount.value > 0 && library.searchResults.length === 0) {
    return `${keywordIgnoredCount.value} 个源返回的内容与关键词无关（已过滤），其余源未命中`;
  }
  if (hasSkipped.value) return `仅搜索了 ${library.searchCandidates - library.searchSkippedIds.length} / ${library.searchCandidates} 个源，剩余 ${library.searchSkippedIds.length} 个因超时未搜索`;
  return '换个关键词，或检查源是否启用';
});
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

/** SO-02：继续搜索因全局截止而未启动的源 */
async function continueSkipped(): Promise<void> {
  await library.continueSearchSkipped();
}

// SO-08：输入不再自动远程扇出，仅清空结果；远程搜索交给 submitSearch
watch(keyword, (value) => {
  if (value.trim().length === 0) {
    library.clearSearch();
    return;
  }
  // 关键词变化时清空旧结果，避免展示与当前输入无关的内容
  if (library.searchKeyword !== value.trim()) {
    library.clearSearch();
  }
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
  void runSearch(value, true);
}

function chooseHistory(word: string): void {
  keyword.value = word;
  void runSearch(word, true);
}

// OPT-07：选中建议项
function selectSuggestion(word: string): void {
  keyword.value = word;
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

/** C-12：用尾词建议立即重搜（点芯片后不该再停在空态） */
function searchWithTail(tail: string): void {
  keyword.value = tail;
  void runSearch(tail, false);
}

/**
 * C-12：相关度徽章。分数口径与组间排序同一个函数（4 精确 > 3 前缀 > 2 包含 > 1 分词），
 * 所以徽章序列必然与列表顺序一致。
 */
const RELEVANCE_LABELS: Record<number, string> = { 4: '精确', 3: '前缀', 2: '包含', 1: '分词' };
function relevanceScore(title: string): number {
  return scoreRelevance(title, library.searchKeyword);
}

/** C-12：空态标题带上用户原词，让"没找到什么"没有歧义 */
const emptyTitle = computed(() => {
  if (zeroCandidates.value) return '没有源参与搜索';
  const kw = library.searchKeyword.trim();
  return kw.length > 0 ? `没找到「${kw}」` : '没有找到相关内容';
});

/* ---------- v1.7/CHG-20：范围筛选与视图切换 ---------- */

const scopeOptions: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'site', label: '站点' },
  { value: 'spider', label: '爬虫' },
  { value: 'douban', label: '豆瓣' },
  { value: 'selected', label: '选定' },
];

// SO-04：选定源多选弹层
const sourceSelectOpen = ref(false);
const sourceSelectIds = ref<string[]>([]);

function applyScope(scope: SearchScope): void {
  if (scope === 'selected') {
    // 打开源多选弹层，不立即搜索
    sourceSelectIds.value = [...library.searchSelectedSourceIds];
    sourceSelectOpen.value = true;
    return;
  }
  library.setSearchScope(scope);
  if (keyword.value.trim().length > 0) void runSearch(keyword.value, false);
}

function confirmSourceSelect(): void {
  library.setSearchScope('selected', sourceSelectIds.value);
  sourceSelectOpen.value = false;
  if (keyword.value.trim().length > 0) void runSearch(keyword.value, false);
}

function toggleSourceId(id: string): void {
  const idx = sourceSelectIds.value.indexOf(id);
  if (idx >= 0) {
    sourceSelectIds.value.splice(idx, 1);
  } else {
    sourceSelectIds.value.push(id);
  }
}

const selectedSourceCount = computed(() => library.searchSelectedSourceIds.length);

function toggleViewMode(): void {
  library.setSearchViewMode(library.searchViewMode === 'grouped' ? 'flat' : 'grouped');
}

const viewToggleLabel = computed(() => (library.searchViewMode === 'grouped' ? '平铺' : '聚合'));

/* ---------- P0-P1：可播性徽章、相关度折叠、仅看可播 ---------- */

function playabilityStatus(mediaId: string): PlayabilityStatus {
  return playabilityService.statusOf(mediaId);
}

function playabilityDotClass(status: PlayabilityStatus): string {
  switch (status) {
    case 'playable': return 'play-dot--playable';
    case 'verifying': return 'play-dot--verifying';
    case 'empty': return 'play-dot--empty';
    case 'error': return 'play-dot--error';
    default: return '';
  }
}

function playabilityLabel(status: PlayabilityStatus): string {
  switch (status) {
    case 'playable': return '可播';
    case 'verifying': return '检测中';
    case 'empty': return '无剧集';
    case 'error': return '加载失败';
    default: return '';
  }
}

/** P0-4：相关度 > 0 的组（精确/前缀/包含/分词） */
const relevantGroups = computed(() =>
  library.searchGroups.filter((g) => scoreRelevance(g.title, library.searchKeyword) > 0),
);

/** P0-4：相关度 = 0 的组（折叠到"其它匹配"） */
const otherGroups = computed(() =>
  library.searchGroups.filter((g) => scoreRelevance(g.title, library.searchKeyword) === 0),
);

/** P0-1：相关度 0 的结果默认折叠，不再自动展开 */
const otherGroupsExpanded = ref(false);

function toggleOtherGroups(): void {
  otherGroupsExpanded.value = !otherGroupsExpanded.value;
}

/** P0-1：平铺视图也按相关度分流 */
const relevantFlat = computed(() =>
  library.searchResults.filter((item) => scoreRelevance(item.title, library.searchKeyword) > 0),
);
const otherFlat = computed(() =>
  library.searchResults.filter((item) => scoreRelevance(item.title, library.searchKeyword) === 0),
);
const otherFlatExpanded = ref(false);
function toggleOtherFlat(): void {
  otherFlatExpanded.value = !otherFlatExpanded.value;
}

function togglePlayableOnly(): void {
  library.setSearchPlayableOnly(!library.searchPlayableOnly);
}

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
            {{ scope.label }}<span v-if="scope.value === 'selected' && selectedSourceCount > 0" class="scope-chip__count">{{ selectedSourceCount }}</span>
          </button>
        </div>
      </div>

      <OfflineBanner v-if="isOffline" />
    </header>

    <div class="search-body" data-scroll="page">
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
          :variant="zeroCandidates ? 'search' : 'aperture'"
          :title="emptyTitle"
          :description="emptyDescription"
          :action-text="zeroCandidates ? '仍要搜索全部源' : '返回'"
          @action="zeroCandidates ? forceSearch() : goBack()"
        >
          <!-- C-12：尾词建议芯片（最多 3 个；算不出就不显示） -->
          <div v-if="library.searchTailSuggestions.length > 0" class="search-tail-chips">
            <p class="search-tail-chips__label">换个说法试试</p>
            <div class="search-tail-chips__row">
              <button
                v-for="tail in library.searchTailSuggestions"
                :key="tail"
                class="suggest-chip"
                type="button"
                @click="searchWithTail(tail)"
              >
                {{ tail }}
              </button>
            </div>
            <p class="search-tail-chips__hint">建议来自「去掉尾字重试」——中文搜索最后一字打错概率最高</p>
          </div>
        </EmptyState>
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
        <!-- SO-02：全局截止未搜索源披露 -->
        <div v-if="hasSkipped" class="search-skipped-disclosure">
          <p class="search-skipped-disclosure__text">
            仅搜索了 {{ library.searchCandidates - library.searchSkippedIds.length }} / {{ library.searchCandidates }} 个源，剩余 {{ library.searchSkippedIds.length }} 个因超时未搜索
          </p>
          <button class="btn btn--secondary btn--sm" type="button" :disabled="library.searchRetrying || isSearching" @click="continueSkipped">
            继续搜索剩余 {{ library.searchSkippedIds.length }} 个源
          </button>
        </div>
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
              <button
                class="playable-toggle"
                :class="{ 'playable-toggle--active': library.searchPlayableOnly }"
                type="button"
                :aria-pressed="library.searchPlayableOnly"
                @click="togglePlayableOnly"
              >
                仅看可播
              </button>
            </div>
          </div>

          <!-- 聚合视图：同片跨源归并，点行进详情换源 -->
          <template v-if="library.searchViewMode === 'grouped'">
            <ul class="result-list">
              <li v-for="group in relevantGroups" :key="group.key">
                <button class="result-row" type="button" @click="openDetail(group.items[0]!)">
                  <span class="result-row__poster">
                    <PosterImage :src="group.items[0]!.posterUrl" :alt="group.title" />
                  </span>
                  <span class="result-row__body">
                    <span class="result-row__title">
                      {{ group.title }}
                      <span
                        v-if="playabilityStatus(group.items[0]!.id) !== 'unknown'"
                        class="play-dot"
                        :class="playabilityDotClass(playabilityStatus(group.items[0]!.id))"
                        :aria-label="playabilityLabel(playabilityStatus(group.items[0]!.id))"
                      />
                    </span>
                    <span class="result-row__meta">
                      <span class="relevance-tag" :data-score="relevanceScore(group.title)" aria-hidden="true">{{ RELEVANCE_LABELS[relevanceScore(group.title)] }}</span>
                      {{ groupMeta(group) }}
                      <span v-if="group.items[0]!.tags.length > 0" class="item-tags">
                        <span v-for="tag in group.items[0]!.tags.slice(0, 3)" :key="tag" class="item-tag">{{ tag }}</span>
                      </span>
                      <span v-if="group.items[0]!.episodeCount" class="item-ep-count">
                        {{ group.items[0]!.episodeCount >= 100 ? '连载中' : `全${group.items[0]!.episodeCount}集` }}
                      </span>
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

            <!-- P0-4：相关度 0 的结果折叠 -->
            <div v-if="otherGroups.length > 0" class="other-groups-section">
              <button class="other-groups-toggle" type="button" @click="toggleOtherGroups">
                其它匹配（{{ otherGroups.length }}）
                <IconChevron :size="14" class="other-groups-toggle__arrow" :class="{ 'other-groups-toggle__arrow--open': otherGroupsExpanded }" />
              </button>
              <ul v-if="otherGroupsExpanded" class="result-list result-list--muted">
                <li v-for="group in otherGroups" :key="group.key">
                  <button class="result-row" type="button" @click="openDetail(group.items[0]!)">
                    <span class="result-row__poster">
                      <PosterImage :src="group.items[0]!.posterUrl" :alt="group.title" />
                    </span>
                    <span class="result-row__body">
                      <span class="result-row__title">
                        {{ group.title }}
                        <span
                          v-if="playabilityStatus(group.items[0]!.id) !== 'unknown'"
                          class="play-dot"
                          :class="playabilityDotClass(playabilityStatus(group.items[0]!.id))"
                        />
                      </span>
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
                      <IconChevron :size="16" class="result-row__chevron" />
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </template>

          <!-- 平铺视图：按相关度分流，无关项折叠 -->
          <template v-else>
            <ul class="result-list">
              <li v-for="item in relevantFlat" :key="item.id">
                <button class="result-row" type="button" @click="openDetail(item)">
                  <span class="result-row__poster">
                    <PosterImage :src="item.posterUrl" :alt="item.title" />
                  </span>
                  <span class="result-row__body">
                    <span class="result-row__title">
                      {{ item.title }}
                      <span
                        v-if="playabilityStatus(item.id) !== 'unknown'"
                        class="play-dot"
                        :class="playabilityDotClass(playabilityStatus(item.id))"
                      />
                    </span>
                    <span class="result-row__meta">
                      <span class="relevance-tag" :data-score="relevanceScore(item.title)" aria-hidden="true">{{ RELEVANCE_LABELS[relevanceScore(item.title)] }}</span>
                      {{ itemMeta(item) }}
                      <span v-if="item.tags.length > 0" class="item-tags">
                        <span v-for="tag in item.tags.slice(0, 3)" :key="tag" class="item-tag">{{ tag }}</span>
                      </span>
                    </span>
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

            <div v-if="otherFlat.length > 0" class="other-groups-section">
              <button class="other-groups-toggle" type="button" @click="toggleOtherFlat">
                其它匹配（{{ otherFlat.length }}）
                <IconChevron :size="14" class="other-groups-toggle__arrow" :class="{ 'other-groups-toggle__arrow--open': otherFlatExpanded }" />
              </button>
              <ul v-if="otherFlatExpanded" class="result-list result-list--muted">
                <li v-for="item in otherFlat" :key="item.id">
                  <button class="result-row" type="button" @click="openDetail(item)">
                    <span class="result-row__poster">
                      <PosterImage :src="item.posterUrl" :alt="item.title" />
                    </span>
                    <span class="result-row__body">
                      <span class="result-row__title">
                        {{ item.title }}
                        <span
                          v-if="playabilityStatus(item.id) !== 'unknown'"
                          class="play-dot"
                          :class="playabilityDotClass(playabilityStatus(item.id))"
                        />
                      </span>
                      <span class="result-row__meta">
                        {{ itemMeta(item) }}
                      </span>
                    </span>
                    <span class="result-row__tail">
                      <IconChevron :size="16" class="result-row__chevron" />
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </template>
        </section>

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
    <SourceSwitchSheet
      v-model="sourcePickerOpen"
      :title="sourcePickerGroup?.title ?? '选择来源'"
      :candidates="sourcePickerCandidates"
      :can-search-more="false"
      @select="pickSource"
    />

    <!-- SO-04：选定源多选弹层 -->
    <Teleport to="body">
      <Transition name="sheet-fade">
        <div v-if="sourceSelectOpen" class="source-select-sheet" @click.self="sourceSelectOpen = false">
          <div class="source-select-sheet__panel">
            <div class="source-select-sheet__head">
              <h3 class="source-select-sheet__title">选定搜索源</h3>
              <button class="source-select-sheet__close" type="button" @click="sourceSelectOpen = false">
                <IconClose />
              </button>
            </div>
            <div class="source-select-sheet__actions">
              <button class="btn btn--ghost btn--sm" type="button" @click="sourceSelectIds = sources.enabledSources.map(s => s.id)">全选</button>
              <button class="btn btn--ghost btn--sm" type="button" @click="sourceSelectIds = []">清空</button>
            </div>
            <ul class="source-select-sheet__list">
              <li
                v-for="source in sources.enabledSources"
                :key="source.id"
                class="source-select-sheet__item"
                :class="{ 'source-select-sheet__item--checked': sourceSelectIds.includes(source.id) }"
                @click="toggleSourceId(source.id)"
              >
                <span class="source-select-sheet__check">
                  <svg v-if="sourceSelectIds.includes(source.id)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span class="source-select-sheet__name">{{ source.name }}</span>
                <span class="source-select-sheet__type">{{ source.type }}</span>
              </li>
            </ul>
            <div class="source-select-sheet__footer">
              <button class="btn btn--primary" type="button" :disabled="sourceSelectIds.length === 0" @click="confirmSourceSelect">
                搜索选定的 {{ sourceSelectIds.length }} 个源
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
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
.search-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-4);
  padding: 10px var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-brand);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--text-caption);
  text-align: left;
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

/* C-12：空态尾词建议芯片（复用 .suggest-chip，40px + ::after 补足 44px 命中区） */
.search-tail-chips {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-4);
}

.search-tail-chips__label {
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.search-tail-chips__row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}

.search-tail-chips__hint {
  font: var(--text-caption);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--color-text-disabled);
}

/* C-12：相关度徽章——档位来自 scoreRelevance，与列表排序同一个口径 */
.relevance-tag {
  display: inline-block;
  margin-right: var(--space-1);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font: var(--font-weight-medium) 10px / 1.4 var(--font-family-base);
  background-color: var(--color-bg-surface);
  color: var(--color-text-tertiary);
}

.relevance-tag[data-score='4'] {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.relevance-tag[data-score='3'] {
  background-color: var(--color-info-soft);
  color: var(--color-info);
}

.relevance-tag[data-score='2'] {
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
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

/* ---------- P0-P1：可播性徽章与标签 ---------- */

.play-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-left: 5px;
  vertical-align: middle;
  flex: 0 0 auto;
}

.play-dot--playable {
  background-color: var(--color-success, #34c759);
  box-shadow: 0 0 0 2px rgba(52, 199, 89, 0.18);
}

.play-dot--verifying {
  background-color: var(--color-warning, #f0a830);
  animation: play-dot-pulse 1.2s ease-in-out infinite;
}

.play-dot--empty {
  background-color: var(--color-text-tertiary, #999);
  opacity: 0.5;
}

.play-dot--error {
  background-color: var(--color-danger, #ff3b30);
  opacity: 0.6;
}

@keyframes play-dot-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.item-tags {
  display: inline-flex;
  gap: 4px;
  margin-left: 4px;
  vertical-align: middle;
}

.item-tag {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  background-color: rgba(128, 128, 128, 0.12);
  color: var(--color-text-secondary, #666);
  font: 500 10px / 1.4 var(--font-family-base);
  white-space: nowrap;
}

.item-ep-count {
  display: inline-block;
  margin-left: 4px;
  color: var(--color-text-tertiary, #999);
  font: 10px / 1.4 var(--font-family-base);
  white-space: nowrap;
}

.playable-toggle {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 14px;
  border: 1px solid var(--color-border, #e0e0e0);
  background: none;
  color: var(--color-text-secondary, #666);
  font: 500 12px / 1 var(--font-family-base);
  cursor: pointer;
  transition: all var(--duration-fast);
  white-space: nowrap;
}

.playable-toggle:active {
  background-color: var(--color-bg-pressed);
}

.playable-toggle--active {
  background-color: var(--color-success-soft, rgba(52, 199, 89, 0.12));
  border-color: var(--color-success, #34c759);
  color: var(--color-success, #34c759);
}

/* ---------- P0-4：相关度 0 折叠区 ---------- */

.other-groups-section {
  margin-top: var(--space-3);
}

.other-groups-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 10px var(--layout-page-padding-x);
  background: none;
  border: none;
  color: var(--color-text-tertiary, #999);
  font: 500 13px / 1 var(--font-family-base);
  cursor: pointer;
  text-align: left;
}

.other-groups-toggle:active {
  color: var(--color-text-secondary);
}

.other-groups-toggle__arrow {
  transition: transform var(--duration-fast);
  transform: rotate(90deg);
}

.other-groups-toggle__arrow--open {
  transform: rotate(270deg);
}

.result-list--muted {
  opacity: 0.7;
}

.result-list--muted .result-row__title {
  color: var(--color-text-secondary, #666);
}

/* ---------- SO-04：选定源 scope chip 计数 ---------- */
.scope-chip__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background-color: var(--color-brand, #f0a82e);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

/* ---------- SO-04：选定源多选弹层 ---------- */
.source-select-sheet {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 1000);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.45);
}

.source-select-sheet__panel {
  width: 100%;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-surface, #fff);
  border-radius: var(--radius-xl, 16px) var(--radius-xl, 16px) 0 0;
  overflow: hidden;
}

.source-select-sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3, 12px) var(--space-4, 16px);
  border-bottom: 1px solid var(--color-border, #e5e5e5);
}

.source-select-sheet__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary, #111);
}

.source-select-sheet__close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--color-text-secondary, #666);
  cursor: pointer;
  border-radius: var(--radius-full);
}

.source-select-sheet__close:active {
  background-color: var(--color-bg-pressed, #f0f0f0);
}

.source-select-sheet__actions {
  display: flex;
  gap: var(--space-2, 8px);
  padding: var(--space-2, 8px) var(--space-4, 16px);
}

.source-select-sheet__list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 var(--space-2, 8px);
  margin: 0;
  list-style: none;
}

.source-select-sheet__item {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: var(--space-3, 12px);
  border-radius: var(--radius-md, 10px);
  cursor: pointer;
  transition: background-color var(--duration-fast, 150ms);
}

.source-select-sheet__item:active {
  background-color: var(--color-bg-pressed, #f0f0f0);
}

.source-select-sheet__item--checked {
  background-color: var(--color-brand-soft, rgba(240, 168, 46, 0.1));
}

.source-select-sheet__check {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--color-border, #ccc);
  border-radius: var(--radius-sm, 6px);
  color: var(--color-brand, #f0a82e);
  flex-shrink: 0;
}

.source-select-sheet__item--checked .source-select-sheet__check {
  border-color: var(--color-brand, #f0a82e);
  background-color: var(--color-brand, #f0a82e);
  color: #fff;
}

.source-select-sheet__check svg {
  width: 14px;
  height: 14px;
}

.source-select-sheet__name {
  flex: 1 1 auto;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary, #111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-select-sheet__type {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--color-text-tertiary, #999);
  padding: 2px 8px;
  background-color: var(--color-bg-base, #f5f5f5);
  border-radius: var(--radius-full);
}

.source-select-sheet__footer {
  padding: var(--space-3, 12px) var(--space-4, 16px) calc(var(--space-3, 12px) + var(--safe-bottom, 0px));
  border-top: 1px solid var(--color-border, #e5e5e5);
}

.source-select-sheet__footer .btn {
  width: 100%;
}

/* sheet 过渡 */
.sheet-fade-enter-active,
.sheet-fade-leave-active {
  transition: opacity var(--duration-normal, 250ms) var(--ease-standard, ease);
}

.sheet-fade-enter-active .source-select-sheet__panel,
.sheet-fade-leave-active .source-select-sheet__panel {
  transition: transform var(--duration-normal, 250ms) var(--ease-standard, ease);
}

.sheet-fade-enter-from,
.sheet-fade-leave-to {
  opacity: 0;
}

.sheet-fade-enter-from .source-select-sheet__panel,
.sheet-fade-leave-to .source-select-sheet__panel {
  transform: translateY(100%);
}
</style>
