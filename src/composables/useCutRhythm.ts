/**
 * 进度条「镜头节奏」带的数据层（G-C05）
 *
 * 自己不取样：亮度场由 `useDanmakuContrast` 的 `onField` 递过来（见那里的注释），
 * 因为原生取样每次要过桥抓一帧 surface，为节奏带单开一条路等于给播放加负担。
 *
 * 状态口径与 `resumeFrameService` 同一课：**普通对象装数据 + 一个版本号**。
 * 把 `Float64Array` 塞进 `shallowReactive` 会让"读"也把自己标脏（每帧读一次就每帧重渲染一次），
 * 渲染层因此只依赖 `band` 这一个 computed，版本号只在换格时才 +1。
 */
import { computed, ref, type ComputedRef } from 'vue';

import type { LumaField } from '@/player/danmakuContrast';
import {
  RHYTHM_MIN_COVERED_BINS,
  accumulateRhythm,
  createRhythmBins,
  fieldActivity,
  resetRhythmBins,
  rhythmBinOf,
  rhythmCoveredBins,
  rhythmPeaks,
  rhythmValues,
  type RhythmBand,
} from '@/player/cutRhythm';

export interface CutRhythmApi {
  /** null = 数据还不够铺一条带（刚开播 / 取样停了 / 没有亮度场） */
  band: ComputedRef<RhythmBand | null>;
  /** 一格亮度场到货：记账并判断要不要让渲染层重算 */
  sample: (field: LumaField, positionSec: number, durationSec: number) => void;
  /** 换集：节奏属于这一集，留着旧数据就是给下一集画一张假图 */
  reset: () => void;
}

export function useCutRhythm(): CutRhythmApi {
  const bins = createRhythmBins();
  /**
   * 上一帧的亮度场副本。
   *
   * 必须复制：`frameLuma` 两条取样路都复用同一块 `Uint8Array`，留住引用就等于下一帧
   * 跟自己比——差值恒为 0，整条带会安静地变成一条平地。
   */
  let prev: Uint8Array | null = null;
  let lastBin = -1;
  const version = ref(0);

  const band = computed<RhythmBand | null>(() => {
    void version.value;
    const values = rhythmValues(bins);
    if (rhythmCoveredBins(values) < RHYTHM_MIN_COVERED_BINS) return null;
    return { values, peaks: rhythmPeaks(values, bins) };
  });

  function sample(field: LumaField, positionSec: number, durationSec: number): void {
    const bin = rhythmBinOf(positionSec, durationSec);
    if (bin < 0) return;
    const activity = fieldActivity(prev, field.cells);
    prev = field.cells.slice();
    if (Number.isNaN(activity)) return;
    accumulateRhythm(bins, bin, activity);
    // 只在跨格时惊动渲染层：一格里 3Hz 连记 30 次，图形上看不出区别
    if (bin !== lastBin) {
      lastBin = bin;
      version.value += 1;
    }
  }

  function reset(): void {
    resetRhythmBins(bins);
    prev = null;
    lastBin = -1;
    version.value += 1;
  }

  return { band, sample, reset };
}
