/**
 * 跳过片头 / 片尾（B-06）
 *
 * 职责：把「播放头落在哪个区」变成「右下角该不该出胶囊」，并把区间边界画到进度条上。
 *
 * 三条硬口径：
 * - 进入区间立刻出胶囊（timeupdate 最快 200ms 一次，满足「300ms 内」）；离开区间立刻收起
 * - 倒计时走完才自动跳；设置关掉自动跳时胶囊只等用户点
 * - **同一集同一区段只提示一次**，手动拖回片头不会再弹一遍
 */
import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';

import { skipMarkService } from '@/services/skipMarkService';
import { SKIP_INTRO_COUNTDOWN_SEC } from '@/player/constants';
import type { SkipMarks } from '@/types';

export type SkipZone = 'intro' | 'credits';

export interface SkipIntroApi {
  /** 进度条分段用的区间标记（无数据为 null，进度条退回原样） */
  marks: ComputedRef<SkipMarks | null>;
  /** 当前该出哪一枚胶囊；null = 不在任何区间 / 已提示过 / 用户关掉了 */
  zone: Ref<SkipZone | null>;
  /** 剩余秒数；不自动跳时恒为 0 */
  countdown: Ref<number>;
  total: number;
  /** 是否倒计时到点自动跳（透传给胶囊 UI） */
  auto: ComputedRef<boolean>;
  /** 点胶囊：跳出区间 */
  skip: () => void;
  /** 点 ✕：本集该区段不再提示 */
  dismiss: () => void;
}

/**
 * 播放头所在区段。creditsStart 恰好等于时长时不算片尾（已经没有可跳的内容）。
 */
function zoneAt(sec: number, duration: number, marks: SkipMarks | null): SkipZone | null {
  if (!marks || duration <= 0) return null;
  const intro = marks.introEndSec;
  const credits = marks.creditsStartSec;
  if (intro !== null && sec < intro) return 'intro';
  if (credits !== null && sec >= credits && sec < duration) return 'credits';
  return null;
}

function jumpTarget(zone: SkipZone, sec: number, duration: number, marks: SkipMarks): number {
  if (zone === 'intro') {
    const intro = marks.introEndSec ?? 0;
    // 落在边界后 1s：停在边界点上容易被引擎再次判定进片头区，胶囊会原地复现
    return Math.min(Math.max(intro, sec) + 1, Math.max(0, duration - 1));
  }
  // 跳过片尾 = 走到结尾，把交接给连播提示的机会留给引擎
  return Math.max(0, duration - 1);
}

export function useSkipIntro(input: {
  mediaId: Ref<string>;
  episodeId: Ref<string>;
  currentTime: Ref<number>;
  duration: Ref<number>;
  /** settings.player.autoSkipIntro */
  autoSkip: Ref<boolean>;
  /** 跳转到目标秒：与手动拖进度条走同一个出口，才会正常触发续播/连播判定 */
  seek: (sec: number) => void;
}): SkipIntroApi {
  const zone = ref<SkipZone | null>(null);
  const countdown = ref(0);
  /** 已提示过的「集 + 区段」，一次会话内不重复打扰 */
  const prompted = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const marks = computed(() => skipMarkService.marksRef(input.mediaId.value).value);
  const auto = computed(() => input.autoSkip.value);

  watch(
    () => input.mediaId.value,
    (id) => {
      void skipMarkService.loadMarks(id);
    },
    { immediate: true },
  );

  function stopCountdown(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function hide(): void {
    stopCountdown();
    countdown.value = 0;
    zone.value = null;
  }

  function skip(): void {
    const current = zone.value;
    const m = marks.value;
    const duration = input.duration.value;
    if (!current || !m || duration <= 0) {
      hide();
      return;
    }
    hide();
    input.seek(jumpTarget(current, input.currentTime.value, duration, m));
  }

  function dismiss(): void {
    if (zone.value) prompted.add(`${input.episodeId.value}:${zone.value}`);
    hide();
  }

  function startCountdown(): void {
    stopCountdown();
    countdown.value = SKIP_INTRO_COUNTDOWN_SEC;
    timer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value > 0) return;
      stopCountdown();
      timer = null;
      skip();
    }, 1000);
  }

  watch(
    () => [input.currentTime.value, input.duration.value, marks.value] as const,
    () => {
      const current = zoneAt(input.currentTime.value, input.duration.value, marks.value);
      if (!current) {
        // 离开区间：立刻收起，但不留下「已提示」记录（下次真正进区间还要提示）
        if (zone.value) hide();
        return;
      }
      if (zone.value === current) return;
      const key = `${input.episodeId.value}:${current}`;
      if (prompted.has(key)) {
        hide();
        return;
      }
      // 出胶囊即记账：自动跳、看完片区、点 ✕ 三种收场都不会再弹第二遍
      prompted.add(key);
      zone.value = current;
      if (auto.value) startCountdown();
      else countdown.value = 0;
    },
    { immediate: true },
  );

  // 区段中途改设置：关掉自动跳就停掉倒计时，胶囊留着等用户点
  watch(auto, (on) => {
    if (!zone.value) return;
    if (on) {
      startCountdown();
      return;
    }
    stopCountdown();
    countdown.value = 0;
  });

  // 换集重置：新集是新内容，上一集的「已提示」不该压住这一集
  watch(
    () => input.episodeId.value,
    () => {
      hide();
    },
  );

  // 组件外的作用域里调用（如单测直接起）没有可挂靠的 scope，不能强注册
  if (getCurrentScope()) onScopeDispose(stopCountdown);

  return { marks, zone, countdown, total: SKIP_INTRO_COUNTDOWN_SEC, auto, skip, dismiss };
}
