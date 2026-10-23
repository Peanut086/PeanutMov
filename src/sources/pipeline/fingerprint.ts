/**
 * 结构指纹（纯函数，可单测）
 *
 * 从"一次响应"里提取**结构**特征供规则匹配：
 * - 只读前 8KB 正文做匹配与正则（限制回溯成本，订阅上限 2MB）；
 * - 顶层 JSON 键用词法扫描，不 `JSON.parse` 前缀（截断前缀 parse 必抛错）；
 * - 图片判定看文件魔数，不信 Content-Type（伪装成 .json 的 BMP 是真实案例）。
 *
 * 指纹**不含易变内容**（列表条目、时间戳、byteLength），否则同源列表一变缓存全废。
 */
import { djb2 } from '@/shared/id';
import { getHost } from '@/shared/url';
import type { Fingerprint, MagicKind } from './types';

/** 匹配与正则只在正文前 8KB 上跑 */
export const FINGERPRINT_PREFIX_BYTES = 8192;

/** 顶层 JSON 键的廉价词法扫描：`"key":` 形式，键名 ≤32 字符 */
const JSON_KEY_PATTERN = /"([A-Za-z_$][\w$-]{0,31})"\s*:/g;

/** 只扫描前 8KB 里的键，避免在大 JSON 上反复扫描 */
const JSON_KEY_SCAN_LIMIT = 8192;

/** TVBox 形状相关的顶层键 */
const TVBOX_KEYS = ['list', 'class', 'sites', 'sources', 'urls'] as const;

/** 逐行 URL 列表（多仓索引 dc.txt） */
const URL_LINE_PATTERN = /^\s*https?:\/\/\S+\s*$/;

/** 文件魔数表 */
const MAGIC_TABLE: Array<{ kind: Exclude<MagicKind, null>; test: (b: Uint8Array) => boolean }> = [
  { kind: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    kind: 'jpeg',
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: 'gif',
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    kind: 'bmp',
    test: (b) => b[0] === 0x42 && b[1] === 0x4d,
  },
];

/** 判定文件魔数（前 4 字节） */
export function magicOf(bytes: Uint8Array): MagicKind {
  if (bytes.length < 2) return null;
  for (const entry of MAGIC_TABLE) {
    if (entry.test(bytes)) return entry.kind;
  }
  return null;
}

/** 顶层 JSON 键的词法扫描（不 parse，允许截断） */
export function jsonKeysOf(text: string): string[] {
  const head = text.slice(0, JSON_KEY_SCAN_LIMIT);
  const keys = new Set<string>();
  for (const match of head.matchAll(JSON_KEY_PATTERN)) {
    const key = match[1];
    if (key) keys.add(key);
    if (keys.size >= 64) break; // 防御：键数量异常时截断
  }
  return [...keys];
}

/** 首字符非空白归一化 */
function firstNonWhitespace(text: string): string {
  for (const char of text) {
    if (!/\s/.test(char)) return char;
  }
  return '';
}

/** HTML 判定：doctype / html / 常见标签开头 */
function looksLikeHtmlText(firstChar: string, text: string): boolean {
  if (firstChar === '<') {
    if (/^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|meta[\s>]|script[\s>]|div[\s>]|a[\s>])/i.test(text.trimStart())) {
      return true;
    }
  }
  return false;
}

/** XML 判定：`<?xml` 声明或 `<rss>` / `<feed>` 开头 */
function looksLikeXmlText(firstChar: string, text: string): boolean {
  if (firstChar !== '<') return false;
  const trimmed = text.trimStart();
  return /^<\?xml\s/i.test(trimmed) || /^<(rss|feed)[\s>]/i.test(trimmed);
}

/** JSON 词法判定：`{` 或 `[` 开头（真正 parse 由解析器负责） */
function looksLikeJsonText(firstChar: string): boolean {
  return firstChar === '{' || firstChar === '[';
}

/** 逐行 URL 列表：至少一行完整 URL，且没有 JSON 起始符 */
function looksLikeUrlList(firstChar: string, text: string): boolean {
  if (firstChar === '{' || firstChar === '[') return false;
  const lines = text.split(/\r?\n/);
  let hits = 0;
  for (const line of lines) {
    if (URL_LINE_PATTERN.test(line)) {
      hits += 1;
      if (hits >= 1) return true;
    }
  }
  return false;
}

/** 从 Content-Type 提取主类型（去掉参数） */
export function mimeOf(contentType: string | null): string {
  if (typeof contentType !== 'string') return '';
  const semi = contentType.indexOf(';');
  return (semi >= 0 ? contentType.slice(0, semi) : contentType).trim().toLowerCase();
}

/** 解析 Retry-After（秒）→ 毫秒；非法或缺省返回 null */
export function retryAfterMsOf(value: string | null): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

export interface FingerprintInput {
  status: number;
  headers: Headers;
  /** 已解码正文（不限定长度，内部切片） */
  text: string;
  /** 原始字节的魔数（需要字节，无法从文本判定） */
  bytes: Uint8Array;
  /** 请求 URL（用于判断是否跨 host 跳转） */
  url: string;
  /** 最终 URL（fetch 响应 url；同域不可读时等于 url） */
  finalUrl?: string | null;
}

/** 计算结构指纹 */
export function fingerprintOf(input: FingerprintInput): Fingerprint {
  const { status, headers, text, bytes, url } = input;
  const contentType = headers.get('content-type');
  const mime = mimeOf(contentType);

  const prefix = text.slice(0, FINGERPRINT_PREFIX_BYTES);
  const firstChar = firstNonWhitespace(prefix);
  const jsonKeys = jsonKeysOf(prefix);

  const looksLikeJson = looksLikeJsonText(firstChar);
  const looksLikeXml = looksLikeXmlText(firstChar, prefix);
  const looksLikeHtml = looksLikeHtmlText(firstChar, prefix);
  const magic = magicOf(bytes);

  const empty = prefix.trim().length === 0;
  const textUrlList = !empty && !looksLikeJson && looksLikeUrlList(firstChar, prefix);

  const finalUrl = typeof input.finalUrl === 'string' && input.finalUrl.length > 0 ? input.finalUrl : null;
  const finalHost = finalUrl ? safeHost(finalUrl) : null;
  const redirected = finalHost !== null && finalHost !== safeHost(url);

  const cfRay = headers.get('cf-ray');
  const server = headers.get('server');
  const retryAfter = headers.get('retry-after');

  const shape = [
    looksLikeJson ? 'j' : '-',
    looksLikeXml ? 'x' : '-',
    looksLikeHtml ? 'h' : '-',
    magic ? 'i' : '-',
    textUrlList ? 'u' : '-',
    empty ? 'e' : '-',
  ].join('');
  const keys = [...jsonKeys].sort().join(',');
  const hash = djb2(`${status}|${mime}|${firstChar}|${shape}|${keys}`);

  return {
    status,
    contentType,
    mime,
    charset: charsetFromHeader(contentType),
    prefix,
    firstChar,
    looksLikeJson,
    looksLikeXml,
    looksLikeHtml,
    jsonKeys,
    magic,
    looksLikeImage: magic !== null,
    empty,
    headerHints: {
      cfRay: typeof cfRay === 'string' && cfRay.length > 0,
      server,
      retryAfterSec: retryAfterMsOf(retryAfter) === null ? null : Math.ceil((retryAfterMsOf(retryAfter) as number) / 1000),
    },
    redirected,
    finalHost,
    hash,
  };
}

/** 取 header 里的 charset（decode 用同一套规则，避免两处实现漂移） */
function charsetFromHeader(contentType: string | null): string | null {
  if (typeof contentType !== 'string' || contentType.length === 0) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function safeHost(value: string): string | null {
  try {
    return getHost(value);
  } catch {
    return null;
  }
}

/** 指纹是否包含某个顶层键 */
export function hasJsonKey(fingerprint: Fingerprint, key: string): boolean {
  return fingerprint.jsonKeys.includes(key);
}

/** TVBox 形状相关的顶层键是否命中 */
export function tvboxKeyHits(fingerprint: Fingerprint): string[] {
  return TVBOX_KEYS.filter((key) => fingerprint.jsonKeys.includes(key));
}
