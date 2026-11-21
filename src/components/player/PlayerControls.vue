<script setup lang="ts">
/**
 * 播放 chrome（设计稿 ③ 顶栏 / ④ 底栏 / ⑦⑧ 就地弹层）
 *
 * - 顶栏：返回 + 身份簇（片名 / 一行状态摘要）+ chip 轨（画质·线路·字幕·弹幕·缓冲）
 *   + 锁定屏幕（一级入口，常驻可见）+ 更多
 * - 底栏：进度簇（跳过条 → 时间行 → 轨道）+ 传输簇（上/播放/下）+ 视图簇（倍速·音量亮度·选集·全屏）
 * - 尺寸分档由 .pl-frame 的容器查询驱动，组件不再接 compact / immersive
 * - 倍速与音量亮度是就地弹层（非模态，留在 chrome 内）；选集/线路/字幕/更多交父级面板
 * - 显隐由 .pl-shell[data-chrome] 统一控制（opacity，不位移）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { PlaybackRate } from "@/types";
import { RATE_OPTIONS } from "@/player/constants";
import { formatPlayerClock } from "@/shared/time";

import SeekBar from "@/components/player/SeekBar.vue";
import IconBack from "@/components/icons/IconBack.vue";
import { useHaptic } from "@/composables/useHaptic";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    /** 当前集序号（1 起）；单集影片传 0 */
    epIndex?: number;
    epTotal?: number;
    playing: boolean;
    waiting: boolean;
    currentTime: number;
    duration: number;
    /** 已缓冲到的秒数 */
    buffered: number;
    rate: PlaybackRate;
    canPrev: boolean;
    canNext: boolean;
    /** 单集影片隐藏上下集按钮（AC-42） */
    showEpisodeNav: boolean;
    fullscreen: boolean;
    subtitleActive: boolean;
    /** 字幕档位文本（如「简中」），空则按开关显示 开/关 */
    subtitleLabel?: string;
    qualityLabel: string;
    /** 当前线路名（chip 与摘要各用一次） */
    lineName?: string;
    danmakuEnabled?: boolean;
    /** 键盘/进度条步进秒数 */
    seekStep?: number;
    /** 音量 / 亮度（0~100 真值，落点由父级按 levelSource 决定） */
    volume?: number;
    brightness?: number;
    /** 屏幕已锁定：顶栏锁按钮换闭合图标 */
    locked?: boolean;
    /** 命中片头/片尾区间时浮出跳过条 */
    skipZone?: "intro" | "credits" | null;
    /** 跳过目标（片头结束时刻 / 片尾长度，秒） */
    skipTargetSec?: number;
    /** A-03：进度条胶片预览的缩略图（下标即格号，null = 未就绪） */
    film?: (string | null)[] | null;
    /** B-06：片头/片尾区间标记（秒） */
    marks?: {
      introEndSec: number | null;
      creditsStartSec: number | null;
    } | null;
  }>(),
  {
    epIndex: 0,
    epTotal: 0,
    subtitleLabel: "",
    lineName: "",
    danmakuEnabled: false,
    seekStep: 10,
    volume: 100,
    brightness: 100,
    locked: false,
    skipZone: null,
    skipTargetSec: 0,
    film: null,
    marks: null,
  },
);

const emit = defineEmits<{
  (e: "back"): void;
  (e: "toggle-play"): void;
  (e: "prev"): void;
  (e: "next"): void;
  (e: "seek", sec: number): void;
  (e: "seeking", sec: number): void;
  (e: "set-rate", rate: number): void;
  (e: "set-volume", value: number): void;
  (e: "set-brightness", value: number): void;
  (e: "open-quality"): void;
  (e: "open-line"): void;
  (e: "open-subtitle"): void;
  (e: "open-episodes"): void;
  (e: "open-more"): void;
  (e: "toggle-danmaku"): void;
  (e: "toggle-fullscreen"): void;
  (e: "toggle-lock"): void;
  (e: "skip"): void;
  (e: "skip-dismiss"): void;
  /** 弹层打开期间暂停控制条自动隐藏；关闭后重新计时 */
  (e: "pause-auto-hide"): void;
  (e: "nudge"): void;
}>();

const { haptic } = useHaptic();

const rootRef = ref<HTMLElement | null>(null);
/** 就地弹层：同一时刻只开一个 */
const openPop = ref<"rate" | "av" | null>(null);

const rateLabel = computed(() => `${props.rate}x`);
const playLabel = computed(() =>
  props.waiting ? "缓冲中" : props.playing ? "暂停" : "播放",
);
const volLabel = computed(() =>
  props.volume <= 0 ? "静音" : String(Math.round(props.volume)),
);
const subtitleText = computed(
  () => props.subtitleLabel || (props.subtitleActive ? "开" : "关"),
);
const epText = computed(() =>
  props.epTotal > 1 ? `${props.epIndex}/${props.epTotal}` : "",
);
/** chip 位窄，线路名去掉「源·」前缀（摘要里仍给全名） */
const lineShort = computed(() => props.lineName.replace(/^源·/, ""));
const bufferPercent = computed(() =>
  props.duration > 0
    ? Math.round(
        Math.min(100, Math.max(0, (props.buffered / props.duration) * 100)),
      )
    : 0,
);
const remainingSec = computed(() =>
  Math.max(0, props.duration - props.currentTime),
);
const skipLabel = computed(() =>
  props.skipZone === "credits" ? "跳过片尾" : "跳过片头",
);
const miniProgress = computed(() =>
  props.duration > 0
    ? Math.min(100, Math.max(0, (props.currentTime / props.duration) * 100))
    : 0,
);
const miniBuffered = computed(() =>
  props.duration > 0
    ? Math.min(100, Math.max(0, (props.buffered / props.duration) * 100))
    : 0,
);
/** 滑杆已填充比例（webkit 轨道渐变靠它，与 thumb 位置同源） */
const rateFill = computed(
  () => `${(((props.rate - 0.5) / 1.5) * 100).toFixed(1)}%`,
);
const volFill = computed(() => `${Math.round(props.volume)}%`);
const briFill = computed(() => `${Math.round(props.brightness)}%`);

function togglePop(name: "rate" | "av"): void {
  haptic("light");
  openPop.value = openPop.value === name ? null : name;
}

function onTogglePlay(): void {
  haptic("light");
  emit("toggle-play");
}

function onRatePreset(value: number): void {
  haptic("light");
  emit("set-rate", value);
}

function onFineRate(ev: Event): void {
  emit("set-rate", Number((ev.target as HTMLInputElement).value));
}

function onVolume(ev: Event): void {
  emit("set-volume", Number((ev.target as HTMLInputElement).value));
}

function onBrightness(ev: Event): void {
  emit("set-brightness", Number((ev.target as HTMLInputElement).value));
}

/* 弹层打开时停掉自动隐藏，关闭后重新计时；控制条被隐藏时一并收起弹层 */
watch(openPop, (value) => {
  if (value) emit("pause-auto-hide");
  else emit("nudge");
});
watch(
  () => props.visible,
  (value) => {
    if (!value) openPop.value = null;
  },
);

/** 点到弹层与它的触发按钮之外就收起（chrome 内其余按钮照常工作） */
function onDocPointerDown(ev: PointerEvent): void {
  if (!openPop.value) return;
  const target = ev.target as HTMLElement | null;
  if (target?.closest(".pl-cell--open")) return;
  openPop.value = null;
}

function onDocKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" || !openPop.value) return;
  openPop.value = null;
  ev.stopPropagation();
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown, true);
});
</script>

<template>
  <div ref="rootRef" class="pl-chrome">
    <!-- ③ 顶部 chrome：身份簇（左） + 内容层簇（右） + 锁屏/更多 -->
    <header class="pl-top">
      <button
        class="pl-ico"
        type="button"
        aria-label="返回"
        @click="emit('back')"
      >
        <IconBack :size="22" />
      </button>

      <div class="pl-top__id">
        <h1 class="pl-top__title truncate-1">{{ title }}</h1>
        <!-- 一行状态摘要替代分散的三段信息；窄容器只留集号与剩余时间 -->
        <p class="pl-top__meta">
          <template v-if="epText">
            <span class="pl-top__ep"
              ><span class="wide">第 </span>{{ epText
              }}<span class="wide"> 集</span></span
            >
            <span class="sep">·</span>
          </template>
          <span>剩余 {{ formatPlayerClock(remainingSec) }}</span>
          <span class="tail">
            <span class="pl-top__buf"
              ><span class="sep">·</span>缓冲 {{ bufferPercent }}%</span
            >
            <template v-if="lineName">
              <span class="sep">·</span>
              <span>{{ lineName }}</span>
            </template>
          </span>
        </p>
      </div>

      <div class="pl-top__chips">
        <button
          class="pl-chip"
          type="button"
          aria-haspopup="dialog"
          @click="emit('open-quality')"
        >
          <span class="pl-chip__k">画质</span
          ><span class="pl-chip__v">{{ qualityLabel }}</span>
        </button>
        <button
          class="pl-chip opt"
          type="button"
          aria-haspopup="dialog"
          @click="emit('open-line')"
        >
          <span class="pl-chip__k">线路</span
          ><span class="pl-chip__v">{{ lineShort }}</span>
        </button>
        <button
          class="pl-chip pl-chip--sub"
          type="button"
          :aria-pressed="subtitleActive"
          @click="emit('open-subtitle')"
        >
          <span class="pl-chip__k">字幕</span
          ><span class="pl-chip__v">{{ subtitleText }}</span>
        </button>
        <button
          class="pl-chip opt"
          type="button"
          :aria-pressed="danmakuEnabled"
          @click="emit('toggle-danmaku')"
        >
          <span class="pl-chip__k">弹幕</span
          ><span class="pl-chip__v">{{ danmakuEnabled ? "开" : "关" }}</span>
        </button>
        <!-- 实时码率当前引擎读不到，这一格诚实显示缓冲水位 -->
        <span class="pl-chip pl-chip--static pl-chip--net opt" title="缓冲水位">
          <span class="pl-chip__v">缓冲 {{ bufferPercent }}%</span>
        </span>
      </div>

      <!-- 锁定屏幕：一级入口常驻顶栏（藏在「更多」里等于找不到） -->
      <button
        class="pl-ico"
        type="button"
        :aria-pressed="locked"
        :aria-label="locked ? '解除屏幕锁定' : '锁定屏幕'"
        :title="locked ? '解除屏幕锁定（K）' : '锁定屏幕（K）'"
        @click="emit('toggle-lock')"
      >
        <svg
          v-if="!locked"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <rect x="5" y="11" width="14" height="9" rx="2.4" />
          <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <rect x="5" y="11" width="14" height="9" rx="2.4" />
          <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
        </svg>
      </button>

      <button
        class="pl-ico pl-ico--more"
        type="button"
        aria-label="更多"
        aria-haspopup="dialog"
        @click="emit('open-more')"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
    </header>

    <!-- ④ 底部 chrome：进度簇 + 传输簇 + 视图簇 -->
    <footer class="pl-bottom">
      <!-- 进度簇：跳过条（条件出现） → 时间行 → 轨道 -->
      <div class="pl-timeline">
        <div v-if="skipZone" class="pl-skip">
          <button class="pl-skip__btn" type="button" @click="emit('skip')">
            <span>{{ skipLabel }}</span>
            <span class="num">{{ formatPlayerClock(skipTargetSec) }}</span>
          </button>
          <button
            class="pl-skip__dismiss"
            type="button"
            aria-label="本集不再提示"
            @click="emit('skip-dismiss')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <SeekBar
          :current-time="currentTime"
          :duration="duration"
          :buffered="buffered"
          :disabled="waiting && duration === 0"
          :seek-step="seekStep"
          :film="film"
          :marks="marks"
          @seek="emit('seek', $event)"
          @seeking="emit('seeking', $event)"
        />
      </div>

      <div class="pl-row">
        <button
          v-if="showEpisodeNav"
          class="pl-btn"
          type="button"
          aria-label="上一集"
          :disabled="!canPrev"
          @click="emit('prev')"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 5.6v12.8L9.4 12Z" />
            <rect x="5" y="5.6" width="2.2" height="12.8" rx="1" />
          </svg>
        </button>

        <button
          class="pl-btn pl-btn--play"
          type="button"
          :data-busy="waiting ? '1' : '0'"
          :aria-label="playLabel"
          :aria-busy="waiting ? 'true' : undefined"
          @click="onTogglePlay"
        >
          <svg
            v-if="!playing"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M7 4.6c0-1.4 1.6-2.3 2.8-1.5l9.4 7.4c1 .8 1 2.2 0 3L9.8 20.9C8.6 21.7 7 20.8 7 19.4Z"
            />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="6" y="4.5" width="4" height="15" rx="1.3" />
            <rect x="14" y="4.5" width="4" height="15" rx="1.3" />
          </svg>
        </button>

        <button
          v-if="showEpisodeNav"
          class="pl-btn"
          type="button"
          aria-label="下一集"
          :disabled="!canNext"
          @click="emit('next')"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M5 5.6v12.8L14.6 12Z" />
            <rect x="16.8" y="5.6" width="2.2" height="12.8" rx="1" />
          </svg>
        </button>

        <div class="pl-row__end">
          <!-- 倍速弹层：预设档 + 精细滑杆（靠右缘，弹层右对齐避免溢出画面） -->
          <div
            class="pl-cell pl-cell--end"
            :class="{ 'pl-cell--open': openPop === 'rate' }"
          >
            <button
              class="pl-btn"
              type="button"
              aria-haspopup="dialog"
              :aria-expanded="openPop === 'rate'"
              @click="togglePop('rate')"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M4.6 17a8.4 8.4 0 1 1 14.8 0" />
                <path d="M12 17v-.2M15.6 11.4 13 13.6" />
              </svg>
              <span class="pl-btn__val">{{ rateLabel }}</span>
            </button>
            <div
              class="pl-pop"
              :open="openPop === 'rate' || null"
              role="dialog"
              aria-label="倍速"
            >
              <p class="pl-pop__head">
                <span>倍速</span><b>{{ rateLabel }}</b>
              </p>
              <div class="pl-pop__grid pl-pop__grid--wrap">
                <button
                  v-for="option in RATE_OPTIONS"
                  :key="option"
                  class="pl-mini-btn"
                  type="button"
                  :aria-pressed="option === rate"
                  @click="onRatePreset(option)"
                >
                  {{ option }}x
                </button>
              </div>
              <div class="pl-rng__row">
                <input
                  class="pl-rng"
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.05"
                  :value="rate"
                  aria-label="精细倍速"
                  :style="{ '--fill': rateFill }"
                  @input="onFineRate"
                />
              </div>
            </div>
          </div>

          <!-- 音量 + 亮度合并弹层（手势仍然可用，这里是可发现入口） -->
          <div
            class="pl-cell pl-cell--vol"
            :class="{ 'pl-cell--open': openPop === 'av' }"
          >
            <button
              class="pl-btn"
              type="button"
              aria-haspopup="dialog"
              :aria-expanded="openPop === 'av'"
              aria-label="音量与亮度"
              @click="togglePop('av')"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4Z" />
                <path d="M15.4 9a4.2 4.2 0 0 1 0 6" />
                <path d="M18 6.6a7.6 7.6 0 0 1 0 10.8" />
              </svg>
              <span class="pl-btn__val">{{ volLabel }}</span>
            </button>
            <div
              class="pl-pop"
              :open="openPop === 'av' || null"
              role="dialog"
              aria-label="音量与亮度"
            >
              <div>
                <p class="pl-pop__head">
                  <span>音量</span><b>{{ Math.round(volume) }}%</b>
                </p>
                <div class="pl-rng__row">
                  <input
                    class="pl-rng"
                    type="range"
                    min="0"
                    max="100"
                    :value="volume"
                    aria-label="音量"
                    :style="{ '--fill': volFill }"
                    @input="onVolume"
                  />
                </div>
              </div>
              <div>
                <p class="pl-pop__head">
                  <span>亮度</span><b>{{ Math.round(brightness) }}%</b>
                </p>
                <div class="pl-rng__row">
                  <input
                    class="pl-rng"
                    type="range"
                    min="0"
                    max="100"
                    :value="brightness"
                    aria-label="亮度"
                    :style="{ '--fill': briFill }"
                    @input="onBrightness"
                  />
                </div>
              </div>
              <p class="pl-pop__head pl-pop__head--note">
                <span>在画面上竖向拖动同样可调：左半屏亮度、右半屏音量</span>
              </p>
            </div>
          </div>

          <button
            class="pl-btn pl-btn--eps"
            type="button"
            aria-label="选集与线路"
            @click="emit('open-episodes')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h11M4 12h11M4 17h7" />
              <path d="M18.5 9.5 21 12l-2.5 2.5" />
            </svg>
            <span class="pl-btn__val">{{ epText || "选集" }}</span>
          </button>

          <button
            class="pl-btn"
            type="button"
            :aria-label="fullscreen ? '退出全屏' : '进入全屏'"
            @click="emit('toggle-fullscreen')"
          >
            <svg
              v-if="!fullscreen"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5" />
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5" />
            </svg>
          </button>
        </div>
      </div>
    </footer>

    <!-- 控制条隐藏时的微进度（画面底缘 3px，让「画面还在走」可被感知） -->
    <div v-if="duration > 0" class="pl-mini" aria-hidden="true">
      <i class="pl-mini__buf" :style="{ width: `${miniBuffered}%` }" />
      <i class="pl-mini__played" :style="{ width: `${miniProgress}%` }" />
    </div>
  </div>
</template>
