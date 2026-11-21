/**
 * 进度条「镜头节奏」带的算法层（G-C05）
 *
 * 弹幕智能配色已经在按 3Hz 读一张 32×18 的亮度场；同一张场相邻两帧的平均差就是"换镜强度"，
 * 节奏带因此不必再开第二条取样路——原生那条每次取样都要过桥抓一帧 surface，多一路就是给播放加负担。
 *
 * 三个口径写在这里，UI 只消费结果：
 * - 一次硬切在 3Hz 下一般只落在 1 个样本上，所以每格看的是**样本均值**而不是瞬时值；
 * - 显示高度按"本集最响的那一格"相对归一（它铺满），慢剧和快片都读得出"这段比全片密"；
 * - 相对归一会把噪声一起放大，所以换镜点另加一道**绝对**闸门 `MIN_CUT_RAW`：
 *   整集静止时每一格都被归一成满高，那道闸门是它们不被标成换镜点的唯一理由。
 *
 * 阈值都是启发式（没有逐机型实测标定），集中成常量便于真机调。
 */
import { LUMA_CELLS } from '@/player/danmakuContrast';

/** 节奏带格数：与进度条一眼可分辨的疏密相当，再多就是一堵墙 */
export const RHYTHM_BINS = 60;
/** 平均差到这个档就算"换了一次镜"（满幅 255 的 1/10 弱） */
export const CUT_FULL_DIFF = 25;
/** 一格至少这么多样本才给出数值，否则算"没看过"（铺斜纹） */
export const RHYTHM_MIN_SAMPLES = 4;
/** 相对归一的分母下限：整集都很平时，不把噪声顶成满格 */
export const RHYTHM_NOISE_FLOOR = 0.18;
/** 标成换镜点还需要：本格均值至少这么响（绝对闸门，挡掉"整集都平"的假峰值） */
export const MIN_CUT_RAW = 0.16;
/** 显示高度到这一档才算换镜点 */
export const PEAK_AT = 0.62;
/** 两个换镜点至少隔这么多格，否则密到数不清等于没有 */
export const PEAK_MIN_SPACING = 3;

/** 交给渲染层的一帧结果：每格高度 + 换镜点格号 */
export interface RhythmBand {
  /** 每格显示高度 0~1，`NaN` = 这一格还没看过（UI 铺斜纹而不是画矮柱） */
  values: number[];
  /** 换镜点的格号（升序，已按最小间距去密） */
  peaks: number[];
}

export interface RhythmBins {  /** 每格样本的换镜强度之和（0~1 的均值累加） */
  sums: Float64Array;
  /** 每格样本数；不足 `RHYTHM_MIN_SAMPLES` 的格不给数值 */
  counts: Int32Array;
}

export function createRhythmBins(): RhythmBins {
  return { sums: new Float64Array(RHYTHM_BINS), counts: new Int32Array(RHYTHM_BINS) };
}

export function resetRhythmBins(bins: RhythmBins): void {
  bins.sums.fill(0);
  bins.counts.fill(0);
}

/** 整幅画面近乎全黑（黑场/淡出/封面垫底）：这种帧读不出剪辑，只能算没有样本 */
function isBlankFrame(cells: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < cells.length; i += 1) {
    sum += cells[i] ?? 0;
    // 提前退出：只要累计到"平均每格 1 灰阶"以上就不是空帧，不必扫完
    if (sum > cells.length) return false;
  }
  return true;
}

/**
 * 相邻两帧的换镜强度（0~1）。
 *
 * 返回 `NaN` 表示"这一对帧不能用"（空帧），调用方不记账——把黑场当成一次大改动，
 * 片头淡入淡出会在节奏带上长成一座假山峰。
 * 首帧（`prev` 为 null）记 0：它只是建立基线，不代表画面平稳。
 */
export function fieldActivity(prev: Uint8Array | null, next: Uint8Array): number {
  if (next.length !== LUMA_CELLS || prev !== null && prev.length !== next.length) return NaN;
  if (isBlankFrame(next) || (prev !== null && isBlankFrame(prev))) return NaN;
  if (prev === null) return 0;
  let diff = 0;
  for (let i = 0; i < next.length; i += 1) {
    diff += Math.abs((next[i] ?? 0) - (prev[i] ?? 0));
  }
  const mean = diff / next.length;
  return Math.min(1, mean / CUT_FULL_DIFF);
}

/** 播放位置落在第几格；时长未知返回 -1（不记账，也不显示） */
export function rhythmBinOf(positionSec: number, durationSec: number): number {
  if (!(durationSec > 0) || !Number.isFinite(positionSec) || positionSec < 0) return -1;
  const ratio = Math.min(0.999999, positionSec / durationSec);
  return Math.floor(ratio * RHYTHM_BINS);
}

export function accumulateRhythm(bins: RhythmBins, bin: number, activity: number): void {
  if (bin < 0 || bin >= RHYTHM_BINS || !Number.isFinite(activity)) return;
  bins.sums[bin] = (bins.sums[bin] ?? 0) + activity;
  bins.counts[bin] = (bins.counts[bin] ?? 0) + 1;
}

/**
 * 每格的显示高度（0~1），没看过的格是 `Number.NaN`。
 *
 * NaN 而不是 0：0 会画出一根"确定很平"的矮柱，NaN 才是"这里还没有数据"，
 * UI 据此铺斜纹，用户不会把没播放过的段落读成慢节奏。
 */
export function rhythmValues(bins: RhythmBins): number[] {
  const raw = new Array<number>(RHYTHM_BINS).fill(Number.NaN);
  let max = 0;
  for (let i = 0; i < RHYTHM_BINS; i += 1) {
    const count = bins.counts[i] ?? 0;
    if (count < RHYTHM_MIN_SAMPLES) continue;
    const value = (bins.sums[i] ?? 0) / count;
    raw[i] = value;
    if (value > max) max = value;
  }
  const denom = Math.max(RHYTHM_NOISE_FLOOR, max);
  return raw.map((value) => (Number.isNaN(value) ? Number.NaN : Math.min(1, value / denom)));
}

/** 换镜点的格号（升序，相邻至少隔 `PEAK_MIN_SPACING` 格） */
export function rhythmPeaks(values: number[], bins: RhythmBins): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === undefined || Number.isNaN(value) || value < PEAK_AT) continue;
    if ((bins.counts[i] ?? 0) < RHYTHM_MIN_SAMPLES) continue;
    if ((rawMean(bins, i) ?? 0) < MIN_CUT_RAW) continue;
    const last = out[out.length - 1];
    if (last !== undefined && i - last < PEAK_MIN_SPACING) {
      // 更响的后来者顶掉前一个：同一片打戏不该标两遍
      if (value > (values[last] ?? 0)) out[out.length - 1] = i;
      continue;
    }
    out.push(i);
  }
  return out;
}

function rawMean(bins: RhythmBins, index: number): number | null {
  const count = bins.counts[index] ?? 0;
  if (count < RHYTHM_MIN_SAMPLES) return null;
  return (bins.sums[index] ?? 0) / count;
}

/** 已经有数值的格数：太少的阶段整条带不出现，免得半空的状态像画坏了 */
export function rhythmCoveredBins(values: number[]): number {
  let n = 0;
  for (const value of values) if (!Number.isNaN(value)) n += 1;
  return n;
}

/** 至少这么多格有数据才值得铺整条带（约全片 1/6 看过） */
export const RHYTHM_MIN_COVERED_BINS = 10;

/** 格号 → 该格中点的秒数（点击换镜点时的落点） */
export function rhythmBinCenterSec(bin: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return ((bin + 0.5) / RHYTHM_BINS) * durationSec;
}
