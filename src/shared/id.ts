/**
 * ID 生成（SCF 冻结，PKG-B 只读）
 *
 * - `newId()`：uuid v4，优先 `crypto.randomUUID()`，非安全上下文降级为 getRandomValues/ Math.random
 * - `stableId(...parts)`：确定性 ID，用 `:` 连接 + djb2 哈希，保证长度可控（技术方案 4 章空值规则）
 */
import type { MediaFormat } from '@/types';

const HEX: string[] = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** uuid v4（小写、带连字符） */
export function newId(): string {
  const cryptoObj = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant
  const hex = Array.from(b, (n) => HEX[n] ?? '00').join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** djb2 哈希（32 位无符号，base36 输出，长度 ≤ 7） */
export function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 稳定 ID：`stableId('demo', 'movie-1')` → `demo:movie-1~1a2b3c`
 * - 原始片段做最小清洗（去首尾空白、把 `:` 与 `~` 替换为 `-`），保持可读
 * - 末尾附加整串哈希，避免不同片段组合产生碰撞
 * - 结果小写、无空格；空片段被忽略
 */
export function stableId(...parts: Array<string | number | null | undefined>): string {
  const raw = parts
    .filter((p): p is string | number => p !== null && p !== undefined && String(p).length > 0)
    .map((p) => String(p));
  const joined = raw.join(':');
  const readable = raw.map((p) => p.trim().replace(/[:~]/g, '-')).join(':').toLowerCase();
  return `${readable}~${djb2(joined)}`;
}

/** 媒体条目 ID 规范：`stableId(sourceId, sourceItemId)` */
export function mediaIdOf(sourceId: string, sourceItemId: string): string {
  return stableId(sourceId, sourceItemId);
}

/** 历史/收藏 ID 规范：`${sourceId}:${mediaId}` 的可控版本 */
export function historyIdOf(sourceId: string, mediaId: string): string {
  return stableId(sourceId, mediaId);
}

/** 分类 ID 规范：`sourceId:value` */
export function categoryIdOf(sourceId: string, value: string): string {
  return stableId(sourceId, value);
}

/** 线路 ID 规范：`mediaId:index` */
export function lineIdOf(mediaId: string, index: number): string {
  return stableId(mediaId, index);
}

/** 剧集 ID 规范：`mediaId:lineId:number` */
export function episodeIdOf(mediaId: string, lineId: string, number: number): string {
  return stableId(mediaId, lineId, number);
}

/** 生成 `key-N` 形式的去重 key（导入 keep-both 场景） */
export function nextKey(baseKey: string, existing: ReadonlySet<string>): string {
  let n = 2;
  let candidate = `${baseKey}-${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${baseKey}-${n}`;
  }
  return candidate;
}

/** 从 URL 扩展名到下载文件扩展名（无扩展名时按格式兜底） */
export function extensionOf(url: string, format: MediaFormat): string {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  if (match?.[1]) return match[1].toLowerCase();
  switch (format) {
    case 'hls':
      return 'm3u8';
    case 'webm':
      return 'webm';
    case 'ts':
      return 'ts';
    case 'mp4':
    default:
      return 'mp4';
  }
}
