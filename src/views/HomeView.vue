<script setup lang="ts">
/**
 * 首页（页面蓝图 §2）
 *
 * 信息层级：继续观看（横滑，无数据整块不渲染）→ 最近添加（2 列网格）。
 * 不做运营位/Banner/推荐算法——本产品是工具。
 * 四态：loading 骨架 / empty 引导 / error 顶部错误卡（缓存内容仍展示）/ offline 横幅。
 *
 * P0-4：「最近添加」读跨源缓存（library.homeRecent，毫秒级、离线可用），
 * 当前源首页由 store 后台预热；本页被 KeepAlive 缓存，回 tab 静默刷新不重闪骨架。
 */
import { computed, onActivated, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { HistoryRecord, MediaItem } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import PosterGrid from '@/components/media/PosterGrid.vue';
import ContinueWatchingRow from '@/components/media/ContinueWatchingRow.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useToast } from '@/composables/useToast';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { toErrorShape } from '@/shared/errors';

defineOptions({ name: 'HomeView' });

const router = useRouter();
const history = useHistoryStore();
const library = useLibraryStore();
const downloads = useDownloadStore();
const favorites = useFavoriteStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const localError = ref<string | null>(null);
const initialLoading = computed(
  () => library.homeState === 'idle' || library.homeState === 'loading',
);
const errorMessage = computed(() => localError.value ?? library.homeError?.message ?? null);

const continueItems = computed(() => history.continueWatching.slice(0, 10));
const recentItems = computed(() => library.homeRecent);

const downloadedIds = computed(() =>
  downloads.tasks.filter((t) => t.status === 'completed').map((t) => t.mediaId),
);

const isEmpty = computed(
  () => !initialLoading.value && recentItems.value.length === 0 && continueItems.value.length === 0,
);

async function load(): Promise<void> {
  localError.value = null;
  try {
    await Promise.all([history.load(), downloads.load(), favorites.load()]);
    await library.loadHome();
  } catch (e) {
    localError.value = toErrorShape(e).message;
  }
}

// KeepAlive 下 onActivated 首次进入也会触发（替代 onMounted），回 tab 时静默刷新
onActivated(() => {
  void load();
});

function openDetail(item: MediaItem): void {
  void router.push({ name: 'detail', params: { mediaId: item.id }, query: { sourceId: item.sourceId } });
}

function continuePlay(rec: HistoryRecord): void {
  const query: Record<string, string> = {};
  if (rec.episodeId) query.episodeId = rec.episodeId;
  void router.push({ name: 'player', params: { mediaId: rec.mediaId, episodeId: rec.episodeId ?? undefined }, query });
}

async function removeContinue(rec: HistoryRecord): Promise<void> {
  try {
    await history.remove(rec.id);
    toast.success('已从继续观看移除');
  } catch (e) {
    toast.error(toErrorShape(e).message);
    await load();
  }
}

function goLibrary(): void {
  void router.push('/library');
}

function openSearch(): void {
  void router.push('/search');
}

async function retry(): Promise<void> {
  await load();
  if (!errorMessage.value) toast.success('已刷新');
}
</script>

<template>
  <SafeArea tabbar data-route="home">
    <AppHeader title="PeanutMov" brand search @search="openSearch" />

    <div class="home-body">
      <OfflineBanner v-if="isOffline" />

      <!-- error：顶部错误卡，已有缓存仍展示 -->
      <div v-if="errorMessage" class="home-error" role="alert">
        <span class="home-error__text">{{ errorMessage }}</span>
        <button class="btn btn--secondary btn--sm" type="button" @click="retry">重试</button>
      </div>

      <!-- loading 骨架 -->
      <template v-if="initialLoading">
        <section class="home-section">
          <h2 class="section-title">继续观看</h2>
          <div class="home-skeleton-row">
            <div v-for="n in 3" :key="`cw-${n}`" class="home-skeleton-card">
              <SkeletonPoster />
            </div>
          </div>
        </section>
        <section class="home-section">
          <h2 class="section-title">最近添加</h2>
          <PosterGrid :items="[]" loading :skeleton-count="6" />
        </section>
      </template>

      <!-- empty -->
      <div v-else-if="isEmpty" class="home-empty">
        <h2 class="home-empty__title">还没有内容</h2>
        <p class="home-empty__desc">
          添加一个你自己的源（NAS / AList / Jellyfin / 站点）后，内容会出现在这里。
        </p>
        <div class="home-empty__actions">
          <button class="btn btn--primary btn--md" type="button" @click="goLibrary">去媒体库看看</button>
          <button class="btn btn--secondary btn--md" type="button" @click="retry">刷新</button>
        </div>
      </div>

      <!-- success -->
      <template v-else>
        <section v-if="continueItems.length > 0" class="home-section" aria-labelledby="home-continue">
          <div class="home-section__head">
            <h2 id="home-continue" class="section-title">继续观看</h2>
            <RouterLink class="home-section__link" to="/history">全部历史</RouterLink>
          </div>
          <ContinueWatchingRow
            :items="continueItems"
            @select="continuePlay"
            @remove="removeContinue"
          />
        </section>

        <section class="home-section" aria-labelledby="home-recent">
          <div class="home-section__head">
            <h2 id="home-recent" class="section-title">最近添加</h2>
            <RouterLink class="home-section__link" to="/library">全部内容</RouterLink>
          </div>
          <PosterGrid
            :items="recentItems"
            :downloaded-ids="downloadedIds"
            :progress-map="{}"
            @select="openDetail"
          />
          <p v-if="library.homeState === 'refreshing'" class="home-refreshing">
            <LoadingSpinner :size="16" />
            正在刷新…
          </p>
        </section>
      </template>
    </div>
  </SafeArea>
</template>

<style scoped>
.home-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) var(--space-6);
}

.home-error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 56px;
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  border: 1px solid rgba(255, 90, 95, 0.3);
}

.home-error__text {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-label);
  color: var(--color-text-primary);
}

.home-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.home-section + .home-section {
  margin-top: var(--space-6);
}

.home-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.home-section__link {
  font: var(--text-caption);
  color: var(--color-brand-text);
  min-height: 32px;
  display: inline-flex;
  align-items: center;
}

.home-skeleton-row {
  display: flex;
  gap: var(--space-3);
  overflow: hidden;
}

.home-skeleton-card {
  flex: 0 0 auto;
  width: 132px;
}

.home-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin: auto;
  max-width: 300px;
  padding: var(--space-8) var(--space-4);
  text-align: center;
}

.home-empty__title {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.home-empty__desc {
  font: var(--text-label);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.home-empty__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.home-refreshing {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  padding: var(--space-2);
}

/* 错误文案的兜底：无 error.message 时使用映射 */
</style>
