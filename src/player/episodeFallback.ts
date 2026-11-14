/**
 * 「继续观看」目标集定位（AC-36 / AC-68）
 *
 * 历史记录里存的是 `episodeId` + `episodeNumber`。源变更（剧集下线/换线路）后
 * 两者可能都对不上当前剧集列表，此时必须**显式区分**两种情况：
 * 1. 集号仍在当前源范围内，只是 id 变了 → 按集号命中，静默续播；
 * 2. 集号已超出当前源范围（如记录第 30 集、源只剩 20 集）→ 回退首集，
 *    并把 `offlineNumber` 交给调用方提示「看到第 N 集（已下线）」（AC-68）。
 *
 * 附带的 `findEpisodeOwnerLineId` 解决同一类"id 对不上线路"的问题：
 * 一个媒体里每集的 id 只属于它所在的那条线路，拿 id 反查线路比拿首条线路靠谱。
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

/**
 * 按剧集 id 反查它真正所属、且仍在可选线路列表里的那条线路。
 *
 * 详情尚未加载、该集不属于任何线路、或所属线路已被过滤掉时返回 null，
 * 由调用方决定下一步（而不是拿首条线路硬套——那会让目标集的 id 落在列表外，
 * 最终回退到第 1 集）。
 */
export function findEpisodeOwnerLineId(
  episodes: readonly { id: string; lineId: string }[],
  lineIds: readonly string[],
  episodeId: string | null,
): string | null {
  if (!episodeId) return null;
  const ownerLineId = episodes.find((ep) => ep.id === episodeId)?.lineId;
  return ownerLineId && lineIds.includes(ownerLineId) ? ownerLineId : null;
}
