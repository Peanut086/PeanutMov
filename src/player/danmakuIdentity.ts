export interface DanmakuPlaybackIdentity {
  episodeId: string;
  episodeNumber: number;
  title: string;
  year: number | null;
  matchKey: string;
}

export interface DanmakuIdentityInput {
  episodeId: string | null;
  episodeNumber: number | null;
  localTaskTitle?: string | null;
  detailTitle?: string | null;
  detailYear?: number | null;
  historyTitle?: string | null;
  historyYear?: number | null;
  favoriteYear?: number | null;
}

export function resolveDanmakuIdentity(input: DanmakuIdentityInput): DanmakuPlaybackIdentity | null {
  if (input.episodeId === null || input.episodeNumber === null) return null;
  const title = input.localTaskTitle?.trim()
    || input.detailTitle?.trim()
    || input.historyTitle?.trim();
  if (!title) return null;
  const year = input.detailYear !== undefined
    ? input.detailYear
    : input.historyYear !== undefined
      ? input.historyYear
      : input.favoriteYear ?? null;
  return {
    episodeId: input.episodeId,
    episodeNumber: input.episodeNumber,
    title,
    year,
    matchKey: `${title}|${year ?? 'na'}|${input.episodeNumber}`,
  };
}

export function isSameDanmakuIdentity(
  current: DanmakuPlaybackIdentity | null,
  expected: DanmakuPlaybackIdentity,
): boolean {
  return current?.episodeId === expected.episodeId && current.matchKey === expected.matchKey;
}
