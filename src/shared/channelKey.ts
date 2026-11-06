/**
 * 频道身份与 EPG 匹配（EXT-06 / FR-67，Q-16 默认 A）
 *
 * 身份键口径（全项目统一，分组/排序/提醒共用）：
 * `channelKey = tvgId ? 'id:' + 归一化(tvgId) : 'nm:' + 归一化(name)`
 *
 * 匹配为**四级确定性**匹配，不做模糊/相似度算法（AC-157/158 可写成纯函数断言）：
 * L1 `tvg-id` 相等 → L2 `tvg-name` 相等 → L3 归一化名称相等 → 未命中。
 */

export interface ChannelIdentityInput {
  name: string;
  tvgId?: string | null;
  tvgName?: string | null;
}

/** 归一化中要去掉的连接符/空白（含全角空格与常见中英文标点） */
const SEPARATORS = /[\s\u3000\-_·.,:;!?/\\|"'`()[\]{}<>~@#$%^&*+=]+/g;

/** 画质/编码后缀（比较前统一剥离，避免" CCTV1 高清"与"CCTV1"不相等） */
const QUALITY_SUFFIXES = [
  '高清',
  '超清',
  '标清',
  '蓝光',
  '原画',
  'fhd',
  'uhd',
  'hd',
  'sd',
  '4k',
  '8k',
  '1080p',
  '720p',
  '576p',
  'h265',
  'hevc',
  'h264',
];

/** 频道名词尾（仅在剩余长度 > 2 时剥离，避免把"频道"本身剥空） */
const NAME_SUFFIXES = ['综合', '频道'];

/**
 * 频道名归一化：
 * NFKC（全角转半角）→ 小写 → 去空白与分隔符 → 反复剥画质后缀 → 剥"综合/频道"。
 * 例：`CCTV-1 综合`、`CCTV1`、`cctv 1 高清` 均归一化为 `cctv1`。
 */
export function normalizeChannelName(name: string): string {
  let value = (name ?? '').normalize('NFKC').toLowerCase().replace(SEPARATORS, '');
  let changed = true;
  while (changed && value.length > 1) {
    changed = false;
    for (const suffix of QUALITY_SUFFIXES) {
      if (value.length > suffix.length && value.endsWith(suffix)) {
        value = value.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  for (const suffix of NAME_SUFFIXES) {
    if (value.length > suffix.length + 1 && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
    }
  }
  return value;
}

/** tvg-id 归一化（只去空白并小写，保留 `-`/`.` 等业务语义） */
export function normalizeTvgId(tvgId: string | null | undefined): string {
  return (tvgId ?? '').trim().toLowerCase();
}

/** 频道身份键：有 tvg-id 用 `id:` 前缀，否则用归一化名 `nm:` */
export function channelKeyOf(input: ChannelIdentityInput): string {
  const id = normalizeTvgId(input.tvgId);
  if (id) return `id:${id}`;
  return `nm:${normalizeChannelName(input.name)}`;
}

/** 拆解 channelKey（用于 UI 展示与调试） */
export function splitChannelKey(key: string): { kind: 'id' | 'nm'; value: string } {
  if (key.startsWith('id:')) return { kind: 'id', value: key.slice(3) };
  if (key.startsWith('nm:')) return { kind: 'nm', value: key.slice(3) };
  return { kind: 'nm', value: key };
}

/**
 * L3 匹配候选（去重、去空）：频道名归一化 + tvg-name 归一化。
 * EPG 侧对 `display-name` 与 `channel id` 做同样归一化后与本结果求交。
 */
export function epgNameCandidates(input: ChannelIdentityInput): string[] {
  const candidates = [normalizeChannelName(input.name), normalizeChannelName(input.tvgName ?? '')];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

/** 节目唯一键：`${startAt}:${title}`（提醒去重、缓存去重共用） */
export function programmeKeyOf(startAt: number, title: string): string {
  return `${startAt}:${title}`;
}
