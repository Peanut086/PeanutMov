<script setup lang="ts">
/**
 * 进度簇（设计稿 ⑤ timeline：时间行在上、轨道贴画面底缘）
 *
 * - 视觉层用 scaleX 推进（不动 width，逐 tick 不触发重排）；轨道拖动时 scaleY(1.7)
 * - 命中区 44px（透明包裹层，粗指针加高到 64），与视觉层解耦
 * - 拖动中只更新本地预览值，松手才 `seek`（AC-43：误差 ≤2s）
 * - 拖动/hover 时在指针位置上方显示帧预览 + 时间
 * - A-03：给了 `film` 就铺跟手胶片，当前格放大描边；没给则只有时间气泡
 * - `role="slider"` + aria-valuetext
 * - G-A03：`magnet` 决定磁吸强度（0 = 关掉一切新行为）。开启后轨面上铺一格一刻度，
 *   拖动跨过格界发一次 `detent`，靠近片头/片尾边界则把预览值吸到边界上
 *
 * 本组件刻意不依赖 Pinia（触觉通过 `detent` 事件交给宿主），保持纯几何 + 纯呈现。
 */
import { computed, ref } from "vue";

import { formatPlayerClock } from "@/shared/time";
import type { RhythmBand } from "@/player/cutRhythm";

const props = withDefaults(
  defineProps<{
    currentTime: number;
    duration: number;
    /** 已缓冲到的秒数 */
    buffered?: number;
    /** 是否禁用（loading/error） */
    disabled?: boolean;
    /** 定位能力是否可靠；false 时禁止拖动与键盘 seek */
    seekEnabled?: boolean;
    /** P1-4：键盘方向键步进秒数（默认 10） */
    seekStep?: number;
    /**
     * A-03：本地文件的胶片缩略图（下标即格号，null 表示该格还没抽好）。
     * 为空或全是 null 时不显示胶片，退回原来的时间气泡。
     */
    film?: (string | null)[] | null;
    /**
     * B-06：片头/片尾区间（秒）。给了就把轨道切成有语义的三段，
     * 边界画刻度、区间铺淡底；没有标记时进度条与从前完全一致。
     */
    marks?: {
      introEndSec: number | null;
      creditsStartSec: number | null;
    } | null;
    /**
     * G-A03：磁吸强度 0~100。**0 = 一切新行为不启用**（不画刻度、不吸附、不发事件），
     * 与升级前逐字节一致；组件默认取 0，是否跟随设置由宿主决定。
     */
    detent?: number;
    /**
     * G-A03：一格代表多少份时长（= 胶片格数）。0/1 表示没有可用分段，不画刻度。
     * 刻度本身只是视觉与触觉提示，绝不参与 seek 取值。
     */
    cells?: number;
    /**
     * G-C05：镜头节奏带（每集一条，数据来自弹幕智能配色那张亮度场）。
     * `null` = 还没有足够数据，轨面与升级前逐像素一致。
     */
    rhythm?: RhythmBand | null;
  }>(),
  { buffered: 0, disabled: false, seekEnabled: true, seekStep: 10, film: null, marks: null, detent: 0, cells: 0, rhythm: null },
);

const emit = defineEmits<{
  (e: "seek", sec: number): void;
  (e: "seeking", sec: number): void;
  /**
   * G-A03：吸附/跨界反馈。触觉交给宿主做（本组件不碰 Pinia，现有几何单测因此不受影响）。
   * `tick` = 拖过一格刻度（位置不变）；`boundary` = 被吸到片头/片尾边界（位置已改）。
   */
  (e: "detent", kind: "tick" | "boundary", label: string): void;
}>();

const trackRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const previewSec = ref(0);
/** 鼠标 hover 的 X 位置（相对轨道宽度百分比 0~100），用于显示 hover 预览 */
const hoverPercent = ref<number | null>(null);

const safeDuration = computed(() =>
  Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0,
);
const seekDisabled = computed(() => props.disabled || !props.seekEnabled);
const displaySec = computed(() =>
  dragging.value
    ? previewSec.value
    : safeDuration.value > 0
      ? clamp(props.currentTime, 0, safeDuration.value)
      : Math.max(0, props.currentTime),
);

const percent = computed(() =>
  safeDuration.value > 0
    ? clamp((displaySec.value / safeDuration.value) * 100, 0, 100)
    : 0,
);
const bufferedPercent = computed(() =>
  safeDuration.value > 0
    ? clamp((props.buffered / safeDuration.value) * 100, 0, 100)
    : 0,
);

/**
 * B-06：把标记换算成轨道百分比段。
 * 越界（≥ 时长或 ≤0）的标记忽略——源站数据不可靠时宁可少画，不能画出一条假区间。
 */
const zones = computed(() => {
  const total = safeDuration.value;
  const out: { kind: "intro" | "credits"; from: number; to: number }[] = [];
  if (total <= 0 || !props.marks) return out;
  const intro = props.marks.introEndSec;
  const credits = props.marks.creditsStartSec;
  if (intro !== null && intro > 0 && intro < total) {
    out.push({ kind: "intro", from: 0, to: (intro / total) * 100 });
  }
  if (credits !== null && credits > 0 && credits < total) {
    out.push({ kind: "credits", from: (credits / total) * 100, to: 100 });
  }
  return out;
});

/** 有效标记：与 zones 同一套越界过滤，保证提示文案与画出的区间一致 */
const validMarks = computed(() => {
  const total = safeDuration.value;
  const intro = props.marks?.introEndSec ?? null;
  const credits = props.marks?.creditsStartSec ?? null;
  return {
    intro: intro !== null && intro > 0 && intro < total ? intro : null,
    credits:
      credits !== null && credits > 0 && credits < total ? credits : null,
  };
});

/** 时间行右侧是剩余时间（设计稿口径：−mm:ss） */
const remainingSec = computed(() =>
  Math.max(0, safeDuration.value - displaySec.value),
);
/** 合成层推进比例（0~1）：交给 CSS scaleX，逐 tick 不触发重排 */
const playedScale = computed(() => (percent.value / 100).toFixed(4));
const bufferedScale = computed(() => (bufferedPercent.value / 100).toFixed(4));
/** 区间提示：命中片头/片尾时说明状态，平时给出两个边界 */
const markHintText = computed(() => {
  const { intro, credits } = validMarks.value;
  if (intro === null && credits === null) return "";
  const t = displaySec.value;
  if (intro !== null && t < intro)
    return `片头中 · ${formatPlayerClock(intro - t)} 后结束`;
  if (credits !== null && t >= credits) return "片尾中";
  const parts: string[] = [];
  if (intro !== null) parts.push(`片头至 ${formatPlayerClock(intro)}`);
  if (credits !== null) parts.push(`片尾自 ${formatPlayerClock(credits)}`);
  return parts.join(" · ");
});

/** 当前应该显示的时间（拖动 > hover > 实际播放位置） */
const bubbleSec = computed(() => {
  if (dragging.value) return previewSec.value;
  if (hoverPercent.value !== null && safeDuration.value > 0) {
    return (hoverPercent.value / 100) * safeDuration.value;
  }
  return null;
});

/** 气泡水平位置（百分比），限制在 5%~95% 避免溢出 */
const bubbleLeft = computed(() => {
  if (dragging.value) return clamp(percent.value, 5, 95);
  if (hoverPercent.value !== null) return clamp(hoverPercent.value, 5, 95);
  return 0;
});

/** 是否显示时间气泡 */
const showBubble = computed(
  () => bubbleSec.value !== null && safeDuration.value > 0 && !seekDisabled.value,
);

/* ---------- A-03 胶片预览 ---------- */

/** 单格显示宽度（px）：轨道一半宽时约能看见 4~5 格，够判断画面又不糊成一团 */
const FILM_CELL_W = 72;

/** 轨道实测宽度，用来把「手指位置」换算成胶片的平移像素 */
const trackWidth = ref(0);
const filmSlots = computed(() => props.film ?? []);
/** 一格都没就绪时不铺空胶片：空黑条比没有更让人以为卡住了 */
const filmReady = computed(() => filmSlots.value.some((url) => url !== null));
const showFilm = computed(
  () =>
    !seekDisabled.value &&
    safeDuration.value > 0 &&
    filmReady.value &&
    (dragging.value || hoverPercent.value !== null),
);

/** 指针在轨道上的比例（0~1）：拖动优先，其次是鼠标悬停 */
const pointerRatio = computed(() =>
  dragging.value
    ? percent.value / 100
    : clamp((hoverPercent.value ?? 0) / 100, 0, 1),
);

/** 当前指针落在第几格 */
const filmIndex = computed(() => {
  const count = filmSlots.value.length;
  if (count === 0) return 0;
  return Math.min(
    count - 1,
    Math.max(0, Math.floor(pointerRatio.value * count)),
  );
});

/**
 * 胶片平移量：让当前格正好在手指下面，两端贴边而不是被裁掉半格。
 * 轨道比整条胶片还宽时（横屏 + 低格数）钳到 0，胶片静止、只高亮当前格。
 */
const filmStripStyle = computed(() => {
  const count = filmSlots.value.length;
  const stripWidth = count * FILM_CELL_W;
  const measured = trackWidth.value > 0 ? trackWidth.value : stripWidth;
  const half = FILM_CELL_W / 2;
  // 高亮格中心的允许落点：整格都在窗口内，越到两端越向轨道边缘收
  const targetX = clamp(
    pointerRatio.value * measured,
    half,
    Math.max(measured - half, half),
  );
  const ideal = targetX - (filmIndex.value + 0.5) * FILM_CELL_W;
  const min = Math.min(measured - stripWidth, 0);
  const panX = Math.max(min, Math.min(0, ideal));
  return {
    width: `${stripWidth}px`,
    transform: `translate3d(${panX}px, 0, 0)`,
  };
});

/* ---------- G-A03 刻度与磁吸 ---------- */

/** 吸附半径上限（px，强度 100% 时）：再大就成了"抢指针"，看起来像进度条坏了 */
const DETENT_RADIUS_PX = 16;

const detentLevel = computed(() => clamp(props.detent, 0, 100) / 100);
/** 磁吸是否生效：0 档时下面所有分支都短路，进度条回到升级前的行为 */
const detentActive = computed(
  () => detentLevel.value > 0 && !seekDisabled.value && safeDuration.value > 0,
);

/** 一格代表多少秒（0 = 没有可用分段，不画刻度） */
const cellSec = computed(() =>
  detentActive.value && props.cells > 1
    ? safeDuration.value / props.cells
    : 0,
);

/** 刻度线位置（百分比）：两端不画，区间端点已由 zone-edge 表达 */
const tickPercents = computed(() => {
  const count = detentActive.value ? props.cells : 0;
  if (count <= 1) return [] as number[];
  return Array.from(
    { length: count - 1 },
    (_, index) => ((index + 1) / count) * 100,
  );
});

/** 可吸附的边界：与 zones 共用同一套越界过滤，绝不吸到没画出来的位置上 */
const boundaryTargets = computed(() => {
  const out: { label: string; sec: number }[] = [];
  if (!detentActive.value) return out;
  const { intro, credits } = validMarks.value;
  if (intro !== null) out.push({ label: "片头结束", sec: intro });
  if (credits !== null) out.push({ label: "片尾开始", sec: credits });
  return out;
});

/** 当前吸附到的边界名（空串 = 没吸附），同时驱动气泡旁的标签与一次中等触觉 */
const snappedLabel = ref("");

/* ---------- G-C05 镜头节奏带 ---------- */

const rhythmBars = computed(() => props.rhythm?.values ?? []);
const peakBins = computed(() => new Set(props.rhythm?.peaks ?? []));
/**
 * 带子只在有数据、能算比例、且没禁用时出现。
 *
 * 判"能不能画"用的是父级给没给 `rhythm`（它已经替我把"格数够不够"这一步做掉了），
 * 这里不再重复一套阈值——两处阈值迟早会算出两个答案。
 */
const showRhythm = computed(
  () =>
    !seekDisabled.value &&
    safeDuration.value > 0 &&
    props.rhythm !== null &&
    rhythmBars.value.length > 0,
);

/**
 * 一格的高度。
 *
 * 没有数据的格留 100% 高但透明，让容器那道斜纹透出来——"没看过"必须和"很平"长得不一样。
 * 有数据的格最低 8%，纯 0 会消失成一道缝，看起来像漏画。
 */
function barHeight(value: number): string {
  if (!Number.isFinite(value)) return "100%";
  return `${Math.round(clamp(value, 0.08, 1) * 100)}%`;
}

/** 指针（拖动优先，其次 hover）落在第几格 */
const pointerBin = computed(() => {
  const count = rhythmBars.value.length;
  if (!showRhythm.value || count === 0) return -1;
  const ratio =
    dragging.value
      ? percent.value / 100
      : clamp((hoverPercent.value ?? 0) / 100, 0, 1);
  return Math.min(count - 1, Math.max(0, Math.floor(ratio * count)));
});

/** 指针压住换镜点时说一句——点击本身走原来的命中层，不再加一套手势 */
const peakLabel = computed(() =>
  pointerBin.value >= 0 && peakBins.value.has(pointerBin.value)
    ? "换镜密集点"
    : "",
);

/** 上一次落在第几格：跨界只认"变了没有"，起步那一格不算跨界 */
let lastCellIndex = -1;

function resetDetentState(): void {
  lastCellIndex = -1;
  snappedLabel.value = "";
}

/**
 * 把指针位置换算成最终预览值。
 *
 * 边界吸附会改值（"拖到片头附近"的意图就是"到片头结束"），刻度**只发事件不改值**：
 * 一格约 5% 时长，按格取整会直接把 AC-43 的 ≤2s 精度要求打穿。
 */
function applyDetent(rawSec: number): number {
  if (!detentActive.value || trackWidth.value <= 0) return rawSec;
  const total = safeDuration.value;
  const radiusSec =
    ((DETENT_RADIUS_PX * detentLevel.value) / trackWidth.value) * total;
  const hit = boundaryTargets.value.find(
    (item) => Math.abs(rawSec - item.sec) <= radiusSec,
  );
  if (hit) {
    if (snappedLabel.value !== hit.label) emit("detent", "boundary", hit.label);
    snappedLabel.value = hit.label;
    return hit.sec;
  }
  snappedLabel.value = "";
  const step = cellSec.value;
  if (step > 0) {
    const index = Math.min(
      props.cells - 1,
      Math.max(0, Math.floor(rawSec / step)),
    );
    if (lastCellIndex >= 0 && index !== lastCellIndex) emit("detent", "tick", "");
    lastCellIndex = index;
  }
  return rawSec;
}

/** 指针像素 → 秒（含磁吸）：按下 / 移动 / 松手三条路径必须同源，否则"看到的不是得到的" */
function seekSecAt(clientX: number): number {
  return applyDetent(positionToSec(clientX));
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function positionToSec(clientX: number): number {
  const el = trackRef.value;
  if (!el || safeDuration.value <= 0) return 0;
  const rect = el.getBoundingClientRect();
  trackWidth.value = rect.width;
  const ratio =
    rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
  return ratio * safeDuration.value;
}

function positionToPercent(clientX: number): number {
  const el = trackRef.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  trackWidth.value = rect.width;
  return rect.width > 0
    ? clamp(((clientX - rect.left) / rect.width) * 100, 0, 100)
    : 0;
}

function onPointerDown(ev: PointerEvent): void {
  if (seekDisabled.value || safeDuration.value <= 0) return;
  dragging.value = true;
  resetDetentState();
  previewSec.value = seekSecAt(ev.clientX);
  emit("seeking", previewSec.value);
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
}

function onPointerMove(ev: PointerEvent): void {
  if (seekDisabled.value) {
    if (dragging.value) {
      dragging.value = false;
      resetDetentState();
    }
    hoverPercent.value = null;
    return;
  }
  // hover 预览（无论是否拖动都更新位置）
  hoverPercent.value = positionToPercent(ev.clientX);
  if (!dragging.value) return;
  previewSec.value = seekSecAt(ev.clientX);
  emit("seeking", previewSec.value);
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  if (seekDisabled.value) {
    resetDetentState();
    return;
  }
  const target = seekSecAt(ev.clientX);
  previewSec.value = target;
  emit("seek", target);
  resetDetentState();
}

function onPointerLeave(): void {
  if (!dragging.value) hoverPercent.value = null;
}

function onKeydown(ev: KeyboardEvent): void {
  if (seekDisabled.value) return;
  const step = ev.shiftKey ? 30 : props.seekStep;
  const hasDuration = safeDuration.value > 0;
  if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    emit("seek", hasDuration ? clamp(props.currentTime - step, 0, safeDuration.value) : Math.max(0, props.currentTime - step));
  } else if (ev.key === "ArrowRight") {
    ev.preventDefault();
    emit("seek", hasDuration ? clamp(props.currentTime + step, 0, safeDuration.value) : props.currentTime + step);
  } else if (ev.key === "Home") {
    ev.preventDefault();
    emit("seek", 0);
  } else if (ev.key === "End" && hasDuration) {
    ev.preventDefault();
    emit("seek", safeDuration.value);
  }
}

const ariaText = computed(() =>
  safeDuration.value > 0
    ? `${formatPlayerClock(displaySec.value)}，共 ${formatPlayerClock(safeDuration.value)}`
    : `${formatPlayerClock(displaySec.value)}，总时长未知`,
);
</script>

<template>
  <div
    class="seekbar"
    :class="{ 'seekbar--dragging': dragging, 'seekbar--disabled': seekDisabled }"
    :data-scrub="dragging ? '1' : '0'"
  >
    <!-- 时间行在上、轨道在下（B 站/YouTube 口径）；右侧是剩余时间 -->
    <div class="seekbar__times">
      <span class="seekbar__time seekbar__time--cur">{{
        formatPlayerClock(displaySec)
      }}</span>
      <span v-if="markHintText" class="seekbar__hint">{{ markHintText }}</span>
      <span class="seekbar__time seekbar__time--dur">{{
        safeDuration > 0 ? formatPlayerClock(remainingSec) : "--:--"
      }}</span>
    </div>

    <div
      ref="trackRef"
      class="seekbar__hit"
      role="slider"
      tabindex="0"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(safeDuration)"
      :aria-valuenow="Math.round(displaySec)"
      :aria-valuetext="ariaText"
      aria-label="播放进度"
      :aria-disabled="seekDisabled"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
      @keydown="onKeydown"
    >
      <!-- A-03：胶片预览（跟手平移，两端贴边不外溢） -->
      <Transition name="film">
        <div v-if="showFilm" class="seekbar__film" aria-hidden="true">
          <div class="seekbar__film-strip" :style="filmStripStyle">
            <div
              v-for="(url, index) in filmSlots"
              :key="index"
              class="seekbar__film-cell"
              :class="{ 'seekbar__film-cell--active': index === filmIndex }"
            >
              <img v-if="url" :src="url" alt="" draggable="false" />
            </div>
          </div>
        </div>
      </Transition>

      <!-- 时间预览气泡 -->
      <Transition name="bubble">
        <div
          v-if="showBubble"
          class="seekbar__bubble"
          :class="{ 'seekbar__bubble--raised': showFilm }"
          :style="{ left: `${bubbleLeft}%` }"
        >
          <span class="seekbar__bubble-text">{{
            formatPlayerClock(bubbleSec)
          }}</span>
          <!-- G-A03：吸附到的边界名，让"停在 01:30"读起来是落点而不是卡住 -->
          <span v-if="snappedLabel" class="seekbar__snap">{{
            snappedLabel
          }}</span>
          <!-- G-C05：指针压住换镜点时把"这一秒是剪得最碎的段落之一"说出来 -->
          <span v-if="peakLabel && !snappedLabel" class="seekbar__snap seekbar__snap--peak">{{
            peakLabel
          }}</span>
          <span class="seekbar__bubble-arrow" aria-hidden="true" />
        </div>
      </Transition>

      <!-- G-A03 刻度：纯装饰层，pointer-events 关掉，绝不影响命中区与 seek 取值 -->
      <div v-if="tickPercents.length > 0" class="seekbar__ticks" aria-hidden="true">
        <span
          v-for="tick in tickPercents"
          :key="tick"
          class="seekbar__tick"
          :style="{ left: `${tick}%` }"
        />
      </div>

      <!-- G-C05 节奏带：铺在轨道上方的装饰层，pointer-events 关掉；点它等于点进度条同一秒 -->
      <div v-if="showRhythm" class="seekbar__rhythm" aria-hidden="true">
        <span
          v-for="(value, index) in rhythmBars"
          :key="index"
          class="seekbar__rhythm-bar"
          :class="{
            'seekbar__rhythm-bar--peak': peakBins.has(index),
            'seekbar__rhythm-bar--blank': !Number.isFinite(value),
          }"
          :style="{ height: barHeight(value) }"
        />
      </div>

      <div class="seekbar__track">
        <div class="seekbar__buffered" :style="{ '--p': bufferedScale }" />
        <!-- B-06：片头/片尾斜纹垫在已播条之下，琥珀进度经过区间时仍然清楚 -->
        <div
          v-for="zone in zones"
          :key="`zone-${zone.kind}`"
          class="seekbar__zone"
          :class="{ 'seekbar__zone--end': zone.kind === 'credits' }"
          :style="{ left: `${zone.from}%`, width: `${zone.to - zone.from}%` }"
          aria-hidden="true"
        />
        <div class="seekbar__played" :style="{ '--p': playedScale }" />
        <!-- 边界刻度高出轨道，轨道再细也看得出「片头到这里结束」 -->
        <div
          v-for="zone in zones"
          :key="`edge-${zone.kind}`"
          class="seekbar__zone-edge"
          :style="{ left: `${zone.kind === 'intro' ? zone.to : zone.from}%` }"
          aria-hidden="true"
        />
        <!-- hover 指示线（非拖动时显示） -->
        <div
          v-if="
            hoverPercent !== null && !dragging && !seekDisabled && safeDuration > 0
          "
          class="seekbar__hover-line"
          :style="{ left: `${hoverPercent}%` }"
          aria-hidden="true"
        />
      </div>
      <div class="seekbar__thumb" :style="{ '--p': playedScale }" />
    </div>
  </div>
</template>

<style scoped>
/* =========================================================
 * 进度簇（设计稿 ⑤）：时间行在上、轨道贴画面底缘
 * 视觉层 scaleX 推进（逐 tick 不重排），交互层独立命中带。
 * 别名变量由 .pl-frame 提供；直播回看等宿主没有 chrome 层，故逐项给兜底值。
 * =========================================================*/

.seekbar {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--s1, 4px);
}

/* ---------- 时间行：当前 / 区间提示 / 剩余 ---------- */

.seekbar__times {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s3, 12px);
  font: var(--t-12n, 500 12px / 16px var(--font-family-number));
  color: var(--tx-2, #9ba3af);
}

.seekbar__time--cur {
  color: var(--ov-fill, rgba(255, 255, 255, 0.92));
}

.seekbar__time--dur::before {
  content: "−";
  margin-right: 1px;
}

.seekbar__hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font: var(--t-12, 400 12px / 16px var(--font-family-base));
  color: var(--tx-3, #6b7480);
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 交互层：44px 命中带（粗指针），与视觉轨道解耦 ---------- */

.seekbar__hit {
  position: relative;
  padding: 11px 0;
  border-radius: var(--r-pill, 999px);
  touch-action: none;
  cursor: pointer;
}

@media (pointer: coarse) {
  .seekbar__hit {
    padding: 16px 0;
  }

  /* 留白按设计稿 16px（轨道簇 35px），命中区向外扩到 45px 而不改布局高度；
     下方只扩 4px：再大就压到填满行高的播放键（52px）上沿，抢掉它的点击 */
  .seekbar__hit::before {
    content: "";
    position: absolute;
    inset: -6px 0 -4px;
  }
}

.seekbar__hit:focus-visible {
  outline: none;
  box-shadow: var(
    --ring,
    0 0 0 2px rgba(0, 0, 0, 0.55),
    0 0 0 4px rgba(240, 168, 46, 0.78)
  );
}

.seekbar--disabled {
  opacity: 0.5;
}

.seekbar--disabled .seekbar__hit {
  cursor: default;
  pointer-events: none;
}

/* ---------- 视觉轨道 ---------- */

.seekbar__track {
  position: relative;
  height: var(--track-h, 4px);
  border-radius: var(--r-pill, 999px);
  background: var(--ov-rail, rgba(255, 255, 255, 0.18));
  overflow: hidden;
  transform-origin: center;
  transition: transform var(--d-fast, 150ms)
    var(--ease, cubic-bezier(0.2, 0, 0, 1));
}

.seekbar__buffered,
.seekbar__played {
  position: absolute;
  inset: 0;
  transform-origin: 0 50%;
  transform: scaleX(var(--p, 0));
}

.seekbar__buffered {
  background: var(--ov-buf, rgba(255, 255, 255, 0.34));
}

.seekbar__played {
  background: var(
    --gradient-brand,
    linear-gradient(135deg, #ffc761, #f0a82e 55%, #d98a12)
  );
  transition: transform var(--d-fast, 150ms) linear;
}

/* 拖动时轨道加高、进度不再补间（跟手优先） */
.seekbar[data-scrub="1"] .seekbar__track {
  transform: scaleY(1.7);
}

.seekbar[data-scrub="1"] .seekbar__played {
  transition: none;
}

/* 片头/片尾：斜纹底，读图即懂，不叠文字 */
.seekbar__zone {
  position: absolute;
  top: 0;
  bottom: 0;
  background: repeating-linear-gradient(
    115deg,
    var(--ov-hatch, rgba(255, 255, 255, 0.22)) 0 2px,
    transparent 2px 7px
  );
}

.seekbar__zone--end {
  background: repeating-linear-gradient(
    115deg,
    var(--ov-hatch-end, rgba(251, 113, 133, 0.34)) 0 2px,
    transparent 2px 7px
  );
}

/* 端点刻线：轨道再细也看得出「片头到这里结束」 */
.seekbar__zone-edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--ov-solid, #ffffff);
  opacity: 0.7;
}

.seekbar__hover-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ov-solid, #ffffff);
  opacity: 0.4;
}

/* ---------- G-A03 刻度与吸附 ---------- */

/* 铺在命中带里但 pointer-events 关闭：只负责"看得出有几格"，不参与任何手势 */
.seekbar__ticks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 9px 齿 vs 4px 轨面：轨道再细也数得清格数 */
.seekbar__tick {
  position: absolute;
  top: 50%;
  width: 1px;
  height: 9px;
  background: var(--ov-solid, #ffffff);
  opacity: 0.22;
  transform: translateY(-50%);
}

.seekbar__snap {
  font: var(--t-12, 400 12px / 16px var(--font-family-base));
  color: var(--brand, #f0a82e);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  white-space: nowrap;
  animation: seekbar-snap-pop var(--d-fast, 150ms)
    var(--ease, cubic-bezier(0.2, 0, 0, 1));
}

/* 终态就是无动画态：减弱动效下全局把 duration 压到 0，元素照样完整可见 */
@keyframes seekbar-snap-pop {
  from {
    opacity: 0;
    transform: translateY(-3px) scale(0.9);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* ---------- G-C05 镜头节奏带 ---------- */

/* 轨道上方 9px 的一条：贴在命中带自身的留白里，既不压轨面也不越到时间行 */
.seekbar__rhythm {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(50% + 4px);
  height: 9px;
  display: flex;
  align-items: flex-end;
  gap: 1px;
  pointer-events: none;
}

/* 斜纹垫底 = "这一段还没播过"；柱子盖在它上面 = "读过了" */
.seekbar__rhythm::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 2px;
  opacity: 0.45;
  background: repeating-linear-gradient(
    115deg,
    var(--ov-hatch, rgba(255, 255, 255, 0.22)) 0 1px,
    transparent 1px 5px
  );
}

.seekbar__rhythm-bar {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  border-radius: 1px;
  background: var(--ov-track, rgba(255, 255, 255, 0.16));
}

/* 换镜点：全条最响的几格，用品牌色点出来，扫一眼就知道该往哪儿跳 */
.seekbar__rhythm-bar--peak {
  background: var(--brand, #f0a82e);
}

.seekbar__rhythm-bar--blank {
  background: transparent;
}

.seekbar__snap--peak {
  opacity: 0.85;
}

/* ---------- 滑块：视觉 12 → 拖动 16 / hover 14，只改 scale ---------- */

.seekbar__thumb {
  position: absolute;
  top: 50%;
  left: calc(var(--p, 0) * 100%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--ov-solid, #ffffff);
  box-shadow: var(--sh-2, 0 4px 14px rgba(0, 0, 0, 0.45));
  transform: translate(-50%, -50%) scale(var(--thumb-s, 1));
  transition: transform var(--d-fast, 150ms)
    var(--ease, cubic-bezier(0.2, 0, 0, 1));
  pointer-events: none;
}

.seekbar[data-scrub="1"] .seekbar__thumb {
  --thumb-s: 1.35;
}

@media (hover: hover) and (pointer: fine) {
  .seekbar__hit:hover .seekbar__thumb {
    --thumb-s: 1.2;
  }
}

/* ---------- 预览：时间 + 胶片 ---------- */

.seekbar__bubble {
  position: absolute;
  bottom: calc(100% + 4px);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  z-index: var(--z-menu, 34);
}

.seekbar__bubble-text {
  font: var(--t-12n, 500 12px / 16px var(--font-family-number));
  color: var(--ov-fill, rgba(255, 255, 255, 0.92));
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  white-space: nowrap;
}

/* 设计稿的预览时间不带气泡底与箭头 */
.seekbar__bubble-arrow {
  display: none;
}

.bubble-enter-active,
.bubble-leave-active {
  transition:
    opacity var(--d-fast, 150ms) var(--ease, cubic-bezier(0.2, 0, 0, 1)),
    transform var(--d-fast, 150ms) var(--ease, cubic-bezier(0.2, 0, 0, 1));
}

.bubble-enter-from,
.bubble-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}

/* 出现胶片时把时间顶到胶片上方，别压在画面上 */
.seekbar__bubble--raised {
  bottom: calc(100% + 66px);
}

/* A-03 胶片：真缩略图跟手平移，当前格放大描边（设计稿的占位条纹在此由真帧替代） */
.seekbar__film {
  position: absolute;
  bottom: calc(100% + 24px);
  left: 0;
  right: 0;
  height: 58px;
  display: flex;
  align-items: center;
  overflow: hidden;
  pointer-events: none;
  z-index: var(--z-menu, 34);
}

.seekbar__film-strip {
  display: flex;
  align-items: center;
  flex: none;
  will-change: transform;
}

/* 格间距靠内描边表达，不用 gap：平移量按 72px 一格算，加间距就对不上手指 */
.seekbar__film-cell {
  flex: none;
  width: 72px;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--glass-line, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-sm, 8px);
  overflow: hidden;
  background:
    repeating-linear-gradient(
      90deg,
      var(--peek-stripe, rgba(255, 255, 255, 0.07)) 0 1px,
      transparent 1px 18px
    ),
    var(--peek-film, linear-gradient(160deg, #16202b, #0a0d12));
  box-shadow: var(--sh-3, 0 12px 32px rgba(0, 0, 0, 0.55));
}

.seekbar__film-cell img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.seekbar__film-cell--active {
  z-index: 2;
  transform: scale(1.35);
  border-color: var(--brand, #f0a82e);
  box-shadow:
    0 0 0 1px var(--brand, #f0a82e),
    var(--sh-3, 0 12px 32px rgba(0, 0, 0, 0.55));
}

.film-enter-active,
.film-leave-active {
  transition: opacity var(--d-fast, 150ms)
    var(--ease, cubic-bezier(0.2, 0, 0, 1));
}

.film-enter-from,
.film-leave-to {
  opacity: 0;
}
</style>
