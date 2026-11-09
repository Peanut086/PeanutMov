<script setup lang="ts">
/**
 * 首页（页面蓝图 §2）
 *
 * 信息层级：继续观看（compact 水平条，无数据整块不渲染）→ 最近添加（3 列网格）。
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
import PosterCard from '@/components/media/PosterCard.vue';
import ContinueWatchingRow from '@/components/media/ContinueWatchingRow.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import PullToRefresh from '@/components/common/PullToRefresh.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useToast } from '@/composables/useToast';
import { appEvents } from '@/services/events';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { toErrorShape } from '@/shared/errors';

defineOptions({ name: 'HomeView' });

const router = useRouter();
const history = useHistoryStore();
const library = useLibraryStore();
const sources = useSourceStore();
const downloads = useDownloadStore();
const favorites = useFavoriteStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const localError = ref<string | null>(null);
const pullRefreshing = ref(false);
const initialLoading = computed(
  () => library.homeState === 'idle' || library.homeState === 'loading',
);
const errorMessage = computed(() => localError.value ?? library.homeError?.message ?? null);

const continueItems = computed(() => history.continueWatching.slice(0, 10));
const recentItems = computed(() => library.homeRecent);

/** 首页网格：取前 12 条，避免一次性渲染过多 */
const recentRow = computed(() => recentItems.value.slice(0, 12));

const downloadedIds = computed(() =>
  downloads.tasks.filter((t) => t.status === 'completed').map((t) => t.mediaId),
);

const isEmpty = computed(
  () => !initialLoading.value && recentItems.value.length === 0 && continueItems.value.length === 0,
);

/**
 * 首页无内容/报错时，判断「是不是当前源的问题」。
 *
 * 首页「最近添加」读跨源缓存，只有回源当前源才可能暴露源故障；因此这里按
 * 「当前源已禁用或健康状态非 ok」来判定，给用户「换源」而非笼统的「还没有内容」。
 */
const sourceLooksBroken = computed(() => {
  const source = sources.currentSource;
  if (!source) return false;
  return !source.enabled || source.health === 'unreachable' || source.health === 'bad_config';
});

// OPT-24: 首页加载 TTL（30s 内回 tab 不重复读库，事件驱动失效）
const TTL_MS = 30_000;
let lastLoadTime = 0;
let isDirty = true;

// 监听失效事件
appEvents.on('downloads:changed', () => { isDirty = true; });
appEvents.on('favorites:changed', () => { isDirty = true; });
appEvents.on('history:changed', () => { isDirty = true; });

async function load(): Promise<void> {
  const now = Date.now();
  // OPT-24: TTL 内且未脏则跳过
  if (!isDirty && now - lastLoadTime < TTL_MS) {
    return;
  }
  localError.value = null;
  try {
    // REV-24：sources 用于 continuePlay 判断源是否存在
    await Promise.all([history.load(), downloads.load(), favorites.load(), sources.load()]);
    await library.loadHome();
    lastLoadTime = now;
    isDirty = false;
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

/** REV-24：判断该历史记录的源是否已被移除 */
function isSourceRemoved(rec: HistoryRecord): boolean {
  return !sources.sources.some((s) => s.id === rec.sourceId);
}

function continuePlay(rec: HistoryRecord): void {
  // REV-24：源已移除时拦截，避免跳到播放页才发现 404
  if (isSourceRemoved(rec)) {
    toast.error('无法播放，源已移除');
    return;
  }
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

function openDouban(): void {
  void router.push('/douban');
}

function openSearch(): void {
  void router.push('/search');
}

async function retry(): Promise<void> {
  await load();
  if (!errorMessage.value) toast.success('已刷新');
}

async function onPullRefresh(): Promise<void> {
  pullRefreshing.value = true;
  try {
    await load();
  } finally {
    pullRefreshing.value = false;
  }
}
</script>

<template>
  <SafeArea tabbar data-route="home">
    <AppHeader title="PeanutMov" brand search @search="openSearch" />

    <PullToRefresh :loading="pullRefreshing" @refresh="onPullRefresh">
    <div class="home-body">
      <OfflineBanner v-if="isOffline" />

      <!-- error：顶部错误卡，已有缓存仍展示 -->
      <div v-if="errorMessage" class="home-error" role="alert">
        <span class="home-error__text">{{ errorMessage }}</span>
        <button class="btn btn--secondary btn--sm" type="button" @click="retry">重试</button>
        <button
          v-if="sourceLooksBroken"
          class="btn btn--secondary btn--sm"
          type="button"
          @click="goLibrary"
        >
          换源
        </button>
      </div>

      <!-- loading 骨架 -->
      <template v-if="initialLoading">
        <section class="home-section">
          <h2 class="section-title">继续观看</h2>
          <div class="home-skeleton-compact">
            <div v-for="n in 3" :key="`sk-cw-${n}`" class="home-skeleton-compact__item skeleton" />
          </div>
        </section>
        <section class="home-section">
          <h2 class="section-title">最近添加</h2>
          <div class="home-grid">
            <div v-for="n in 6" :key="`sk-${n}`" class="home-grid__item">
              <SkeletonPoster />
            </div>
          </div>
        </section>
      </template>

      <!-- empty -->
      <div v-else-if="isEmpty" class="home-empty">
        <h2 class="home-empty__title">{{ sourceLooksBroken ? '当前源没有内容' : '还没有内容' }}</h2>
        <p class="home-empty__desc">
          {{
            sourceLooksBroken
              ? '当前源可能已失效或没有可浏览的内容。可以切换到其他源，或到源管理检查该源状态。'
              : '添加一个你自己的源（NAS / AList / Jellyfin / 站点）后，内容会出现在这里。'
          }}
        </p>
        <div class="home-empty__actions">
          <button class="btn btn--primary btn--md" type="button" @click="goLibrary">
            {{ sourceLooksBroken ? '去媒体库换源' : '去媒体库看看' }}
          </button>
          <button class="btn btn--secondary btn--md" type="button" @click="retry">刷新</button>
        </div>
      </div>

      <!-- success -->
      <template v-else>
        <!-- 继续观看：紧凑水平条模式（OPT-04） -->
        <section v-if="continueItems.length > 0" class="home-section" aria-labelledby="home-continue">
          <div class="home-section__head">
            <h2 id="home-continue" class="section-title">继续观看</h2>
            <RouterLink class="home-section__link" to="/history">全部历史</RouterLink>
          </div>
          <ContinueWatchingRow
            :items="continueItems"
            compact
            @select="continuePlay"
            @remove="removeContinue"
          />
        </section>

        <section class="home-section" aria-labelledby="home-recent">
          <div class="home-section__head">
            <h2 id="home-recent" class="section-title">最近添加</h2>
            <RouterLink class="home-section__link" to="/library">全部内容</RouterLink>
          </div>
          <div class="home-grid">
            <div
              v-for="(item, idx) in recentRow"
              :key="item.id"
              class="home-grid__item"
              :style="{ '--i': idx }"
            >
              <PosterCard
                :item="item"
                :downloaded="downloadedIds.includes(item.id)"
                @select="openDetail"
              />
            </div>
          </div>
          <p v-if="library.homeState === 'refreshing'" class="home-refreshing">
            <LoadingSpinner :size="16" />
            正在刷新…
          </p>
        </section>

        <!-- 豆瓣榜单榜单 榜单榜入口 -->
        <section class="home-section" aria-labelledby="home-douban">
          <button class="home-douban-banner" type="button" @click="openDouban">
            <span class="home-douban-banner__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M12 2.4l2.95 6.03 6.6.96-4.78 4.7 1.13 6.6L12 17.77l-5.9 3.02 1.13-6.6L2.45 9.39l6.6-.96L12 2.4z" />
              </svg>
            </span>
            <span class="home-douban-banner__text">
              <span id="home-douban" class="home-douban-banner__title">豆瓣榜单 榜单榜</span>
              <span class="home-douban-banner__desc">豆瓣 Top250 · 正在热映 · 热门剧集</span>
            </span>
            <span class="home-douban-banner__arrow" aria-hidden="true">›</span>
          </button>
        </section>
      </template>
    </div>
    </PullToRefresh>
  </SafeArea>
</template>

<style scoped>
.home-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) var(--layout-tabbar-safe);
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
  border: 1px solid var(--color-danger-border);
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

/* ---------- 最近添加 3 列网格（OPT-04） ---------- */
.home-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

.home-grid__item {
  min-width: 0;
  animation: card-enter 250ms var(--ease-decelerate) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

@keyframes card-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 继续观看 compact 骨架 */
.home-skeleton-compact {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.home-skeleton-compact__item {
  height: 72px;
  border-radius: var(--radius-card);
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
  animation: empty-breathe 3s var(--ease-standard) infinite;
}

@keyframes empty-breathe {
  0%, 100% {
    opacity: 1;
    transform: translateY(0);
  }
  50% {
    opacity: 0.92;
    transform: translateY(-3px);
  }
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

/* ---------- 豆瓣榜单入口横幅 ---------- */
.home-douban-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 60px;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-card);
  background: linear-gradient(135deg, var(--color-douban-soft) 0%, var(--color-douban-gradient-start) 100%);
  border: 1px solid var(--color-douban-border);
  transition: transform var(--duration-fast) var(--ease-standard), background-color var(--duration-fast);
  text-align: left;
}

.home-douban-banner:active {
  transform: scale(0.985);
  background: linear-gradient(135deg, var(--color-douban-press) 0%, var(--color-douban-soft) 100%);
}

.home-douban-banner__icon {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background-color: var(--color-douban-soft);
  color: var(--color-douban);
}

.home-douban-banner__text {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.home-douban-banner__title {
  font: var(--font-weight-semibold) 14px / 1.3 var(--font-family-base);
  color: var(--color-text-primary);
}

.home-douban-banner__desc {
  font: var(--font-weight-regular) 11.5px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.home-douban-banner__arrow {
  flex: 0 0 auto;
  font: var(--font-weight-semibold) 20px / 1 var(--font-family-number);
  color: var(--color-text-tertiary);
}

/* 错误文案的兜底：无 error.message 时使用映射 */

@media (prefers-reduced-motion: reduce) {
  .home-empty,
  .home-grid__item {
    animation: none;
  }
}
</style>
