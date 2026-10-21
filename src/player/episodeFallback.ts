/**
 * 「继续观看」目标集定位（AC-36 / AC-68）
 *
 * 历史记录里存的是 `episodeId` + `episodeNumber`。源变更（剧集下线/换线路）后
 * 两者可能都对不上当前剧集列表，此时必须**显式区分**两种情况：
 * 1. 集号仍在当前源范围内，只是 id 变了 → 按集号命中，静默续播；
 * 2. 集号已超出当前源范围（如记录第 30 集、源只剩 20 集）→ 回退首集，
 *    并把 `offlineNumber` 交给调用方提示「看到第 N 集（已下线）」（AC-68）。
 *
 * 纯函数，不依赖 store/router，便于单测。
 */
export interface EpisodeLike {
  id: string;
  number: number;
}

export interface TargetEpisodeInput<T extends EpisodeLike> {
  /** 历史记录的剧集 id（可能已失效） */
  recordedEpisodeId: string | null;
  /** 历史记录的集号 */
  recordedNumber: number | null;
  /** 当前源/线路下的剧集（顺序不限） */
  episodes: T[];
}

export interface TargetEpisodeResolution<T extends EpisodeLike> {
  /** 目标集；找不到时为首集，无剧集时为 null */
  episode: T | null;
  /** 历史集号超出当前源范围时的集号（用于「已下线」提示），否则 null */
  offlineNumber: number | null;
}

/** 「已下线」提示文案（AC-68 指定措辞） */
export function offlineEpisodeMessage(number: number): string {
  return `看到第 ${number} 集（已下线），已从第 1 集开始`;
}

/**
 * 按 `episodeId` → `episodeNumber` 的顺序定位目标集。
 * 两者都命中不了且集号大于当前最大集号时，判定为「已下线」。
 */
export function resolveTargetEpisode<T extends EpisodeLike>(
  input: TargetEpisodeInput<T>,
): TargetEpisodeResolution<T> {
  const sorted = [...input.episodes].sort((a, b) => a.number - b.number);
  const first = sorted[0] ?? null;

  if (input.recordedEpisodeId !== null) {
    const byId = sorted.find((ep) => ep.id === input.recordedEpisodeId);
    if (byId) return { episode: byId, offlineNumber: null };
  }

  if (input.recordedNumber !== null) {
    const byNumber = sorted.find((ep) => ep.number === input.recordedNumber);
    if (byNumber) return { episode: byNumber, offlineNumber: null };
  }

  const maxNumber = sorted.length > 0 ? (sorted[sorted.length - 1]?.number ?? 0) : 0;
  const offlineNumber =
    sorted.length > 0 && input.recordedNumber !== null && input.recordedNumber > maxNumber
      ? input.recordedNumber
      : null;

  return { episode: first, offlineNumber };
}
