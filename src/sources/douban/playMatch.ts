/**
 * 跨源播放匹配（「发现源」借 CMS 源的片源）
 *
 * 背景：豆瓣这类源只提供元数据（片名/海报/评分），没有 `vod_play_url`。
 * 播放时需要去 CMS 采集站按片名搜索，再把那边的播放地址接过来。
 *
 * 串片是这个方案的主要风险，因此匹配分三层：
 * 1. 片名归一化后**必须**完全相等（去掉年份、季、集数、标点）；
 * 2. 年份必须一致（任一缺年份时跳过该校验）；
 * 3. 满足条件的候选按源质量排序（CHG-12），播放时首个失败顺延下一个。
 *
 * 无法归一化或任一条件不满足时返回空，由上层明确告知「没找到可播放的源」，
 * 不猜测、不降级——串一部片比播不出来更糟。
 */
import type { MediaItem, Source } from '@/types';
import { HEALTH_TIER_ORDER, healthTierOf, type HealthTier } from '@/shared/healthTier';

/** 归一化片名：去空白、全角转半角、只保留中日韩文字/字母/数字 */
export function normalizeTitleForMatch(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

/**
 * 去掉标题里的修饰后缀，让「流浪地球2」「流浪地球(2023)」「流浪地球 第2季」都能归到同一根。
 * 只剥尾部片段，不动标题主体。
 */
export function stripTitleNoise(title: string): string {
  return (
    normalizeTitleForMatch(title)
      // 第N季/第N部/第N部曲、Season N、Part N
      .replace(/(第[0-9一二三四五六七八九十]+[季部])/g, '')
      .replace(/(season|part)\d+/g, '')
      // 预告片/花絮/幕后/纪录片等非正片
      .replace(/(预告片|花絮|幕后|特辑|纪录片|未删减|完整版|纯净版|hd|bd|1080p|4k|2k)$/g, '')
      // 年份
      .replace(/\(?(19|20)\d{2}\)?/g, '')
      .replace(/20\d{2}年?/g, '')
  );
}

export interface PlayCandidate {
  source: Source;
  item: MediaItem;
}

/** 单条搜索结果是否与目标片名匹配 */
export function isTitleMatch(targetTitle: string, targetYear: number | null, candidate: MediaItem): boolean {
  const a = stripTitleNoise(targetTitle);
  const b = stripTitleNoise(candidate.title);
  if (a.length === 0 || b.length === 0) return false;
  if (a !== b) return false;
  // 年份校验：双方都有年份时必须一致，任一缺失则放过
  if (targetYear !== null && candidate.year !== null && targetYear !== candidate.year) return false;
  return true;
}

/**
 * 从一堆源的搜索结果里挑出全部能播的条目，按源质量排序（CHG-12）：
 * 健康档位 → 探测延迟（null 最后）→ 保持搜索结果的原始顺序。
 * 不传 `latencyOf` 时不排序（按原始顺序），供无健康快照的测试与旧调用方使用。
 */
export function pickPlayCandidates(
  targetTitle: string,
  targetYear: number | null,
  results: MediaItem[],
  sourceById: ReadonlyMap<string, Source>,
  latencyOf?: (sourceId: string) => number | null,
): PlayCandidate[] {
  const matched: PlayCandidate[] = [];
  for (const item of results) {
    const source = sourceById.get(item.sourceId);
    if (source === undefined) continue;
    // 只从「自带片源」的源借播放地址；其它发现源同样没有播放能力
    if (source.type !== 'site' && source.type !== 'spider') continue;
    if (!source.enabled) continue;
    if (isTitleMatch(targetTitle, targetYear, item)) {
      matched.push({ source, item });
    }
  }
  if (matched.length === 0 || latencyOf === undefined) return matched;

  const tierOf = (candidate: PlayCandidate): HealthTier =>
    healthTierOf(candidate.source.health, latencyOf(candidate.source.id));
  return matched.sort((a, b) => {
    const tierDiff = HEALTH_TIER_ORDER[tierOf(a)] - HEALTH_TIER_ORDER[tierOf(b)];
    if (tierDiff !== 0) return tierDiff;
    const latencyA = latencyOf(a.source.id);
    const latencyB = latencyOf(b.source.id);
    const rankA = latencyA === null || !Number.isFinite(latencyA) ? Number.POSITIVE_INFINITY : latencyA;
    const rankB = latencyB === null || !Number.isFinite(latencyB) ? Number.POSITIVE_INFINITY : latencyB;
    return rankA - rankB;
  });
}

/** 从一堆源的搜索结果里挑出能播的条目（质量最优的一个）；都不匹配返回 null */
export function pickPlayCandidate(
  targetTitle: string,
  targetYear: number | null,
  results: MediaItem[],
  sourceById: ReadonlyMap<string, Source>,
  latencyOf?: (sourceId: string) => number | null,
): PlayCandidate | null {
  return pickPlayCandidates(targetTitle, targetYear, results, sourceById, latencyOf)[0] ?? null;
}
