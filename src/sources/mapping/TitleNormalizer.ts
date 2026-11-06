/**
 * 标题归一化（FIX-05 豆瓣跨源集数映射）
 *
 * 跨源匹配需要回答两个问题：
 * 1. 两个片名是不是同一部作品？「庆余年第二季」「庆余年 2」「庆余年(2024) 高清」都应归到「庆余年」；
 * 2. 归到同一根还不够——续集号（流浪地球 / 流浪地球2）与季号（第1季 / 第2季）
 *    冲突时必须判为**不同**作品，否则会把第二季的播放地址串到第一季上。
 *
 * 纯字符串处理，不依赖网络/存储，便于单测。
 *
 * 与 `src/sources/douban/playMatch.ts` 的关系：playMatch 的 `stripTitleNoise` 负责
 * 「候选是否同一部片」的严格相等判定；本模块在其之外补充季号/续集号消解与相似度，
 * 供集数映射（以及 spider 的按片名查集）使用，两者口径互不覆盖。
 */

/** 归一化后标题的最大比对长度（防御超长脏数据，避免编辑距离 O(n²) 失控） */
const MAX_KEY_LENGTH = 80;

/** 默认相似度阈值：>= 该值视为同一部片（精确键相等恒为 1） */
export const DEFAULT_TITLE_THRESHOLD = 0.82;

/** 常见修饰词（画质 / 版本 / 语言 / 广告），归一化时剔除 */
const NOISE_TOKENS: readonly string[] = [
  '高清',
  '超清',
  '蓝光',
  '原画',
  '完整版',
  '未删减',
  '加长版',
  '导演剪辑版',
  '国语',
  '粤语',
  '中字',
  '中文字幕',
  '双语',
  '正式版',
  '抢先版',
  '枪版',
  'hd',
  'bd',
  'dvd',
  'hdr',
  '1080p',
  '720p',
  '2160p',
  '4k',
  '2k',
];

/** 全角 → 半角（含全角空格） */
export function toHalfWidth(input: string): string {
  return input
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 中文/阿拉伯数字 → 数字（"二"→2、"十二"→12、"二十"→20、"一百零一"→101）。
 * 无法解析返回 null。
 */
export function parseChineseNumber(value: string | null | undefined): number | null {
  const text = String(value ?? '').trim();
  if (text.length === 0) return null;
  if (/^[0-9]+$/.test(text)) {
    const num = Number.parseInt(text, 10);
    return Number.isFinite(num) ? num : null;
  }
  let total = 0;
  let current = 0;
  let seen = false;
  for (const ch of text) {
    if (ch === '十') {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
      seen = true;
      continue;
    }
    if (ch === '百') {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
      seen = true;
      continue;
    }
    const digit = CN_DIGITS[ch];
    if (digit === undefined) return null;
    if (digit === 0) {
      seen = true;
      continue;
    }
    current = digit;
    seen = true;
  }
  if (!seen) return null;
  const result = total + current;
  return result > 0 ? result : null;
}

/** 归一化键：去季/部/集/年份/修饰词/标点/空白，统一大小写与全半角 */
export function normalizeTitleKey(title: string | null | undefined): string {
  if (typeof title !== 'string') return '';
  let text = toHalfWidth(title).toLowerCase();
  // 括号内容（年份、清晰度、语言标注、「第2季」等）
  text = text.replace(/[（(【[][^）)】\]]*[）)】\]]/g, ' ');
  // 季 / 部 / 篇
  text = text.replace(/第\s*(?:[0-9]{1,3}|[一二两三四五六七八九十百零]+)\s*[季部篇]/g, ' ');
  // 集 / 话 / 期 / 回（有些源把单集当成独立条目）
  text = text.replace(/第\s*(?:[0-9]{1,4}|[一二两三四五六七八九十百零]+)\s*[集话期回]/g, ' ');
  // Season N / Part N / S1
  text = text.replace(/\b(?:season|series|part|s)\s*[0-9]{1,2}\b/g, ' ');
  // 仅剥掉「末尾」年份，避免把「2001太空漫游」的片名年份当后缀
  text = text.replace(/(?:19|20)[0-9]{2}\s*(?:年|年度|版)?\s*$/, ' ');
  for (const token of NOISE_TOKENS) text = text.split(token).join(' ');
  // 只保留中日韩文字 / 拉丁字母 / 数字
  return text
    .replace(/[^0-9a-z\u4e00-\u9fa5\u3040-\u30ff]/g, '')
    .slice(0, MAX_KEY_LENGTH);
}

/** 去除季/部/年份后缀后的「片名根」（对外暴露的语义化别名） */
export function stripTitleSuffixes(title: string | null | undefined): string {
  return normalizeTitleKey(title);
}

/** 季号：第2季 / 第二部 / Season 2 / S02 → 2；解析不到返回 null */
export function parseSeasonNumber(title: string | null | undefined): number | null {
  const text = toHalfWidth(String(title ?? '')).toLowerCase();
  const cn = /第\s*([0-9]{1,3}|[一二两三四五六七八九十百零]+)\s*[季部篇]/.exec(text);
  if (cn && cn[1] !== undefined) {
    const num = parseChineseNumber(cn[1]);
    if (num !== null) return num;
  }
  const en = /\b(?:season|series)\s*([0-9]{1,2})\b/.exec(text);
  if (en && en[1] !== undefined) return Number.parseInt(en[1], 10);
  const short = /\bs\s*([0-9]{1,2})\b/.exec(text);
  if (short && short[1] !== undefined) return Number.parseInt(short[1], 10);
  return null;
}

/**
 * 集号：第5集 / 第五话 / EP05 / E05 / S01E05 / 纯数字 → 5；解析不到返回 null。
 * 只用于剧集标题，不用于片名（片名里的数字是续集号，语义不同）。
 */
export function parseEpisodeIndex(title: string | null | undefined): number | null {
  const text = toHalfWidth(String(title ?? '')).toLowerCase().trim();
  if (text.length === 0) return null;
  const cn = /第\s*([0-9]{1,4}|[一二两三四五六七八九十百零]+)\s*[集话期回]/.exec(text);
  if (cn && cn[1] !== undefined) {
    const num = parseChineseNumber(cn[1]);
    if (num !== null) return num;
  }
  const se = /\bs\s*[0-9]{1,2}\s*e\s*([0-9]{1,4})\b/.exec(text);
  if (se && se[1] !== undefined) return Number.parseInt(se[1], 10);
  const ep = /\b(?:ep|e)\s*[._-]?\s*([0-9]{1,4})\b/.exec(text);
  if (ep && ep[1] !== undefined) return Number.parseInt(ep[1], 10);
  // 纯数字（`05` / `5`）：排除年份与 4 位以上（码率/时间码误命中）
  if (/^[0-9]{1,3}$/.test(text)) return Number.parseInt(text, 10);
  return null;
}

/** 年份：19xx / 20xx（取第一个）；解析不到返回 null */
export function parseYear(title: string | null | undefined): number | null {
  const match = /(?:19|20)[0-9]{2}/.exec(toHalfWidth(String(title ?? '')));
  if (!match) return null;
  const year = Number.parseInt(match[0], 10);
  return year >= 1900 && year <= 2100 ? year : null;
}

/** 编辑距离（Levenshtein） */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = new Array<number>(b.length + 1);
  let curr: number[] = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** 标注相似度（0-1）：按归一化键计算编辑距离 */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const keyA = normalizeTitleKey(a ?? '');
  const keyB = normalizeTitleKey(b ?? '');
  if (keyA.length === 0 || keyB.length === 0) return 0;
  if (keyA === keyB) return 1;
  const distance = editDistance(keyA, keyB);
  return Math.max(0, 1 - distance / Math.max(keyA.length, keyB.length));
}

export interface TitleKeys {
  /** 去后缀后的片名根 */
  key: string;
  /** 显式季/部号；无标注为 null */
  season: number | null;
}

/** 片名 → { 根, 季号 } */
export function titleKeysOf(title: string | null | undefined): TitleKeys {
  return { key: normalizeTitleKey(title), season: parseSeasonNumber(title) };
}

/** 键尾的续集号（`流浪地球2` → "2"；无数字 → ""） */
function trailingNumber(key: string): string {
  const match = /([0-9]{1,4})$/.exec(key);
  return match?.[1] ?? '';
}

/**
 * 片名相似度评分（0-1）：
 * - 0 表示**明确不是同一部片**（季号冲突 / 续集号冲突）；
 * - 1 表示归一化键完全一致；
 * - 其余为编辑距离相似度，含「短名被长名包含」时的宽松加成。
 *
 * 季号消解：一侧写「第2季」、另一侧写「片名2」（如 庆余年第二季 / 庆余年2）时，
 * 把对端的尾部数字按季号消解后再比，避免漏匹配；两侧都没有季号标注时，
 * 尾部数字视为续集号（流浪地球 / 流浪地球2 必须区分）。
 */
export function titleMatchScore(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = titleKeysOf(a ?? '');
  const right = titleKeysOf(b ?? '');
  if (left.key.length === 0 || right.key.length === 0) return 0;
  if (left.season !== null && right.season !== null && left.season !== right.season) return 0;

  const season = left.season ?? right.season;
  const stripSeasonDigits = (key: string): string => {
    if (season === null) return key;
    const trailing = trailingNumber(key);
    return trailing === String(season) ? key.slice(0, key.length - trailing.length) : key;
  };
  const keyA = stripSeasonDigits(left.key);
  const keyB = stripSeasonDigits(right.key);
  if (keyA.length === 0 || keyB.length === 0) return 0;
  if (keyA === keyB) return 1;

  // 续集号/部数不一致：不是同一部作品
  if (trailingNumber(keyA) !== trailingNumber(keyB)) return 0;

  const similarity = 1 - editDistance(keyA, keyB) / Math.max(keyA.length, keyB.length);
  const shorter = keyA.length <= keyB.length ? keyA : keyB;
  const longer = keyA.length <= keyB.length ? keyB : keyA;
  const contained = shorter.length >= 2 && longer.includes(shorter) && shorter.length / longer.length >= 0.6;
  return contained ? Math.max(similarity, 0.9) : Math.max(0, similarity);
}

/** 是否同一部作品（评分 >= 阈值） */
export function titleMatches(
  a: string | null | undefined,
  b: string | null | undefined,
  threshold = DEFAULT_TITLE_THRESHOLD,
): boolean {
  return titleMatchScore(a, b) >= threshold;
}

/** 是否「季号明确冲突」（用于把不匹配细分为 season_mismatch） */
export function seasonConflicts(a: string | null | undefined, b: string | null | undefined): boolean {
  const seasonA = parseSeasonNumber(a);
  const seasonB = parseSeasonNumber(b);
  return seasonA !== null && seasonB !== null && seasonA !== seasonB;
}
