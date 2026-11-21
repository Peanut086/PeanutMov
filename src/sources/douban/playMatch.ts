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
      // 集数/更新后缀（嫁金钗 更新至12集、嫁金钗第12集、嫁金钗 全40集）
      .replace(/(更新至|更新到|更新)\d+([集话期])?$/g, '')
      .replace(/(全|共)\d+[集话期](全|完结)?$/g, '')
      .replace(/第\d+[集话期]$/g, '')
      .replace(/\d+[集话期](全|完结)$/g, '')
  );
}

/** 中文数字季号：支持「十」「十二」「二十」「二十三」，其余形态返回 null */
function chineseNumber(raw: string): number | null {
  const digitOf = (ch: string | undefined): number => '零一二三四五六七八九'.indexOf(ch ?? '');
  const tensAt = raw.indexOf('十');
  if (tensAt === -1) {
    const single = digitOf(raw[0]);
    return raw.length === 1 && single >= 0 ? single : null;
  }
  if (tensAt > 1 || raw.length > tensAt + 2) return null;
  const tens = tensAt === 0 ? 1 : digitOf(raw[0]);
  const ones = raw.length === tensAt + 1 ? 0 : digitOf(raw[tensAt + 1]);
  if (tens < 0 || ones < 0) return null;
  return tens * 10 + ones;
}

/**
 * 「第 2 季」/「第二季」/「第2部」/「Season 2」→ 2；无季号返回 null（单季剧与不带季号按同义处理）。
 *
 * `stripTitleNoise` 会把季号整段剥掉，所以「士兵突击」与「士兵突击 第2季」在它眼里是同一部片；
 * 需要区分季号的场合（弹幕选片、串片校验）单独用它。
 */
export function seasonOfTitle(title: string): number | null {
  const normalized = normalizeTitleForMatch(title);
  const latin = /(?:season|part)([0-9]+)/.exec(normalized);
  if (latin !== null) return Number(latin[1]);
  const match = /第([0-9一二三四五六七八九十]+)[季部]/.exec(normalized);
  if (match === null) return null;
  const raw = match[1] ?? '';
  return /^\d+$/.test(raw) ? Number(raw) : chineseNumber(raw);
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

/**
 * 从一堆源的搜索结果里挑出可切换来源的候选（每个源只保留一条）。
 *
 * 与 pickPlayCandidates 的区别：
 * - 允许 alist/webdav/jellyfin 等本地媒体库源（不限于 site/spider）；
 * - 每个 sourceId 只保留一条（优先年份精确匹配）；
 * - 不排序，排序交给视图层（按可播性/健康/延迟）。
 */
export interface SourceCandidateItem {
  source: Source;
  item: MediaItem;
}

export function pickSourceCandidates(
  targetTitle: string,
  targetYear: number | null,
  results: MediaItem[],
  sourceById: ReadonlyMap<string, Source>,
  opts?: { excludeSourceId?: string; excludeMediaId?: string },
): SourceCandidateItem[] {
  const matched = new Map<string, SourceCandidateItem>();
  for (const item of results) {
    const source = sourceById.get(item.sourceId);
    if (source === undefined) continue;
    if (!source.enabled) continue;
    // 排除只有元数据的豆瓣源
    if (source.type === 'douban') continue;
    // 排除当前源
    if (opts?.excludeSourceId && source.id === opts.excludeSourceId) continue;
    // 排除当前条目
    if (opts?.excludeMediaId && item.id === opts.excludeMediaId) continue;
    if (!isTitleMatch(targetTitle, targetYear, item)) continue;
    // 每个源只保留一条：优先年份精确匹配
    const existing = matched.get(source.id);
    if (!existing) {
      matched.set(source.id, { source, item });
      continue;
    }
    // 已有候选但当前条目的年份更精确
    if (targetYear !== null && item.year === targetYear && existing.item.year !== targetYear) {
      matched.set(source.id, { source, item });
    }
  }
  return [...matched.values()];
}
