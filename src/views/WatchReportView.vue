<script setup lang="ts">
/**
 * 观影报告（D2）
 *
 * 全部数据来自本地 `history` 表 + 媒体缓存，不回源、不联网。
 * 口径两处必须写清楚（见 shared/watchReport 的说明）：
 * 时长是**估算**，月度分布按**最后一次观看**归月。
 *
 * 视觉：放映室报告单——放映灯琥珀为主色，图表取幕布红/银幕青等 7 个可分辨色相，
 * 「其它/未分类」恒为中性灰；每一项都带直接标签与数值，不靠颜色单独承载信息。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Share } from '@capacitor/share';

import type { AppErrorShape, MediaType } from '@/types';
import {
  REPORT_MONTH_WINDOW,
  almostFinished,
  buildWatchReport,
  estimatedWatchSeconds,
  filterTitles,
  formatReportText,
  type ReportMeta,
  type ReportSlice,
  type TasteDimension,
  type TasteMeasure,
  type TitleFilter,
} from '@/shared/watchReport';
import { formatDuration, formatProgress, formatRelativeTime, formatRemaining } from '@/shared/time';
import { toErrorShape } from '@/shared/errors';
import { isNative } from '@/shared/platform';
import { mediaTypeLabel, toPercent } from '@/components/common/format';
import { prefersReducedMotion } from '@/composables/useSpring';
import { useToast } from '@/composables/useToast';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import PosterImage from '@/components/common/PosterImage.vue';
import { IMG_W_COMPACT, IMG_W_INLINE } from '@/shared/imageSize';

import { useHistoryStore } from '@/stores/historyStore';
import { useSourceStore } from '@/stores/sourceStore';
import { libraryService } from '@/services/libraryService';

const router = useRouter();
const history = useHistoryStore();
const sources = useSourceStore();
const toast = useToast();

const building = ref(true);
const loadError = ref<AppErrorShape | null>(null);
const metaMap = ref(new Map<string, ReportMeta>());
const animatedHours = ref(0);
/** 环从 0 扫到实际完播率：首帧直接给终值的话 CSS 过渡不会触发 */
const ringRate = ref(0);

const dimension = ref<TasteDimension>('type');
const measure = ref<TasteMeasure>('count');
const selectedMonth = ref<string | null>(null);
const titleFilter = ref<TitleFilter>('all');
const visibleCount = ref(12);

const DIMENSION_OPTIONS = [
  { value: 'type', label: '类型' },
  { value: 'genre', label: '题材' },
  { value: 'area', label: '地区' },
];
const MEASURE_OPTIONS = [
  { value: 'count', label: '部数' },
  { value: 'seconds', label: '时长' },
];
const FILTER_OPTIONS: Array<{ value: TitleFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'finished', label: '已看完' },
  { value: 'watching', label: '没看完' },
];

const sourceNames = computed(() => new Map(sources.sources.map((s) => [s.id, s.name])));
const report = computed(() =>
  buildWatchReport({
    records: history.items,
    meta: metaMap.value,
    sourceNames: sourceNames.value,
  }),
);

const isEmpty = computed(() => !building.value && report.value.totalRecords === 0);
const tasteSlices = computed(() => rankedByMeasure(report.value.taste[dimension.value]));
const nearlyDone = computed(() => almostFinished(report.value.titles));

function measureValue(slice: { count: number; seconds: number }): number {
  return measure.value === 'count' ? slice.count : slice.seconds;
}

/** 榜单按当前口径重排；合并项恒在末尾。sort 稳定，同值时保留聚合层的次级排序 */
function rankedByMeasure(slices: ReportSlice[]): ReportSlice[] {
  const head = slices.filter((s) => s.key !== '__rest');
  head.sort((a, b) => measureValue(b) - measureValue(a));
  return [...head, ...slices.filter((s) => s.key === '__rest')];
}

/** 图表行内的紧凑时长：`formatDuration` 的「1 小时 20 分钟」在 360px 行里会把片名挤没 */
function compactDuration(sec: number): string {
  const hours = sec / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(sec / 60))} 分`;
  return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} 小时`;
}

const tasteMax = computed(() => Math.max(1, ...tasteSlices.value.map(measureValue)));
const monthMax = computed(() => Math.max(1, ...report.value.months.map(measureValue)));
const sourceMax = computed(() => Math.max(1, ...report.value.sources.map(measureValue)));
const rankedSources = computed(() => rankedByMeasure(report.value.sources));

const filteredTitles = computed(() =>
  filterTitles(report.value.titles, titleFilter.value, selectedMonth.value),
);
const shownTitles = computed(() => filteredTitles.value.slice(0, visibleCount.value));

const hoursText = computed(() => {
  const hours = animatedHours.value;
  return hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1);
});

const monthCaption = computed(() => {
  const months = report.value.months;
  const picked = selectedMonth.value ? months.find((m) => m.key === selectedMonth.value) : null;
  if (picked) {
    return `${picked.label} · ${picked.count} 部 · 约 ${formatDuration(picked.seconds)}`;
  }
  const busiest = [...months].sort((a, b) => b.count - a.count)[0];
  if (!busiest || busiest.count === 0) return `最近 ${REPORT_MONTH_WINDOW} 个月还没有观看记录`;
  return `最活跃 ${busiest.label}（${busiest.count} 部）· 点柱子可筛选下方片单`;
});

const tasteNote = computed(() => {
  if (dimension.value === 'genre') {
    return report.value.unknownMetaCount > 0
      ? `一部片可属多个题材，占比之和可能超过 100%。${report.value.unknownMetaCount} 条记录的媒体缓存已清理，归入「未分类」。`
      : '一部片可属多个题材，占比之和可能超过 100%。';
  }
  if (dimension.value === 'type') return '类型取自媒体缓存，缓存缺失时退回历史快照。';
  return '地区取自媒体缓存，未标注的条目单独成项。';
});

function sliceLabel(slice: ReportSlice): string {
  return dimension.value === 'type' && !slice.key.startsWith('__')
    ? mediaTypeLabel(slice.key as MediaType)
    : slice.label;
}

function shareOf(slice: ReportSlice): number {
  return measure.value === 'count' ? slice.share : slice.secondsShare;
}

/** 非零项四舍五入成 0% 会被当成算错了，不足 1% 明说 */
function shareText(slice: ReportSlice): string {
  const percent = toPercent(shareOf(slice));
  return percent === 0 && measureValue(slice) > 0 ? '<1%' : `${percent}%`;
}

/** 「其它 / 未分类 / 未标注 / 未识别」恒为中性灰，避免和真实类别抢注意力 */
function sliceColor(slice: ReportSlice, index: number): string {
  return slice.key.startsWith('__') ? 'var(--rp-neutral)' : `var(--rp-${(index % 7) + 1})`;
}

function sliceValueText(slice: ReportSlice): string {
  return measure.value === 'count' ? `${slice.count} 部` : compactDuration(slice.seconds);
}

function monthValueText(month: { count: number; seconds: number }): string {
  if (measure.value === 'count') return String(month.count);
  const hours = month.seconds / 3600;
  if (hours <= 0) return '0';
  return hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1);
}

/* ---------- 元数据补齐：只查缓存，缺就缺，不回源 ---------- */
async function loadMeta(): Promise<void> {
  const missing = [...new Set(history.items.map((r) => r.mediaId))].filter(
    (id) => !metaMap.value.has(id),
  );
  if (missing.length === 0) return;

  const next = new Map(metaMap.value);
  const CHUNK = 16;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const batch = missing.slice(i, i + CHUNK);
    const items = await Promise.all(
      batch.map((id) => libraryService.getItem(id).catch(() => null)),
    );
    for (const item of items) {
      if (!item) continue;
      next.set(item.id, { type: item.type, genres: item.genres, area: item.area });
    }
  }
  metaMap.value = next;
}

async function load(): Promise<void> {
  building.value = true;
  loadError.value = null;
  try {
    await Promise.all([history.load(), sources.load()]);
    if (history.error) loadError.value = history.error;
    else await loadMeta();
  } catch (e) {
    loadError.value = toErrorShape(e, 'E_DB');
  } finally {
    building.value = false;
    await nextTick();
    setupReveal();
  }
}

onMounted(load);
// 播放页回来 / 其它页写入历史后，store 会刷新 items，这里只补缺失的那几条元数据
watch(() => history.items.length, () => void loadMeta());

/* ---------- 进场：数字滚动 + 分段 reveal ---------- */
let countRaf = 0;

function runCountUp(target: number): void {
  if (countRaf !== 0) {
    cancelAnimationFrame(countRaf);
    countRaf = 0;
  }
  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    animatedHours.value = target;
    return;
  }
  const from = animatedHours.value;
  const startedAt = Date.now();
  const DURATION = 900;
  const step = (): void => {
    const t = Math.min(1, (Date.now() - startedAt) / DURATION);
    animatedHours.value = from + (target - from) * (1 - (1 - t) ** 3);
    if (t < 1) countRaf = requestAnimationFrame(step);
    else countRaf = 0;
  };
  countRaf = requestAnimationFrame(step);
}

watch(() => report.value.estimatedSeconds, (sec) => runCountUp(sec / 3600), { immediate: true });
watch(
  () => report.value.completionRate,
  async (rate) => {
    await nextTick();
    ringRate.value = rate;
  },
  { immediate: true },
);

const scroller = ref<HTMLElement | null>(null);
let revealObserver: IntersectionObserver | null = null;

function setupReveal(): void {
  const root = scroller.value;
  if (!root) return;
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
  revealObserver?.disconnect();
  revealObserver = null;
  if (prefersReducedMotion() || typeof IntersectionObserver !== 'function') {
    nodes.forEach((node) => node.setAttribute('data-reveal', 'in'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-reveal', 'in');
        observer.unobserve(entry.target);
      }
    },
    // 应用外壳是 document 滚动（.app-root 只有 min-height），拿 root 当观察框会让整页立刻判定可见
    { rootMargin: '0px 0px -40px 0px', threshold: 0.01 },
  );
  nodes.forEach((node) => observer.observe(node));
  revealObserver = observer;
}

onBeforeUnmount(() => {
  if (countRaf !== 0) cancelAnimationFrame(countRaf);
  countRaf = 0;
  revealObserver?.disconnect();
  revealObserver = null;
});

/* ---------- 交互 ---------- */
function pickMonth(key: string): void {
  selectedMonth.value = selectedMonth.value === key ? null : key;
}

watch([titleFilter, selectedMonth], () => {
  visibleCount.value = 12;
});

function isSourceRemoved(sourceId: string): boolean {
  return !sources.sources.some((s) => s.id === sourceId);
}

function openDetail(mediaId: string, sourceId: string): void {
  void router.push({ name: 'detail', params: { mediaId }, query: { sourceId } });
}

function resume(mediaId: string, sourceId: string, episodeId: string | null): void {
  if (isSourceRemoved(sourceId)) {
    toast.error('无法播放，源已移除');
    return;
  }
  void router.push({
    name: 'player',
    params: { mediaId, ...(episodeId ? { episodeId } : {}) },
  });
}

async function shareReport(): Promise<void> {
  const text = formatReportText(report.value, (key) => mediaTypeLabel(key as MediaType));
  if (isNative()) {
    try {
      await Share.share({ title: 'PeanutMov 观影报告', text, dialogTitle: '分享观影报告' });
      return;
    } catch {
      // 分享面板取消或无可用应用：落到剪贴板，用户至少拿到可粘贴的报告
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success('报告已复制到剪贴板');
  } catch {
    toast.error('复制失败，请手动截图分享');
  }
}

function goLibrary(): void {
  void router.push('/library');
}

function goBack(): void {
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/settings');
}

/** 完播率环：周长归一到 100，dashoffset 直接用百分数 */
const ringOffset = computed(() => 100 - toPercent(ringRate.value));
</script>

<template>
  <main class="report-page" data-route="report">
    <AppHeader title="观影报告" back @back="goBack">
      <template #actions>
        <button
          class="report-share"
          type="button"
          :disabled="building || report.totalRecords === 0"
          aria-label="分享观影报告"
          @click="shareReport"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 15.5V4.2" />
            <path d="m8.2 8 3.8-3.8L15.8 8" />
            <path d="M5.4 13.4v5.2a1.4 1.4 0 0 0 1.4 1.4h10.4a1.4 1.4 0 0 0 1.4-1.4v-5.2" />
          </svg>
        </button>
      </template>
    </AppHeader>

    <div ref="scroller" class="report-body" data-scroll="page">
      <div v-if="building" class="report-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在汇总本地记录…</span>
      </div>

      <ErrorState
        v-else-if="loadError"
        :error="loadError"
        back-text="返回"
        @retry="load"
        @back="goBack"
      />

      <EmptyState
        v-else-if="isEmpty"
        variant="aperture"
        title="还没有可统计的记录"
        description="看几部片子回来，这里会生成你的专属放映报告"
        action-text="去媒体库"
        @action="goLibrary"
      />

      <template v-else>
        <!-- 报告单头部 -->
        <section class="hero" data-reveal>
          <div class="hero__aura" aria-hidden="true" />
          <div class="hero__grain" aria-hidden="true" />
          <div class="hero__perf hero__perf--left" aria-hidden="true" />
          <div class="hero__perf hero__perf--right" aria-hidden="true" />

          <div class="hero__inner">
            <p class="hero__eyebrow">本地放映报告 · 近 {{ report.spanDays }} 天</p>

            <div class="hero__main">
              <div class="hero__total">
                <p class="hero__figure">
                  <span class="hero__num">{{ hoursText }}</span>
                  <span class="hero__unit">小时</span>
                </p>
                <p class="hero__caption">估算观看时长</p>
              </div>

              <div class="hero__ring">
                <svg viewBox="0 0 42 42" aria-hidden="true">
                  <circle class="hero__ring-track" cx="21" cy="21" r="15.9155" />
                  <circle
                    class="hero__ring-fill"
                    cx="21"
                    cy="21"
                    r="15.9155"
                    :style="{ strokeDashoffset: ringOffset }"
                  />
                </svg>
                <span class="hero__ring-text">
                  <strong>{{ toPercent(report.completionRate) }}%</strong>
                  <em>完播</em>
                </span>
              </div>
            </div>

            <ul class="hero__stats">
              <li>
                <span class="hero__stat-num">{{ report.totalRecords }}</span>
                <span class="hero__stat-label">部作品</span>
              </li>
              <li>
                <span class="hero__stat-num">{{ report.finishedCount }}</span>
                <span class="hero__stat-label">部看完</span>
              </li>
              <li>
                <span class="hero__stat-num">{{ report.activeDays }}</span>
                <span class="hero__stat-label">个活跃日</span>
              </li>
            </ul>

            <div class="hero__foot">
              <span class="streak" :class="{ 'streak--live': report.currentStreakDays > 0 }">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 3.2c3.4 3 5.2 5.6 5.2 8.4a5.2 5.2 0 0 1-10.4 0c0-1.5.6-2.9 1.8-4.2" />
                  <path d="M12 20.8a2.9 2.9 0 0 0 2.9-2.9c0-1.6-1.3-2.6-2.9-4.5-1.6 1.9-2.9 2.9-2.9 4.5a2.9 2.9 0 0 0 2.9 2.9Z" />
                </svg>
                {{ report.currentStreakDays > 0 ? `连续 ${report.currentStreakDays} 天` : `最长 ${report.bestStreakDays} 天` }}
              </span>
              <SegmentedControl
                :model-value="measure"
                :options="MEASURE_OPTIONS"
                label="图表统计口径"
                @update:model-value="measure = $event as TasteMeasure"
              />
            </div>
          </div>
        </section>

        <!-- 口味画像 -->
        <section class="panel" data-reveal>
          <header class="panel__head">
            <h2 class="panel__title">口味画像</h2>
            <span class="panel__hint">{{ measure === 'count' ? '按部数' : '按估算时长' }}</span>
          </header>

          <SegmentedControl
            class="panel__segment"
            block
            :model-value="dimension"
            :options="DIMENSION_OPTIONS"
            label="口味维度"
            @update:model-value="dimension = $event as TasteDimension"
          />

          <ul v-if="tasteSlices.length > 0" class="taste">
            <li
              v-for="(slice, index) in tasteSlices"
              :key="slice.key"
              class="taste__item"
              :class="{ 'taste__item--rest': slice.key === '__rest' }"
              :style="{ '--slice': sliceColor(slice, index), '--p': measureValue(slice) / tasteMax, '--i': index }"
            >
              <!-- 合并项的占比是尾项之和，画成条形会比第一名还长，反过来压掉榜单语义 -->
              <template v-if="slice.key === '__rest'">
                <span class="taste__label truncate-1">{{ sliceLabel(slice) }}</span>
                <span class="taste__value">{{ sliceValueText(slice) }}</span>
              </template>
              <template v-else>
                <span class="taste__rank">{{ index + 1 }}</span>
                <span class="taste__label truncate-1">{{ sliceLabel(slice) }}</span>
                <span class="taste__value">
                  {{ sliceValueText(slice) }}
                  <em>{{ shareText(slice) }}</em>
                </span>
                <span class="taste__track">
                  <i class="taste__fill" />
                </span>
              </template>
            </li>
          </ul>
          <p v-else class="panel__empty">这个维度还没有可归类的数据</p>

          <p class="panel__note">{{ tasteNote }}</p>
        </section>

        <!-- 观影节奏 -->
        <section class="panel" data-reveal>
          <header class="panel__head">
            <h2 class="panel__title">观影节奏</h2>
            <span class="panel__hint">
              最近 {{ REPORT_MONTH_WINDOW }} 个月{{ measure === 'seconds' ? ' · 小时' : '' }}
            </span>
          </header>

          <div class="rhythm" role="group" aria-label="按最后一次观看时间归月的分布">
            <button
              v-for="(month, index) in report.months"
              :key="month.key"
              class="rhythm__col"
              :class="{ 'rhythm__col--on': selectedMonth === month.key, 'rhythm__col--zero': month.count === 0 }"
              type="button"
              :aria-pressed="selectedMonth === month.key"
              :aria-label="`${month.label}，${month.count} 部，约 ${formatDuration(month.seconds)}`"
              :style="{ '--p': measureValue(month) / monthMax, '--i': index }"
              @click="pickMonth(month.key)"
            >
              <span class="rhythm__value">{{ monthValueText(month) }}</span>
              <span class="rhythm__track"><i class="rhythm__fill" /></span>
              <span class="rhythm__label">{{ month.label }}</span>
            </button>
          </div>

          <p class="rhythm__caption">{{ monthCaption }}</p>
        </section>

        <!-- 差一点就看完 -->
        <section v-if="nearlyDone.length > 0" class="panel" data-reveal>
          <header class="panel__head">
            <h2 class="panel__title">差一点就看完</h2>
            <span class="panel__hint">{{ nearlyDone.length }} 部</span>
          </header>

          <div class="nearly">
            <button
              v-for="record in nearlyDone"
              :key="record.id"
              class="nearly__card"
              type="button"
              @click="resume(record.mediaId, record.sourceId, record.episodeId)"
            >
              <span class="nearly__cover">
                <PosterImage :src="record.posterUrl" :alt="record.title" :cover-key="record.mediaId" :width-px="IMG_W_COMPACT" />
                <span class="nearly__badge">{{ formatProgress(record.progress) }}</span>
              </span>
              <span class="nearly__title truncate-2">{{ record.title }}</span>
              <span class="nearly__meta truncate-1">{{ formatRemaining(record.positionSec, record.durationSec) }}</span>
            </button>
          </div>
        </section>

        <!-- 片源分布 -->
        <section class="panel" data-reveal>
          <header class="panel__head">
            <h2 class="panel__title">常看的源</h2>
            <span class="panel__hint">{{ report.sources.length }} 项</span>
          </header>

          <ul class="sources">
            <li
              v-for="(slice, index) in rankedSources"
              :key="slice.key"
              class="sources__item"
              :class="{ 'sources__item--rest': slice.key === '__rest' }"
              :style="{ '--slice': sliceColor(slice, index), '--p': measureValue(slice) / sourceMax, '--i': index }"
            >
              <span class="sources__dot" aria-hidden="true" />
              <span class="sources__name truncate-1">{{ slice.label }}</span>
              <span class="sources__value">{{ sliceValueText(slice) }}</span>
              <span v-if="slice.key !== '__rest'" class="sources__track"><i class="sources__fill" /></span>
            </li>
          </ul>
        </section>

        <!-- 片单 -->
        <section class="panel" data-reveal>
          <header class="panel__head">
            <h2 class="panel__title">片单</h2>
            <span class="panel__hint">{{ filteredTitles.length }} 部</span>
          </header>

          <div class="chips">
            <button
              v-for="option in FILTER_OPTIONS"
              :key="option.value"
              class="chip"
              :class="{ 'chip--on': titleFilter === option.value }"
              type="button"
              :aria-pressed="titleFilter === option.value"
              @click="titleFilter = option.value"
            >
              {{ option.label }}
            </button>
            <button
              v-if="selectedMonth"
              class="chip chip--month"
              type="button"
              aria-label="清除月份筛选"
              @click="selectedMonth = null"
            >
              {{ report.months.find((m) => m.key === selectedMonth)?.label }}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
              </svg>
            </button>
          </div>

          <ul v-if="shownTitles.length > 0" class="titles">
            <li v-for="record in shownTitles" :key="record.id">
              <button
                class="titles__row"
                type="button"
                @click="openDetail(record.mediaId, record.sourceId)"
              >
                <span class="titles__cover">
                  <PosterImage :src="record.posterUrl" :alt="record.title" :cover-key="record.mediaId" :width-px="IMG_W_INLINE" />
                </span>
                <span class="titles__body">
                  <span class="titles__name truncate-1">{{ record.title }}</span>
                  <span class="titles__meta truncate-1">
                    <template v-if="record.episodeNumber !== null">第 {{ record.episodeNumber }} 集 · </template>
                    约 {{ formatDuration(estimatedWatchSeconds(record)) }} · {{ formatRelativeTime(record.updatedAt) }}
                  </span>
                  <span class="titles__bar">
                    <i :style="{ width: `${Math.max(2, toPercent(record.progress))}%` }" />
                  </span>
                </span>
                <span class="titles__state" :class="{ 'titles__state--done': record.finished }">
                  {{ record.finished ? '看完' : formatProgress(record.progress) }}
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="panel__empty">当前筛选下没有记录</p>

          <button
            v-if="filteredTitles.length > shownTitles.length"
            class="titles__more"
            type="button"
            @click="visibleCount += 12"
          >
            显示更多（还有 {{ filteredTitles.length - shownTitles.length }} 部）
          </button>
        </section>

        <p class="report-foot">
          时长为按历史进度估算：同一影片只保留最近一集，前面的集数按看完计入；
          月度分布按最后一次观看时间归月，不是逐次观看流水。数据全部留在本机。
        </p>
      </template>
    </div>
  </main>
</template>

<style scoped>
.report-page {
  /* 图表色板：放映灯琥珀 → 幕布红 → 银幕青 → 天空 → 紫 → 青柠 → 品红，中性灰兜底 */
  --rp-1: #f0a82e;
  --rp-2: #fb7185;
  --rp-3: #2dd4bf;
  --rp-4: #60a5fa;
  --rp-5: #a78bfa;
  --rp-6: #a3e635;
  --rp-7: #f472b6;
  --rp-neutral: #94a3b8;
  --rp-grow: 720ms;
  --rp-reveal: 520ms;

  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

[data-theme='light'] .report-page {
  --rp-1: #b87406;
  --rp-2: #c62a32;
  --rp-3: #0f766e;
  --rp-4: #1a6fd4;
  --rp-5: #6d28d9;
  --rp-6: #4d7c0f;
  --rp-7: #be185d;
  --rp-neutral: #5c6673;
}

.report-share {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  transition: var(--transition-color);
}

.report-share svg {
  width: 20px;
  height: 20px;
}

.report-share:active:not(:disabled) {
  background-color: var(--color-overlay-press-strong);
}

.report-share:disabled {
  color: var(--color-text-disabled);
}

.report-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--layout-page-padding-x) calc(var(--space-8) + var(--safe-bottom));
  scrollbar-width: thin;
  scrollbar-color: var(--color-brand-soft) transparent;
}

.report-body::-webkit-scrollbar {
  width: 6px;
}

.report-body::-webkit-scrollbar-track {
  background: transparent;
}

.report-body::-webkit-scrollbar-thumb {
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-control);
}

.report-body::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-brand);
}

.report-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

/* ---------- 分段进场 ---------- */
[data-reveal] {
  opacity: 0;
  transform: translateY(16px);
  transition:
    opacity var(--rp-reveal) var(--ease-decelerate),
    transform var(--rp-reveal) var(--ease-decelerate);
}

[data-reveal='in'] {
  opacity: 1;
  transform: none;
}

/* ---------- 报告单头部 ---------- */
.hero {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-border-glass);
  background-color: var(--color-bg-surface);
  box-shadow: var(--shadow-2);
}

.hero__aura {
  position: absolute;
  inset: -30% -20% auto -20%;
  height: 150%;
  background:
    radial-gradient(46% 38% at 18% 12%, rgba(240, 168, 46, 0.42) 0%, transparent 70%),
    radial-gradient(40% 34% at 84% 8%, rgba(251, 113, 133, 0.3) 0%, transparent 72%),
    radial-gradient(52% 44% at 62% 82%, rgba(45, 212, 191, 0.22) 0%, transparent 74%),
    radial-gradient(44% 40% at 8% 88%, rgba(96, 165, 250, 0.22) 0%, transparent 72%);
  filter: blur(6px);
  animation: rp-drift 18s var(--ease-standard) infinite alternate;
}

@keyframes rp-drift {
  from {
    transform: translate3d(-2%, -1%, 0) scale(1);
  }
  to {
    transform: translate3d(3%, 2%, 0) scale(1.08);
  }
}

/* 颗粒：小尺寸 SVG 噪声平铺，比全屏 turbulence 便宜得多 */
.hero__grain {
  position: absolute;
  inset: 0;
  opacity: 0.16;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* 胶片齿孔 */
.hero__perf {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 10px;
  background-image: repeating-linear-gradient(
    180deg,
    var(--color-bg-overlay-soft) 0 7px,
    transparent 7px 18px
  );
  opacity: 0.5;
}

.hero__perf--left {
  left: 5px;
}

.hero__perf--right {
  right: 5px;
}

.hero__inner {
  position: relative;
  padding: var(--space-5) var(--space-6);
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.18) 0%, var(--color-bg-surface) 68%);
}

[data-theme='light'] .hero__inner {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.32) 0%, var(--color-bg-surface) 68%);
}

.hero__eyebrow {
  font: var(--text-caption);
  letter-spacing: 0.08em;
  color: var(--color-text-secondary);
}

.hero__main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-2);
}

.hero__figure {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.hero__num {
  font: var(--font-weight-bold) 46px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--color-brand-strong) 0%, var(--color-brand) 60%, var(--rp-2) 130%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero__unit {
  font: var(--text-title-3);
  color: var(--color-text-secondary);
}

.hero__caption {
  margin-top: 2px;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.hero__ring {
  position: relative;
  flex: 0 0 auto;
  width: 84px;
  height: 84px;
}

.hero__ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.hero__ring-track {
  fill: none;
  stroke: var(--color-overlay-track);
  stroke-width: 3.4;
}

.hero__ring-fill {
  fill: none;
  stroke: var(--color-success);
  stroke-width: 3.4;
  stroke-linecap: round;
  stroke-dasharray: 100;
  transition: stroke-dashoffset var(--rp-grow) var(--ease-decelerate);
}

.hero__ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}

.hero__ring-text strong {
  font: var(--font-weight-bold) 18px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
}

.hero__ring-text em {
  font: var(--text-caption);
  font-style: normal;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.hero__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-divider);
}

.hero__stats li {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hero__stat-num {
  font: var(--font-weight-bold) 20px / 1.1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
}

.hero__stat-label {
  font: var(--text-caption);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.hero__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.streak {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-subtle);
  border: 1px solid var(--color-border);
  font: var(--text-caption);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.streak svg {
  width: 14px;
  height: 14px;
}

.streak--live {
  background-color: var(--color-brand-soft);
  border-color: var(--color-brand);
  color: var(--color-brand-text);
}

.hero__foot :deep(.segmented) {
  height: 30px;
  padding: 2px;
  background-color: var(--color-overlay-subtle);
}

.hero__foot :deep(.segmented__item) {
  min-width: 52px;
  height: 26px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-12);
  line-height: 26px;
}

/* ---------- 通用面板 ---------- */
.panel {
  margin-top: var(--space-5);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: 1px solid var(--color-border);
}

.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.panel__title {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.panel__hint {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.panel__segment {
  margin-top: var(--space-3);
}

.panel__note {
  margin-top: var(--space-3);
  font: var(--text-caption);
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-tertiary);
}

.panel__empty {
  padding: var(--space-5) 0;
  text-align: center;
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

/* ---------- 口味画像 ---------- */
.taste {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.taste__item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  grid-template-areas:
    'rank label value'
    '. track track';
  align-items: center;
  column-gap: var(--space-2);
  row-gap: 5px;
}

.taste__item--rest {
  grid-template-areas: 'label label value';
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}

.taste__item--rest .taste__label,
.taste__item--rest .taste__value {
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.taste__rank {
  grid-area: rank;
  font: var(--font-weight-semibold) 11px / 1 var(--font-family-number);
  color: var(--slice);
  text-align: center;
}

.taste__label {
  grid-area: label;
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.taste__value {
  grid-area: value;
  font: var(--font-weight-medium) 12px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.taste__value em {
  margin-left: 5px;
  font-style: normal;
  color: var(--color-text-tertiary);
}

.taste__track {
  grid-area: track;
  display: block;
  height: 7px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-subtle);
  overflow: hidden;
}

.taste__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background-color: var(--slice);
  background-image: linear-gradient(90deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0) 100%);
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform var(--rp-grow) var(--ease-decelerate);
  transition-delay: calc(var(--i) * 45ms);
}

[data-reveal='in'] .taste__fill {
  transform: scaleX(var(--p));
}

/* ---------- 观影节奏 ---------- */
.rhythm {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.rhythm__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: var(--space-1) 0;
  border-radius: var(--radius-sm);
  transition: var(--transition-color);
}

.rhythm__col:active {
  background-color: var(--color-overlay-press);
}

.rhythm__value {
  font: var(--font-weight-semibold) 11px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

.rhythm__track {
  display: flex;
  align-items: flex-end;
  width: 100%;
  max-width: 26px;
  height: 92px;
  border-radius: var(--radius-sm);
  background-color: var(--color-overlay-subtle);
  overflow: hidden;
}

.rhythm__fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-sm);
  background: linear-gradient(180deg, var(--color-brand-strong) 0%, var(--color-brand) 100%);
  transform: scaleY(0.02);
  transform-origin: bottom center;
  transition: transform var(--rp-grow) var(--ease-decelerate);
  transition-delay: calc(var(--i) * 55ms);
}

[data-reveal='in'] .rhythm__fill {
  transform: scaleY(max(0.02, var(--p)));
}

.rhythm__label {
  font: var(--text-caption);
  font-size: 10.5px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.rhythm__col--zero .rhythm__value {
  color: var(--color-text-disabled);
}

.rhythm__col--on {
  background-color: var(--color-brand-soft);
}

.rhythm__col--on .rhythm__label,
.rhythm__col--on .rhythm__value {
  color: var(--color-brand-text);
  font-weight: var(--font-weight-semibold);
}

.rhythm__col--on .rhythm__track {
  box-shadow: inset 0 0 0 1px var(--color-brand);
}

.rhythm__caption {
  margin-top: var(--space-3);
  font: var(--text-caption);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

/* ---------- 差一点就看完 ---------- */
.nearly {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-bottom: var(--space-1);
  overflow-x: auto;
  scrollbar-width: none;
}

.nearly::-webkit-scrollbar {
  height: 0;
}

.nearly__card {
  flex: 0 0 auto;
  width: 92px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
}

.nearly__cover {
  position: relative;
  display: block;
  width: 92px;
  border-radius: var(--radius-card);
  overflow: hidden;
  transition: var(--transition-transform);
}

.nearly__card:active .nearly__cover {
  transform: scale(0.96);
}

.nearly__badge {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-glass-strong);
  font: var(--font-weight-semibold) 10px / 1.5 var(--font-family-number);
  color: var(--color-brand-text);
}

.nearly__title {
  font: var(--font-weight-medium) 12px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.nearly__meta {
  font: var(--text-caption);
  font-size: 10.5px;
  color: var(--color-text-tertiary);
}

/* ---------- 常看的源 ---------- */
.sources {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.sources__item {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  grid-template-areas:
    'dot name value'
    '. track track';
  align-items: center;
  column-gap: var(--space-2);
  row-gap: 5px;
}

.sources__item--rest {
  grid-template-areas: 'dot name value';
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}

.sources__item--rest .sources__name,
.sources__item--rest .sources__value {
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.sources__dot {
  grid-area: dot;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background-color: var(--slice);
}

.sources__name {
  grid-area: name;
  font: var(--text-label);
  color: var(--color-text-primary);
}

.sources__value {
  grid-area: value;
  font: var(--font-weight-medium) 12px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.sources__track {
  grid-area: track;
  display: block;
  height: 5px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-subtle);
  overflow: hidden;
}

.sources__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background-color: var(--slice);
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform var(--rp-grow) var(--ease-decelerate);
  transition-delay: calc(var(--i) * 45ms);
}

[data-reveal='in'] .sources__fill {
  transform: scaleX(var(--p));
}

/* ---------- 片单 ---------- */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-pressed);
  border: 1px solid transparent;
  font: var(--text-label);
  font-size: var(--font-size-12);
  color: var(--color-text-secondary);
  transition: var(--transition-color);
}

.chip svg {
  width: 12px;
  height: 12px;
}

.chip--on {
  background-color: var(--color-brand-soft);
  border-color: var(--color-brand);
  color: var(--color-brand-text);
  font-weight: var(--font-weight-semibold);
}

.chip--month {
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}

.titles {
  margin-top: var(--space-2);
}

.titles__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 74px;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-divider);
  text-align: left;
}

.titles li:last-child .titles__row {
  border-bottom: none;
}

.titles__row:active {
  background-color: var(--color-overlay-subtle);
}

.titles__cover {
  flex: 0 0 auto;
  width: 40px;
  border-radius: 9px;
  overflow: hidden;
}

.titles__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.titles__name {
  font: var(--font-weight-semibold) 13.5px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.titles__meta {
  font: var(--text-caption);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.titles__bar {
  display: block;
  height: 3px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-track);
  overflow: hidden;
}

.titles__bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background-color: var(--color-brand);
}

.titles__state {
  flex: 0 0 auto;
  font: var(--font-weight-medium) 11px / 1 var(--font-family-number);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-tertiary);
}

.titles__state--done {
  padding: 3px 7px;
  border-radius: var(--radius-full);
  background-color: var(--color-success-soft);
  color: var(--color-success);
  font-family: var(--font-family-base);
}

.titles__more {
  width: 100%;
  min-height: 44px;
  margin-top: var(--space-2);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-pressed);
  font: var(--text-label-strong);
  font-size: var(--font-size-12);
  color: var(--color-text-secondary);
  transition: var(--transition-color);
}

.titles__more:active {
  background-color: var(--color-overlay-press-strong);
}

.report-foot {
  margin-top: var(--space-5);
  padding: 0 var(--space-1);
  font: var(--text-caption);
  font-size: 10.5px;
  line-height: 1.7;
  color: var(--color-text-tertiary);
}

@media (prefers-reduced-motion: reduce) {
  .report-page {
    --rp-grow: 0ms;
    --rp-reveal: 0ms;
  }

  .hero__aura {
    animation: none;
  }

  [data-reveal] {
    transform: none;
  }

  .taste__fill,
  .sources__fill,
  .rhythm__fill {
    transition-delay: 0ms;
  }
}
</style>