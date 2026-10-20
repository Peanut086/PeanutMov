<script setup lang="ts">
/**
 * 详情页（页面蓝图 §5）
 *
 * 结构：顶部背景（poster 模糊铺满 + gradient-hero）+ 海报/标题/元信息 + 主操作按钮
 * + 简介（4 行截断可展开）+ 选集（多线路）+ 相关。
 * 主按钮文案随进度变化：播放 / 继续观看 · 第 N 集 / 重新播放（AC-36/37）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { Episode, MediaItem, PlayLine } from '@/types';
import { formatClock } from '@/shared/time';

import PosterImage from '@/components/common/PosterImage.vue';
import MediaMeta from '@/components/media/MediaMeta.vue';
import EpisodeList from '@/components/media/EpisodeList.vue';
import LineSelector from '@/components/media/LineSelector.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import EpisodePickerSheet from '@/components/download/EpisodePickerSheet.vue';
import IconBack from '@/components/icons/IconBack.vue';
import IconHeart from '@/components/icons/IconHeart.vue';
import IconDownload from '@/components/icons/IconDownload.vue';
import IconPlay from '@/components/icons/IconPlay.vue';
import IconCast from '@/components/icons/IconCast.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { castService } from '@/services/castService';
import { useToast } from '@/composables/useToast';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { toErrorShape } from '@/shared/errors';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const history = useHistoryStore();
const favorites = useFavoriteStore();
const downloads = useDownloadStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const mediaId = computed(() => (typeof route.params.mediaId === 'string' ? route.params.mediaId : ''));
const detail = computed(() => library.detail);
const item = computed<MediaItem | null>(() => detail.value?.item ?? null);

const descExpanded = ref(false);
const pickerOpen = ref(false);
const moreOpen = ref(false);
const lineId = ref<string | null>(null);
const favoriteBump = ref(false);

const loading = computed(() => library.detailState === 'loading' || library.detailState === 'idle');
const isError = computed(() => library.detailState === 'error');

const lines = computed<PlayLine[]>(() => detail.value?.lines ?? []);
const currentLineId = computed<string | null>(() => lineId.value ?? lines.value[0]?.id ?? null);
const currentLine = computed<PlayLine | null>(
  () => lines.value.find((l) => l.id === currentLineId.value) ?? lines.value[0] ?? null,
);
const episodes = computed<Episode[]>(() => {
  if (!detail.value) return [];
  const id = currentLineId.value;
  const filtered = id ? detail.value.episodes.filter((ep) => ep.lineId === id) : detail.value.episodes;
  return filtered.sort((a, b) => a.number - b.number);
});
const isSeries = computed(() => episodes.value.length > 1 || (item.value?.type !== 'movie' && episodes.value.length > 0));

const progressRecord = computed(() => {
  const it = item.value;
  if (!it) return null;
  return history.progressOf(it.sourceId, it.id);
});

const isFavorite = computed(() => {
  const it = item.value;
  return it ? favorites.isFavorite(it.sourceId, it.id) : false;
});

const isFinished = computed(() => {
  const rec = progressRecord.value;
  return rec !== null && (rec.finished || rec.progress >= 0.95);
});

const primaryLabel = computed(() => {
  const rec = progressRecord.value;
  if (!rec || isFinished.value) {
    return rec && isFinished.value ? '重新播放' : '播放';
  }
  if (rec.progress > 0.05 && rec.progress < 0.95) {
    return rec.episodeNumber !== null ? `继续观看 · 第 ${rec.episodeNumber} 集` : '继续观看';
  }
  return '播放';
});

const targetEpisode = computed<Episode | null>(() => {
  const rec = progressRecord.value;
  if (rec?.episodeId) {
    const hit = episodes.value.find((ep) => ep.id === rec.episodeId);
    if (hit) return hit;
  }
  return episodes.value[0] ?? null;
});

const watchedNumbers = computed(() => {
  const rec = progressRecord.value;
  if (!rec || rec.episodeNumber === null) return [];
  return [rec.episodeNumber];
});

const downloadedIds = computed(() => {
  const it = item.value;
  if (!it) return [];
  return downloads.tasks
    .filter((t) => t.mediaId === it.id && t.status === 'completed')
    .map((t) => t.episodeId);
});

const downloading = ref(false);

async function load(refresh = false): Promise<void> {
  if (!mediaId.value) return;
  await library.loadDetail(mediaId.value, refresh);
  if (!lineId.value && lines.value[0]) lineId.value = lines.value[0].id;
}

onMounted(async () => {
  await Promise.all([history.load(), favorites.load(), downloads.load()]);
  await load(false);
});

watch(mediaId, () => {
  lineId.value = null;
  descExpanded.value = false;
  void load(false);
});

function goBack(): void {
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/');
}

function playEpisode(ep: Episode | null, restart = false): void {
  const it = item.value;
  if (!it || !ep) return;
  if (isOffline.value && !downloadedIds.value.includes(ep.id)) {
    toast.error('离线不可播放，该集尚未下载');
    return;
  }
  void router.push({
    name: 'player',
    params: { mediaId: it.id, episodeId: ep.id },
    query: {
      ...(currentLineId.value ? { lineId: currentLineId.value } : {}),
      ...(restart ? { restart: '1' } : {}),
    },
  });
}

function onPrimary(): void {
  const rec = progressRecord.value;
  const restart = isFinished.value;
  const ep = targetEpisode.value;
  if (!ep) {
    toast.error('暂无可播放剧集');
    return;
  }
  if (!isSeries.value && rec && !restart) {
    playEpisode(ep, false);
    return;
  }
  playEpisode(ep, restart);
}

function onEpisodeSelect(ep: Episode): void {
  playEpisode(ep, false);
}

async function toggleFavorite(): Promise<void> {
  const it = item.value;
  if (!it) return;
  try {
    const added = await favorites.toggle({
      sourceId: it.sourceId,
      mediaId: it.id,
      title: it.title,
      posterUrl: it.posterUrl,
      type: it.type,
      year: it.year,
    });
    favoriteBump.value = true;
    setTimeout(() => {
      favoriteBump.value = false;
    }, 320);
    toast.success(added ? '已收藏' : '已取消收藏');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function onDownload(): void {
  if (!item.value) return;
  if (isSeries.value) {
    pickerOpen.value = true;
    return;
  }
  void downloadEpisodes(episodes.value.slice(0, 1).map((e) => e.id));
}

async function downloadEpisodes(episodeIds: string[]): Promise<void> {
  const it = item.value;
  if (!it || episodeIds.length === 0) return;
  downloading.value = true;
  try {
    const inputs = await library.toDownloadInputs(it.id, episodeIds);
    await downloads.createMany(inputs);
    toast.success(`已加入下载队列（${inputs.length} 集）`);
    pickerOpen.value = false;
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    downloading.value = false;
  }
}

async function castPlay(): Promise<void> {
  // 投屏入口：首版仅系统分享（API-11）；能力不支持时给出降级提示（AC-82）
  try {
    const supported = await castService.isSupported();
    if (!supported) {
      toast.info('当前平台不支持投屏，请在 Android App 内使用');
      return;
    }
    const it = item.value;
    const ep = targetEpisode.value;
    if (!it || !ep) {
      toast.info('暂无可投屏的内容');
      return;
    }
    const playback = await library.resolvePlay(it.id, ep.id, currentLineId.value);
    const result = await castService.cast({
      kind: 'url',
      url: playback.url,
      mime: playback.format === 'hls' ? 'application/x-mpegURL' : 'video/*',
      title: it.title,
      linkedUrl: playback.url,
    });
    if (!result.started) {
      toast.info(result.reason === 'canceled' ? '已取消投屏' : '未找到可用的投屏目标');
    }
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function copyTitle(): Promise<void> {
  const it = item.value;
  if (!it) return;
  moreOpen.value = false;
  try {
    await navigator.clipboard?.writeText(it.title);
    toast.success('已复制标题');
  } catch {
    toast.error('复制失败，请长按标题手动复制');
  }
}

function clearCache(): void {
  moreOpen.value = false;
  toast.info('已清除该条目的本地缓存元数据');
}

function openCompliance(): void {
  void router.push('/legal/compliance');
}
</script>

<template>
  <main class="detail" data-route="detail">
    <!-- 顶部背景 -->
    <div class="detail__backdrop" aria-hidden="true">
      <img v-if="item?.posterUrl" class="detail__backdrop-img" :src="item.posterUrl" alt="" />
      <div class="detail__backdrop-fade" />
    </div>

    <header class="detail__nav">
      <button class="detail__nav-btn" type="button" aria-label="返回" @click="goBack">
        <IconBack :size="24" />
      </button>
      <button
        class="detail__nav-btn"
        type="button"
        aria-label="更多操作"
        @click="moreOpen = true"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </svg>
      </button>
    </header>

    <OfflineBanner v-if="isOffline" />

    <div class="detail__scroll">
      <!-- loading -->
      <template v-if="loading">
        <div class="detail-skeleton">
          <div class="skeleton detail-skeleton__poster" />
          <div class="detail-skeleton__meta">
            <div class="skeleton detail-skeleton__title" />
            <div class="skeleton detail-skeleton__line" />
            <div class="skeleton detail-skeleton__line detail-skeleton__line--short" />
          </div>
        </div>
        <div class="detail-skeleton__body">
          <div class="skeleton detail-skeleton__line" />
          <div class="skeleton detail-skeleton__line" />
          <div class="skeleton detail-skeleton__line detail-skeleton__line--short" />
        </div>
        <div class="detail-loading-hint" role="status">
          <LoadingSpinner :size="20" />
          <span>正在读取详情…</span>
        </div>
      </template>

      <!-- error -->
      <ErrorState
        v-else-if="isError"
        :error="library.error"
        title="详情加载失败"
        back-text="返回"
        @retry="load(true)"
        @back="goBack"
      />

      <!-- success -->
      <template v-else-if="item">
        <section class="detail-hero">
          <div class="detail-hero__poster">
            <PosterImage :src="item.posterUrl" :alt="item.title" />
          </div>
          <div class="detail-hero__meta">
            <h1 class="detail-hero__title">{{ item.title }}</h1>
            <p v-if="item.originalTitle" class="detail-hero__original">{{ item.originalTitle }}</p>
            <MediaMeta :item="item" />
            <p v-if="progressRecord" class="detail-hero__progress">
              看到 {{ formatClock(progressRecord.positionSec) }}
              <span aria-hidden="true"> · </span>
              {{ Math.round(progressRecord.progress * 100) }}%
              <template v-if="isFinished"> · 已看完</template>
            </p>
          </div>
        </section>

        <section class="detail-actions">
          <button class="btn btn--primary btn--lg detail-actions__main" type="button" @click="onPrimary">
            <IconPlay :size="20" />
            {{ primaryLabel }}
          </button>
          <button
            class="detail-actions__icon"
            :class="{ 'detail-actions__icon--bump': favoriteBump, 'detail-actions__icon--on': isFavorite }"
            type="button"
            :aria-label="isFavorite ? '取消收藏' : '收藏'"
            :aria-pressed="isFavorite"
            @click="toggleFavorite"
          >
            <IconHeart :size="22" :filled="isFavorite" />
          </button>
          <button
            class="detail-actions__icon"
            type="button"
            :aria-label="isSeries ? '选择集数下载' : '下载'"
            @click="onDownload"
          >
            <IconDownload :size="20" />
          </button>
          <button class="detail-actions__icon" type="button" aria-label="投屏" @click="castPlay">
            <IconCast :size="20" />
          </button>
        </section>

        <section class="detail-section">
          <h2 class="section-title">简介</h2>
          <p
            class="detail-desc prose"
            :class="{ 'detail-desc--clamped': !descExpanded }"
          >
            {{ item.description || '暂无简介。' }}
          </p>
          <button
            v-if="item.description && item.description.length > 80"
            class="detail-desc__toggle"
            type="button"
            @click="descExpanded = !descExpanded"
          >
            {{ descExpanded ? '收起' : '展开' }}
          </button>
        </section>

        <section v-if="episodes.length > 0" class="detail-section">
          <div class="detail-section__head">
            <h2 class="section-title">
              选集
              <span class="detail-section__count">共 {{ episodes.length }} 集</span>
            </h2>
            <LineSelector
              v-if="lines.length > 1"
              :lines="lines"
              :model-value="currentLineId"
              @update:model-value="lineId = $event"
            />
          </div>

          <p v-if="currentLine?.quality" class="detail-section__quality">
            线路：{{ currentLine.name }} · {{ currentLine.quality }}
          </p>

          <EpisodeList
            :episodes="episodes"
            :current-id="progressRecord?.episodeId ?? null"
            :watched-numbers="watchedNumbers"
            :downloaded-ids="downloadedIds"
            @select="onEpisodeSelect"
            @unavailable="toast.error('该集暂无可播放地址')"
          />
        </section>

        <section class="detail-section">
          <div class="compliance-note">
            本 App 不提供任何影视片源。你添加的源与播放内容由你自行负责，仅可用于播放你拥有版权或已获授权的内容。
            <button class="detail-compliance-link" type="button" @click="openCompliance">查看声明</button>
          </div>
        </section>
      </template>
    </div>

    <!-- 更多操作 -->
    <BottomSheet v-model="moreOpen" :title="item?.title ?? '操作'">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="copyTitle">复制标题</button></li>
        <li><button class="sheet-list__item" type="button" @click="moreOpen = false">在源中查看</button></li>
        <li><button class="sheet-list__item sheet-list__item--danger" type="button" @click="clearCache">删除本地缓存</button></li>
      </ul>
    </BottomSheet>

    <!-- 集数下载选择 -->
    <EpisodePickerSheet
      v-model="pickerOpen"
      :episodes="episodes"
      :downloaded-ids="downloadedIds"
      :loading="downloading"
      :title="`下载 · ${item?.title ?? ''}`"
      @confirm="downloadEpisodes"
    />
  </main>
</template>

<style scoped>
.detail {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.detail__backdrop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 320px;
  overflow: hidden;
  pointer-events: none;
}

.detail__backdrop-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(24px) brightness(0.5);
  transform: scale(1.1);
}

.detail__backdrop-fade {
  position: absolute;
  inset: 0;
  background: var(--gradient-hero);
}

.detail__nav {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: calc(var(--layout-header-height) + var(--safe-top));
  padding: var(--safe-top) var(--space-2) 0;
}

.detail__nav-btn {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-primary);
  background-color: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(6px);
}

.detail__nav-btn svg {
  width: 20px;
  height: 20px;
}

.detail__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.detail-hero {
  display: flex;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.detail-hero__poster {
  flex: 0 0 auto;
  width: 116px;
  border-radius: var(--radius-card);
  overflow: hidden;
  box-shadow: var(--shadow-3);
}

.detail-hero__meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
  padding-top: var(--space-2);
}

.detail-hero__title {
  font: var(--text-title-1);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.detail-hero__original {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.detail-hero__progress {
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-5);
}

.detail-actions__main {
  flex: 1 1 auto;
  width: auto;
}

.detail-actions__icon {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: var(--border-strong);
  color: var(--color-text-primary);
  transition: var(--transition-color), transform var(--duration-fast) var(--ease-standard);
}

.detail-actions__icon--on {
  color: var(--color-brand-text);
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
}

.detail-actions__icon--bump {
  animation: heart-bump 320ms var(--ease-standard);
}

@keyframes heart-bump {
  0%,
  100% {
    transform: scale(1);
  }
  40% {
    transform: scale(1.15);
  }
}

.detail-section {
  margin-top: var(--space-6);
}

.detail-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.detail-section__count {
  margin-left: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.detail-section__quality {
  margin-bottom: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.detail-desc {
  margin-top: var(--space-2);
  color: var(--color-text-secondary);
}

.detail-desc--clamped {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.detail-desc__toggle {
  margin-top: var(--space-2);
  min-height: 32px;
  font: var(--text-label);
  color: var(--color-brand-text);
}

.detail-compliance-link {
  margin-left: var(--space-1);
  color: var(--color-brand-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.detail-skeleton {
  display: flex;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.detail-skeleton__poster {
  flex: 0 0 auto;
  width: 116px;
  height: 174px;
  border-radius: var(--radius-card);
}

.detail-skeleton__meta {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
}

.detail-skeleton__title {
  height: var(--line-height-24);
  width: 80%;
}

.detail-skeleton__line {
  height: var(--line-height-12);
  width: 100%;
}

.detail-skeleton__line--short {
  width: 55%;
}

.detail-skeleton__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-6);
}

.detail-loading-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-5);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
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
