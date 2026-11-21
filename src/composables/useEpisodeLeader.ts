/**
 * 换集「过片」幕布的状态（G 批次·G-A06）
 *
 * 状态刻意放在**模块级**而不是 PlayerView 里：`App.vue` 用 `:key="current.fullPath"`
 * 挂路由页，换集就是整页重建，页面内的 ref 活不过这次重建，而幕布必须盖在**新**那一帧上。
 * 所以触发者是旧实例里的 `chooseEpisode`，渲染者是 App 壳里的 `EpisodeLeader`。
 *
 * 三条不变量（都是"不破坏现有功能"的底线）：
 * - 只做装饰层，`pointer-events: none`，且 300ms 到点必撤——它不在任何加载链路上，
 *   首帧该多快还多快；
 * - 连点上下集只有一层 DOM 重播（靠 `seq` 换 key），不叠加多层；
 * - 减弱动效下直接不触发：这不是"放慢一点"的效果，是持续变化的画面。
 */
import { ref } from 'vue';

import { prefersReducedMotion } from '@/composables/useSpring';

/** 幕布停留时长（ms）：到点即撤，不追求"把动画放完" */
export const LEADER_MS = 300;

const visible = ref(false);
const label = ref('');
/** 递增序号：渲染层用它做 `:key`，一次换集 = 重播一次，而不是多挂一层 */
const seq = ref(0);

let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** 集号 → 片门上的字号；集号未知时留空，只放过片不编号码 */
export function leaderLabelFor(episodeNumber: number | null): string {
  if (episodeNumber === null || !Number.isFinite(episodeNumber) || episodeNumber <= 0) return '';
  return `EP ${String(Math.round(episodeNumber)).padStart(2, '0')}`;
}

/**
 * 放过片。由 `PlayerView.chooseEpisode` 在路由替换前调用（彩蛋开关在调用方判，
 * 与本仓库其它彩蛋口径一致），这里只管状态与撤层时间。
 */
export function playEpisodeLeader(episodeNumber: number | null): void {
  if (prefersReducedMotion()) return;
  label.value = leaderLabelFor(episodeNumber);
  seq.value += 1;
  visible.value = true;
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    visible.value = false;
    hideTimer = null;
  }, LEADER_MS);
}

/** 立即撤层：页面卸载/进入锁定态这类"不该再演"的时刻用 */
export function stopEpisodeLeader(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  visible.value = false;
}

/** 仅供测试复位模块级状态 */
export function __resetEpisodeLeaderForTest(): void {
  stopEpisodeLeader();
  label.value = '';
  seq.value = 0;
}

export function useEpisodeLeader() {
  return { visible, label, seq };
}
