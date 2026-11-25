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
 * `resolvePlaybackEpisode` 是播放页的同口径版本：定位不到就返回"缺集"而不是首集，
 * 由页面显式披露，不再静默播第 1 集。
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

export function resolvePlaybackLineId(input: {
  explicitLineId: string | null;
  episodes: readonly { id: string; lineId: string }[];
  lineIds: readonly string[];
  episodeId: string | null;
  requestedLineId: string | null;
  anchorLineId: string | null;
}): string | null {
  if (input.explicitLineId) return input.explicitLineId;
  const ownerLineId = findEpisodeOwnerLineId(input.episodes, input.lineIds, input.episodeId);
  if (ownerLineId) return ownerLineId;
  if (input.requestedLineId && input.lineIds.includes(input.requestedLineId)) {
    return input.requestedLineId;
  }
  if (input.anchorLineId && input.lineIds.includes(input.anchorLineId)) {
    return input.anchorLineId;
  }
  return input.lineIds[0] ?? null;
}

/** 播放页目标集的定位口径；`none` = 全部口径都落空（P1-1 的披露态） */
export type EpisodeMatchedBy =
  | 'line-id'
  | 'deep-link'
  | 'history-number'
  | 'anchor'
  | 'cross-line-number'
  | 'first'
  | 'offline-first'
  | 'none';

export interface PlaybackEpisodeInput<T extends EpisodeLike> {
  /** 当前线路下的剧集（已按线路过滤） */
  lineEpisodes: T[];
  /** 全部线路的剧集，用于按 id 反查集号（跨线路集号一致，id 不同） */
  allEpisodes: readonly T[];
  /** 路由参数里的剧集 id */
  routeEpisodeId: string | null;
  /** 口令深链 `?ep=` 的集号 */
  deepLinkNumber?: number | null;
  /** 该 id 在历史记录里的集号 */
  historyNumber?: number | null;
  /** 黑匣子集号锚 */
  anchorNumber?: number | null;
  /** AC-68 判定为「已下线」的记录集号；非 null 时保留"回退首集 + 明示提示"的行为 */
  offlineNumber?: number | null;
}

export interface PlaybackEpisodeResolution<T extends EpisodeLike> {
  /** 定位到的剧集；`missing` 为 true 时是 null */
  episode: T | null;
  /** 目标集在当前线路内确实定位不到：调用方必须停下并披露，不能把首集当作目标集播 */
  missing: boolean;
  /** 命中的定位口径，供日志与测试断言 */
  matchedBy: EpisodeMatchedBy;
}

/**
 * 播放页目标集定位（P1-1）。
 *
 * 顺序：当前线路 id 精确命中 > 集号锚（深链 `?ep=` > 该 id 的历史集号 > 黑匣子集号锚
 * > 该 id 在其它线路的同号集）> AC-68 已下线回退首集 > 无路由 id 时取首集。
 *
 * 关键约束：带明确路由 id 且所有口径都落空时返回 `missing: true` 而不是首集——
 * 静默播首集会把进度写回、弹幕匹配、下载入口全都记到第 1 集上，用户看不出来
 * （真机日志里"回退首集"就是这个形态）。AC-68 的已下线分支自带「看到第 N 集
 * （已下线）」提示，属于已披露行为，保持回退首集。
 */
export function resolvePlaybackEpisode<T extends EpisodeLike>(
  input: PlaybackEpisodeInput<T>,
): PlaybackEpisodeResolution<T> {
  const list = input.lineEpisodes;
  if (list.length === 0) return { episode: null, missing: false, matchedBy: 'none' };

  const wanted = input.routeEpisodeId;
  if (wanted === null) {
    // 口令/黑匣子直达：没有集 id，按集号定位，落空则从头开始（本就是"从头看"语义）
    for (const [number, kind] of [
      [input.deepLinkNumber ?? null, 'deep-link'],
      [input.anchorNumber ?? null, 'anchor'],
    ] as const) {
      if (number === null) continue;
      const hit = list.find((ep) => ep.number === number);
      if (hit) return { episode: hit, missing: false, matchedBy: kind };
    }
    return { episode: list[0] ?? null, missing: false, matchedBy: 'first' };
  }

  const byId = list.find((ep) => ep.id === wanted);
  if (byId) return { episode: byId, missing: false, matchedBy: 'line-id' };

  // 该 id 属于另一条线路（用户手动定住了线路）时，按 AC-31 的集号口径在当前线路找同一集
  const crossLineNumber = input.allEpisodes.find((ep) => ep.id === wanted)?.number ?? null;
  for (const [number, kind] of [
    [input.deepLinkNumber ?? null, 'deep-link'],
    [input.historyNumber ?? null, 'history-number'],
    [input.anchorNumber ?? null, 'anchor'],
    [crossLineNumber, 'cross-line-number'],
  ] as const) {
    if (number === null || number === undefined) continue;
    const hit = list.find((ep) => ep.number === number);
    if (hit) return { episode: hit, missing: false, matchedBy: kind };
  }

  if (input.offlineNumber !== null && input.offlineNumber !== undefined) {
    return { episode: list[0] ?? null, missing: false, matchedBy: 'offline-first' };
  }

  return { episode: null, missing: true, matchedBy: 'none' };
}
