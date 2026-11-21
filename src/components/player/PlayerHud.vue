<script setup lang="ts">
/**
 * 手势浮层（设计规范 ⑦ `pl-hud`，样式在 player-chrome.css）
 *
 * 显示：快进/后退目标时间、音量百分比、亮度百分比、长按倍速提示、
 * 双击播放/暂停的大图标反馈。
 * 仅做展示，pointer-events: none。
 */
import { computed, ref, watch } from "vue";

import { formatPlayerClock } from "@/shared/time";

export type HudKind =
  "seek" | "volume" | "brightness" | "rate" | "play" | "pause" | null;

const props = withDefaults(
  defineProps<{
    kind: HudKind;
    /** seek: 目标秒数；volume/brightness: 0~100；rate: 长按档倍速 */
    value?: number;
    /** seek: 相对秒数（正=快进） */
    deltaSec?: number;
  }>(),
  { value: 0, deltaSec: 0 },
);

/** 播放/暂停大图标动画 key：每次 kind 切到 play/pause 时递增触发重新播放 */
const pulseKey = ref(0);

watch(
  () => props.kind,
  (kind) => {
    if (kind === "play" || kind === "pause") {
      pulseKey.value += 1;
    }
  },
);

const title = computed(() => {
  switch (props.kind) {
    case "seek":
      return props.deltaSec >= 0 ? "快进" : "后退";
    case "volume":
      return props.value <= 0 ? "已静音" : "音量";
    case "brightness":
      return props.value <= 0 ? "最低亮度" : "亮度";
    case "rate":
      // 必须念长按档（value），不能念基准倍速：念基准会出现"1x 快进中"这种自相矛盾的话，
      // 还会让人以为提示是跟着自己选的倍速来的。
      return `${props.value}x 快进中`;
    case "play":
      return "播放";
    case "pause":
      return "已暂停";
    default:
      return "";
  }
});

const mainText = computed(() => {
  switch (props.kind) {
    case "seek":
      return formatPlayerClock(props.value);
    case "volume":
    case "brightness":
      return `${Math.round(props.value)}%`;
    default:
      return "";
  }
});

const subText = computed(() => {
  if (props.kind !== "seek") return "";
  const abs = Math.abs(Math.round(props.deltaSec));
  return `${props.deltaSec >= 0 ? "+" : "-"}${abs}s`;
});

const barPercent = computed(() => {
  if (props.kind === "volume" || props.kind === "brightness")
    return Math.min(100, Math.max(0, props.value));
  return 0;
});
</script>

<template>
  <Transition name="pl-hud">
    <div
      v-if="kind"
      :key="pulseKey"
      :class="[
        'pl-hud',
        {
          'pl-hud--pulse': kind === 'play' || kind === 'pause',
          'pl-hud--in': kind === 'play' || kind === 'pause',
        },
      ]"
      role="status"
      aria-live="polite"
    >
      <!-- 播放/暂停大图标（无文字/进度条，纯视觉反馈） -->
      <template v-if="kind === 'play' || kind === 'pause'">
        <svg
          v-if="kind === 'play'"
          class="pl-hud__icon"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M6 4.6c0-1.5 1.7-2.4 3-1.5l10 7.4c1.1.8 1.1 2.4 0 3.2l-10 7.4c-1.3.9-3 0-3-1.5V4.6Z"
          />
        </svg>
        <svg
          v-else
          class="pl-hud__icon"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
          <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
        </svg>
      </template>

      <!-- 其他 kind 的图标 -->
      <svg
        v-else-if="kind === 'volume'"
        class="pl-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4Z" />
        <path v-if="value > 0" d="M15.4 9a4.2 4.2 0 0 1 0 6" />
        <path v-if="value > 50" d="M18 6.6a7.6 7.6 0 0 1 0 10.8" />
        <path v-if="value <= 0" d="m15.5 9.5 4 5M19.5 9.5l-4 5" />
      </svg>
      <svg
        v-else-if="kind === 'brightness'"
        class="pl-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3.6" />
        <path
          d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5"
        />
      </svg>
      <svg
        v-else-if="kind === 'seek'"
        class="pl-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          :d="
            deltaSec >= 0 ? 'M4 12h14M13 7l5 5-5 5' : 'M20 12H6M11 7l-5 5 5 5'
          "
        />
      </svg>
      <svg
        v-else
        class="pl-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 5 8 7-8 7z" />
        <path d="m14 5 8 7-8 7z" />
      </svg>

      <div v-if="kind !== 'play' && kind !== 'pause'" class="pl-hud__texts">
        <span class="pl-hud__title">{{ title }}</span>
        <span v-if="mainText" class="pl-hud__value">{{ mainText }}</span>
        <span v-if="subText" class="pl-hud__sub">{{ subText }}</span>
      </div>

      <span
        v-if="kind === 'volume' || kind === 'brightness'"
        class="pl-hud__bar"
        aria-hidden="true"
      >
        <i :style="{ '--p': barPercent / 100 }" />
      </span>
    </div>
  </Transition>
</template>
