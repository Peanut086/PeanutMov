/**
 * 平台搜索结果选片：片名精度与年份的分层判据
 *
 * 各站搜索结果的字段名不同，但选片的坑相同：**年份不许越过片名精度**。
 * 资源站给的 `vod_year` 与平台自己的季年份经常对不上（2006 年的《士兵突击》被标成 2013，
 * 而 2013 年腾讯恰好有一档同名不同内容的《士兵突击 第2季》），一旦「年份命中」优先于
 * 「完全同名」，整集弹幕就会串到另一部片上——时间轴、内容全都对不上。
 *
 * 因此统一按两层判：
 * 1. 先按片名精度取最高分候选池（归一化相等 > 去噪后相等）；
 * 2. 年份只在池内做优选；池内年份能校验却全都对不上时不采用（宁缺毋滥）。
 */
import { normalizeTitleForMatch, stripTitleNoise } from '@/sources/douban/playMatch';

const SEARCH_YEAR_IN_BRACKETS = /[（(【[]\s*(?:19|20)\d{2}\s*年?\s*[）)】\]]/g;
const SEARCH_YEAR_AT_TAIL = /(?:\s+|[-_/·])(?:19|20)\d{2}\s*(?:年版|版)?$/;
const SEARCH_UPDATE_SUFFIX = /(?:更新至|更新到|更新)\s*\d+\s*[集话期]?(?:\s*[全完结])?$/;
const SEARCH_COUNT_SUFFIX = /(?:全|共)\s*\d+\s*[集话期](?:\s*[全完结])?$/;

/** Provider 搜索词：只去非身份后缀，季号与片名数字必须原样保留。 */
export function cleanDanmakuSearchTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(SEARCH_YEAR_IN_BRACKETS, '')
    .replace(SEARCH_UPDATE_SUFFIX, '')
    .replace(SEARCH_COUNT_SUFFIX, '')
    .replace(SEARCH_YEAR_AT_TAIL, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || title.trim();
}

/** 片名匹配精度：2 = 归一化完全相等，1 = 去掉季号/年份/集数后相等，0 = 不相关 */
export function titleMatchScore(candidateTitle: string, queryTitle: string): number {
  const targetExact = normalizeTitleForMatch(queryTitle);
  const targetLoose = stripTitleNoise(queryTitle);
  if (targetLoose.length === 0) return 0;
  const normalized = normalizeTitleForMatch(candidateTitle);
  if (normalized.length === 0) return 0;
  if (normalized === targetExact) return 2;
  return stripTitleNoise(candidateTitle) === targetLoose ? 1 : 0;
}

/** 参与选片的候选都要带这两项：`score` 见 `titleMatchScore`，`year` 为 null 表示不可校验 */
export interface Scored {
  score: number;
  year: number | null;
}

/**
 * 从候选里挑一条：先在最高片名精度的池内选，年份只作池内优选。
 * 池内没有年份命中、但存在带年份的候选时返回 null，交给调用方继续回退下一个源。
 */
export function pickCandidate<T extends Scored>(candidates: T[], queryYear: number | null): T | null {
  let best = 0;
  for (const candidate of candidates) {
    if (candidate.score > best) best = candidate.score;
  }
  if (best === 0) return null;
  const pool = candidates.filter((candidate) => candidate.score === best);
  if (queryYear !== null) {
    const sameYear = pool.find((candidate) => candidate.year === queryYear);
    if (sameYear !== undefined) return sameYear;
    // 年份能校验却全都对不上，宁可无弹幕也不串到别的季
    if (pool.some((candidate) => candidate.year !== null)) return null;
  }
  return pool[0] ?? null;
}
