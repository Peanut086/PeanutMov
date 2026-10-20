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

import type { MediaItem } from '@/types';

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

const router = useRouter();
const route = useRoute();
const library = useLibraryStore();
const settings = useSettingsStore();
const sources = useSourceStore();
const ui = useUiStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const keyword = ref(typeof route.query.q === 'string' ? route.query.q : '');
const failedDetailOpen = ref(false);
const searchBarRef = ref<{ focus: () => void } | null>(null);

const history = computed(() => settings.settings?.searchHistory ?? []);
const isSearching = computed(() => library.searchState === 'loading');
const hasResults = computed(() => library.searchResults.length > 0);
const showInitial = computed(() => keyword.value.trim().length === 0);
const showEmpty = computed(
  () => !showInitial.value && library.searchState === 'empty' && !isSearching.value,
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
    if (keyword.value.trim().length > 0) await runSearch(keyword.value, false);
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
  if (keyword.value.length > 0) {
    keyword.value = '';
    library.clearSearch();
    return;
  }
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/');
}

function retry(): void {
  void runSearch(keyword.value, false);
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
      <EmptyState
        v-else-if="showEmpty"
        variant="search"
        title="没有找到相关内容"
        description="换个关键词，或检查源是否启用"
        action-text="返回"
        @action="goBack"
      />

      <!-- 结果 -->
      <template v-else-if="hasResults">
        <div v-if="isOffline" class="search-offline-hint">离线，仅搜索本地缓存</div>

        <section class="search-section">
          <div class="search-section__head">
            <h2 class="section-title">搜索结果</h2>
            <span class="search-section__count">{{ library.searchResults.length }} 条</span>
          </div>

          <ul class="result-list">
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

        <div v-if="isSearching" class="search-progress">
          <LoadingSpinner :size="16" />
          <span>仍在搜索其它源…</span>
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
