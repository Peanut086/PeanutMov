import { lookupAliases } from '@/services/aliasService';
import { showIdentityOf } from '@/services/searchAggregate';
import { settingsService } from '@/services/settingsService';
import { historyIdOf } from '@/shared/id';
import { parseEpisodeIndex, toHalfWidth } from '@/sources/mapping/TitleNormalizer';
import type { HistoryRecord } from '@/types';

export interface PlaybackProgressTarget {
  sourceId: string;
  mediaId: string;
  title: string;
  year?: number | null;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
}

export interface PlaybackHistoryRecord extends HistoryRecord {
  episodeTitle?: string | null;
}

export interface CrossSourceProgressMatch<R extends PlaybackHistoryRecord = PlaybackHistoryRecord> {
  record: R;
  episodeNumber: number;
}

export interface PlaybackProgressMatch<R extends PlaybackHistoryRecord = PlaybackHistoryRecord> {
  record: R;
  episodeNumber: number | null;
}

const ALIAS_LOOKUP_LIMIT = 6;

const EPISODE_MARKER =
  /(?:\bs\s*[0-9]{1,2}\s*e\s*[0-9]{1,4}\b|第\s*(?:[0-9]{1,4}|[一二两三四五六七八九十百零]+)\s*[集话期回]|\b(?:ep|e)\s*[._-]?\s*(?:[0-9]{1,4}|[一二两三四五六七八九十百零]+)\b)/i;

/** 去掉集号写法后的分集标题键；只剩集号时视为未提供明确标题。 */
function episodeTitleKey(title: string | null | undefined): string {
  const text = toHalfWidth(title ?? '').toLowerCase().trim();
  if (text === '') return '';
  const rest = text.replace(EPISODE_MARKER, ' ').trim();
  if (/^[0-9]{1,3}$/.test(rest)) return '';
  return rest.replace(/[^\p{L}\p{N}]+/gu, '');
}

export async function resolvePlaybackProgress<R extends PlaybackHistoryRecord>(
  target: PlaybackProgressTarget,
  records: readonly R[],
): Promise<PlaybackProgressMatch<R> | null> {
  const exactId = historyIdOf(target.sourceId, target.mediaId);
  const exact = records.find((record) => record.id === exactId);
  if (exact) return { record: exact, episodeNumber: exact.episodeNumber };
  const direct = findCrossSourceProgress(target, records);
  if (direct) return direct;
  return findCrossSourceProgress(target, records, await learnedAliasesOf(target));
}

/** 详情页需要先确定“看到哪一集”，因此按同作品同季选最近一条跨源记录。 */
export async function resolveLatestPlaybackProgress<R extends PlaybackHistoryRecord>(
  target: PlaybackProgressTarget,
  records: readonly R[],
): Promise<PlaybackProgressMatch<R> | null> {
  const exactId = historyIdOf(target.sourceId, target.mediaId);
  const exact = records.find((record) => record.id === exactId);
  if (exact) return { record: exact, episodeNumber: exact.episodeNumber };
  const direct = findLatestCrossSourceProgress(target, records);
  if (direct) return direct;
  return findLatestCrossSourceProgress(target, records, await learnedAliasesOf(target));
}

async function learnedAliasesOf(target: PlaybackProgressTarget): Promise<string[]> {
  try {
    const settings = await settingsService.get();
    if (!settings.pauseHistoryRecording) return await lookupAliases(target.title, ALIAS_LOOKUP_LIMIT);
  } catch {
    // 别名是可选增强；读取失败时保持纯归一化匹配结果。
  }
  return [];
}

export function findCrossSourceProgress<R extends PlaybackHistoryRecord>(
  target: PlaybackProgressTarget,
  records: readonly R[],
  aliasTitles: readonly string[] = [],
): CrossSourceProgressMatch<R> | null {
  const wanted = showIdentityOf(target.title);
  if (wanted.root === '' || wanted.crossSeason) return null;
  const aliasRoots = new Set(
    aliasTitles
      .map((title) => showIdentityOf(title))
      .filter((identity) => identity.root !== '' && !identity.crossSeason)
      .map((identity) => identity.root),
  );
  const wantedEpisodeNumber = target.episodeNumber ?? parseEpisodeIndex(target.episodeTitle);
  if (
    wantedEpisodeNumber === null ||
    !Number.isInteger(wantedEpisodeNumber) ||
    wantedEpisodeNumber <= 0
  ) {
    return null;
  }
  const wantedEpisodeTitle = episodeTitleKey(target.episodeTitle);

  const matches: Array<CrossSourceProgressMatch<R> & { strength: number; updatedAt: number }> = [];
  for (const record of records) {
    if (record.sourceId === target.sourceId) continue;
    const candidate = showIdentityOf(record.title);
    if (candidate.root === '' || candidate.crossSeason) continue;
    const directRoot = candidate.root === wanted.root;
    if (!directRoot && !aliasRoots.has(candidate.root)) continue;
    if (candidate.season !== wanted.season) continue;
    if (target.year != null && record.mediaSnapshot?.year != null && target.year !== record.mediaSnapshot.year) continue;
    if (record.episodeNumber === null || !Number.isInteger(record.episodeNumber) || record.episodeNumber <= 0) continue;
    if (record.episodeNumber !== wantedEpisodeNumber) continue;
    const candidateEpisodeTitle = episodeTitleKey(record.episodeTitle);
    if (wantedEpisodeTitle !== '' && candidateEpisodeTitle !== '' && wantedEpisodeTitle !== candidateEpisodeTitle) continue;
    matches.push({
      record,
      episodeNumber: record.episodeNumber,
      strength: directRoot ? 2 : 1,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    });
  }
  return newestUniqueMatch(matches);
}

export function findLatestCrossSourceProgress<R extends PlaybackHistoryRecord>(
  target: PlaybackProgressTarget,
  records: readonly R[],
  aliasTitles: readonly string[] = [],
): CrossSourceProgressMatch<R> | null {
  const wanted = showIdentityOf(target.title);
  if (wanted.root === '' || wanted.crossSeason) return null;
  const aliasRoots = new Set(
    aliasTitles
      .map((title) => showIdentityOf(title))
      .filter((identity) => identity.root !== '' && !identity.crossSeason)
      .map((identity) => identity.root),
  );
  const matches: Array<CrossSourceProgressMatch<R> & { strength: number; updatedAt: number }> = [];
  for (const record of records) {
    if (record.sourceId === target.sourceId) continue;
    const candidate = showIdentityOf(record.title);
    if (candidate.root === '' || candidate.crossSeason || candidate.season !== wanted.season) continue;
    const directRoot = candidate.root === wanted.root;
    if (!directRoot && !aliasRoots.has(candidate.root)) continue;
    if (target.year != null && record.mediaSnapshot?.year != null && target.year !== record.mediaSnapshot.year) continue;
    if (record.episodeNumber === null || !Number.isInteger(record.episodeNumber) || record.episodeNumber <= 0) continue;
    matches.push({
      record,
      episodeNumber: record.episodeNumber,
      strength: directRoot ? 2 : 1,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    });
  }
  return newestUniqueMatch(matches);
}

function newestUniqueMatch<R extends PlaybackHistoryRecord>(
  matches: Array<CrossSourceProgressMatch<R> & { strength: number; updatedAt: number }>,
): CrossSourceProgressMatch<R> | null {
  if (matches.length === 0) return null;
  const strongest = Math.max(...matches.map((match) => match.strength));
  const latest = Math.max(...matches.filter((match) => match.strength === strongest).map((match) => match.updatedAt));
  const newest = matches.filter((match) => match.strength === strongest && match.updatedAt === latest);
  if (newest.length !== 1) return null;
  const { record, episodeNumber } = newest[0]!;
  return { record, episodeNumber };
}
