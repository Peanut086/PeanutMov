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
import PosterImage from '@/components/common/PosterImage.vue';
import PosterCard from '@/components/media/PosterCard.vue';
import ContinueWatchingRow from '@/components/media/ContinueWatchingRow.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import IconPlay from '@/components/icons/IconPlay.vue';
import { formatClock } from '@/shared/time';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useToast } from '@/composables/useToast';
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
const initialLoading = computed(
  () => library.homeState === 'idle' || library.homeState === 'loading',
);
const errorMessage = computed(() => localError.value ?? library.homeError?.message ?? null);

const continueItems = computed(() => history.continueWatching.slice(0, 10));
const recentItems = computed(() => library.homeRecent);

/** 继续观看第一项升为 16:9 主卡（一屏内最醒目的入口） */
const heroItem = computed(() => continueItems.value[0] ?? null);
const restContinue = computed(() => continueItems.value.slice(1));
const heroProgress = computed(() => {
  const rec = heroItem.value;
  if (!rec || !rec.durationSec) return 0;
  return Math.min(1, Math.max(0, rec.positionSec / rec.durationSec));
});
const heroMeta = computed(() => {
  const rec = heroItem.value;
  if (!rec) return '';
  const parts: string[] = [];
  if (rec.episodeNumber !== null) parts.push(`第 ${rec.episodeNumber} 集`);
  const remain = Math.max(0, rec.durationSec - rec.positionSec);
  if (remain > 0) parts.push(`剩 ${formatClock(remain)}`);
  return parts.join(' · ');
});

/** 首页横滑流：取前 12 条，避免一次性渲染过多 */
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
        <div class="home-hero home-hero--skeleton">
          <SkeletonPoster />
        </div>
        <section class="home-section">
          <h2 class="section-title">最近添加</h2>
          <div class="home-rail">
            <div v-for="n in 3" :key="`sk-${n}`" class="home-rail__item">
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
        <!-- 继续观看大卡：海报 + 渐变遮罩 + 进度 + 播放按钮 -->
        <button
          v-if="heroItem"
          class="home-hero"
          type="button"
          :aria-label="`继续观看 ${heroItem.title}`"
          @click="continuePlay(heroItem)"
        >
          <PosterImage :src="heroItem.posterUrl" :alt="heroItem.title" :rounded="false" eager />
          <span class="home-hero__scrim" aria-hidden="true" />

          <span class="home-hero__tag">继续观看</span>
          <span class="home-hero__body">
            <span class="home-hero__text">
              <span class="home-hero__title truncate-1">{{ heroItem.title }}</span>
              <span class="home-hero__meta">{{ heroMeta }}</span>
            </span>
            <span class="home-hero__play" aria-hidden="true">
              <IconPlay :size="22" />
            </span>
          </span>
          <span class="home-hero__progress" aria-hidden="true">
            <span :style="{ width: `${heroProgress * 100}%` }" />
          </span>
        </button>

        <section v-if="restContinue.length > 0" class="home-section" aria-labelledby="home-continue">
          <div class="home-section__head">
            <h2 id="home-continue" class="section-title">继续观看</h2>
            <RouterLink class="home-section__link" to="/history">全部历史</RouterLink>
          </div>
          <ContinueWatchingRow
            :items="restContinue"
            @select="continuePlay"
            @remove="removeContinue"
          />
        </section>

        <section class="home-section" aria-labelledby="home-recent">
          <div class="home-section__head">
            <h2 id="home-recent" class="section-title">最近添加</h2>
            <RouterLink class="home-section__link" to="/library">全部内容</RouterLink>
          </div>
          <div class="home-rail">
            <div v-for="item in recentRow" :key="item.id" class="home-rail__item">
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

/* ---------- 继续观看大卡 ---------- */
.home-hero {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 18px;
  overflow: hidden;
  text-align: left;
  background-color: var(--color-bg-surface);
  box-shadow: var(--shadow-2);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.home-hero:active {
  transform: scale(0.99);
}

/* 海报组件默认 2:3，这里改成铺满 16:9 容器 */
.home-hero :deep(.poster-image) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
}

.home-hero--skeleton {
  background-color: var(--color-bg-skeleton);
}

.home-hero--skeleton :deep(.poster-image) {
  position: absolute;
  inset: 0;
  aspect-ratio: auto;
  height: 100%;
}

.home-hero__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.82) 0%, rgba(0, 0, 0, 0.18) 46%, transparent 72%);
  pointer-events: none;
}

.home-hero__tag {
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  height: 20px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  background-color: var(--color-brand-soft);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: var(--color-brand-strong);
  font: var(--font-weight-semibold) 10.5px / 1 var(--font-family-number);
}

.home-hero__body {
  position: absolute;
  left: var(--space-4);
  right: var(--space-4);
  bottom: var(--space-4);
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
}

.home-hero__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.home-hero__title {
  font: var(--font-weight-bold) 18px / 1.25 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
  color: #ffffff;
}

.home-hero__meta {
  font: var(--font-weight-regular) 11.5px / 1.3 var(--font-family-number);
  color: rgba(255, 255, 255, 0.72);
}

.home-hero__play {
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-card);
  background: var(--gradient-brand-cta);
  color: var(--color-brand-ink);
  box-shadow: var(--shadow-brand);
}

.home-hero__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background-color: rgba(255, 255, 255, 0.22);
}

.home-hero__progress > span {
  display: block;
  height: 100%;
  background-color: var(--color-brand);
  border-radius: 0 2px 2px 0;
}

/* ---------- 横滑流 ---------- */
.home-rail {
  display: flex;
  gap: var(--space-3);
  overflow-x: auto;
  scrollbar-width: none;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
  /* 让首尾卡片贴到页面边缘，滚动时不出白边 */
  margin: 0 calc(var(--layout-page-padding-x) * -1);
  padding: 0 var(--layout-page-padding-x);
}

.home-rail::-webkit-scrollbar {
  display: none;
}

.home-rail__item {
  flex: 0 0 auto;
  width: 104px;
  scroll-snap-align: start;
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
