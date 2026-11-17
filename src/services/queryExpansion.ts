/**
 * 搜索查询扩展（SO-ALIAS 基础层，纯函数无 IO）
 *
 * 解决"同一部片的不同写法搜不到"：
 * 1. **季号形态**——`权游 第八季` / `权游S8` / `Season VIII` 归一后互转；
 *    续集号（`流浪地球2`）与季号语义不同，不做裸数字互转，宁缺毋滥；
 * 2. **别名命中**——由 `aliasService` 提供（用户真实点击学出来的形态映射）。
 *
 * 扩展词只在原词 0 结果时使用（见 libraryStore 的接线），且与全半角/标点归一化
 * 同步进行；去重口径是**字面等价**（大小写/空白折叠后相同）而不是语义等价——
 * 源站检索按字面 LIKE，「庆余年 第八季」与「庆余年S8」在 normalizeTitleKey 下
 * 同形，但对源站就是两个不同的查询，恰好是我们要互转的对象。
 */
import {
  parseChineseNumber,
  stripTitleSuffixes,
  toHalfWidth,
} from '@/sources/mapping/TitleNormalizer';

/** 输入清洗：全半角、去《》等包裹标点、空白折叠（发给源站的词用它） */
export function canonicalizeQuery(raw: string): string {
  return toHalfWidth(raw ?? '')
    .replace(/[《》「」【】[\]（）()〈〉]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 字面比对键：半角 + 小写 + 去空白。仅季号写法不同视为不同查询形态 */
function literalKey(text: string): string {
  return toHalfWidth(text).toLowerCase().replace(/\s+/g, '');
}

const ROMAN_VALUES: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10, l: 50 };

/** Unicode 罗马数字区（U+2160-217F）→ ASCII 写法；Ⅷ/ⅻ 等是「合字」，不能按单字符映射 */
const ROMAN_ASCII = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'l', 'c', 'd', 'm'];

/** 罗马数字（减记规则，xiv=14；i-lx 足够覆盖季数）→ 阿拉伯；不识别返回 null */
export function parseRomanNumber(raw: string | null | undefined): number | null {
  let text = toHalfWidth(String(raw ?? '')).toLowerCase().trim();
  if (text.length === 0) return null;
  if (/^[0-9]+$/.test(text)) return Number.parseInt(text, 10);
  text = text.replace(/[\u2160-\u217f]/g, (ch) => ROMAN_ASCII[ch.charCodeAt(0) & 0xf] ?? ch);
  let total = 0;
  let prev = 0;
  for (const ch of text) {
    const value = ROMAN_VALUES[ch];
    if (value === undefined) return null;
    // 减记：小值在大值前（ix=9、xiv=14），按「已加两次小值」折算
    total += value > prev ? value - 2 * prev : value;
    prev = value;
  }
  return total > 0 && total <= 50 ? total : null;
}

interface SeasonToken {
  season: number;
  /** 命中的原文片段（用于剥离出片名根） */
  token: string;
}

/** 从关键词里找季号标注：第N季/部、Season N、S8（含罗马数字）；找不到返回 null */
function findSeasonToken(text: string): SeasonToken | null {
  const cn = /第\s*([0-9]{1,3}|[一二两三四五六七八九十百零]+)\s*([季部])/.exec(text);
  if (cn?.[1] !== undefined) {
    const num = parseChineseNumber(cn[1]);
    if (num !== null && num <= 50) return { season: num, token: cn[0] };
  }
  const en = /\bseason\s+([0-9]{1,2}|[ivxl]{1,6})\b/i.exec(text);
  if (en?.[1] !== undefined) {
    const num = parseRomanNumber(en[1]);
    if (num !== null) return { season: num, token: en[0] };
  }
  const short = /\bs\s*\.?\s*([0-9]{1,2}|[ivxl]{1,6})\b/i.exec(text);
  if (short?.[1] !== undefined) {
    // 「S8」必须独立成词或紧跟片名；单字母+数字误命中概率低，接受
    const num = parseRomanNumber(short[1]);
    if (num !== null && (short[1].length > 1 || /[0-9]/.test(short[1]))) return { season: num, token: short[0] };
  }
  return null;
}

/**
 * 季号形态互转：`庆余年 第八季` → [`庆余年S8`（若原词不是该形态）]，反之给出 `第8季` 形态。
 * 无季号标注时返回空数组（续集号≠季号，绝不猜）。
 */
export function seasonFormVariants(keyword: string): string[] {
  const text = canonicalizeQuery(keyword);
  if (text.length === 0) return [];
  const found = findSeasonToken(text);
  if (!found) return [];
  const root = text
    .replace(found.token, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (root.length < 2) return [];
  const out: string[] = [];
  const cnForm = `${root}第${found.season}季`;
  const sForm = `${root}S${found.season}`;
  const base = literalKey(text);
  for (const variant of [cnForm, sForm]) {
    // 只滤"与原词字面相同"的形态：`第八季`↔`S8` 语义同形但字面不同，正是转换目标
    if (literalKey(variant) === base) continue;
    if (!out.includes(variant)) out.push(variant);
  }
  return out;
}

/** 关键词里的季号（对外口径：别名替换时要把季号带回去）；无标注返回 null */
export function parseSeasonOf(keyword: string): number | null {
  return findSeasonToken(canonicalizeQuery(keyword))?.season ?? null;
}

/**
 * 组装扩展候选（按收益排序）：别名形态在前（真实点击证据），季号互转在后（规则兜底）。
 * 与规范词等价、彼此重复的都会剔除，最多返回 `limit` 条。
 */
export function expansionCandidates(keyword: string, aliasTitles: readonly string[], limit = 2): string[] {
  const canonical = canonicalizeQuery(keyword);
  const base = literalKey(canonical);
  if (base.length === 0) return [];
  const season = parseSeasonOf(keyword);
  const out: string[] = [];
  const pushed = new Set<string>();
  const take = (candidate: string): void => {
    let cleaned = canonicalizeQuery(candidate);
    // 别名形态不带季号而原词带季号时，把季号贴回去——否则"权游S8"会扩出整部剧的其他季
    if (season !== null && cleaned.length > 0 && parseSeasonOf(cleaned) === null) {
      cleaned = `${cleaned}第${season}季`;
    }
    const key = literalKey(cleaned);
    if (key.length === 0 || key === base || pushed.has(key)) return;
    pushed.add(key);
    out.push(cleaned);
  };
  for (const alias of aliasTitles) take(alias);
  for (const variant of seasonFormVariants(keyword)) take(variant);
  return out.slice(0, Math.max(0, limit));
}

/** 片名根（展示/存储别名桶的键口径；复用 TitleNormalizer 避免双口径漂移） */
export function titleRoot(title: string): string {
  return stripTitleSuffixes(title);
}
