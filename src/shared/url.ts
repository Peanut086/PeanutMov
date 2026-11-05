/**
 * URL 工具（SCF 冻结，PKG-B 只读）
 *
 * 纯函数，不发起请求。所有"源地址"入库前都应经过 `normalizeBaseUrl`，
 * 保证"带 / 与不带 / 归一化为同一形式"（AC-05）。
 */
import type { MediaFormat } from '@/types';

/** 判断是否为 http/https 绝对地址（拒绝 `ftp:`、`javascript:`、相对路径） */
export function isValidHttpUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // 快速排除：协议必须显式以 http(s):// 开头，避免 `new URL` 接受 "example.com"
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * 归一化根地址：
 * - 去首尾空白
 * - 协议与小写域名（保留 path 大小写与大小写敏感的 query）
 * - 去掉末尾所有 `/`
 * - 去掉默认端口（`:80` / `:443`）
 * - 无路径时保留 origin（`https://a.com`）
 * 非法地址原样去空白返回（调用方先用 `isValidHttpUrl` 校验）。
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return '';
  if (!isValidHttpUrl(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    const protocol = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    const port = u.port === '' ? '' : `:${u.port}`;
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '/') path = '';
    const search = u.search;
    return `${protocol}//${host}${port}${path}${search}`;
  } catch {
    return trimmed;
  }
}

/**
 * 安全拼接（避免 `//` 与丢失分隔）：
 * `joinUrl('https://a.com/', '/api/x')` → `https://a.com/api/x`
 * 第二段为绝对 URL 时直接返回第二段。
 */
export function joinUrl(base: string, ...segments: Array<string | null | undefined>): string {
  const parts = segments.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  if (parts.length > 0 && isValidHttpUrl(parts[0])) return parts[0].trim();
  let result = (base ?? '').trim();
  for (const raw of parts) {
    const seg = raw.trim();
    if (seg.length === 0) continue;
    if (/^https?:\/\//i.test(seg)) return seg;
    if (result.length === 0) {
      result = seg;
      continue;
    }
    result = `${result.replace(/\/+$/, '')}/${seg.replace(/^\/+/, '')}`;
  }
  return result;
}

/** 相对地址转绝对：`toAbsoluteUrl('https://a.com/x', '../y.mp4')` → `https://a.com/y.mp4` */
export function toAbsoluteUrl(base: string, value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (isValidHttpUrl(trimmed)) return trimmed;
  // 协议相对地址
  if (trimmed.startsWith('//')) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(base ?? '')?.[1] ?? 'https';
    return `${scheme.toLowerCase()}:${trimmed}`;
  }
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;
  if (!isValidHttpUrl(base)) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/**
 * 从 URL 后缀推断媒体格式（FR-17 / 9.1）。
 * 查询串与 hash 会被剥离；无法判断返回 `null`（调用方按 MP4 先试）。
 *
 * 增强：部分 CDN 的 HLS 地址不以 `.m3u8` 结尾，而是将 `m3u8` 作为路径段
 * （如 `/nby/m3u8/play/ts/02b18e79...?token=...`），需额外识别。
 */
export function guessFormatFromUrl(url: string | null | undefined): MediaFormat | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null;

  // P0-7: 整串 URL 正则（含 query 参数），识别 ?url=xxx.m3u8 这类
  if (/\?[^#]*m3u8/i.test(url)) return 'hls';
  if (/[?&]format=hls/i.test(url)) return 'hls';

  let pathname = url.trim();
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // 相对地址：手动剥离 query/hash
    pathname = pathname.split('#')[0]!.split('?')[0]!;
  }
  const lowerPath = pathname.toLowerCase();
  if (lowerPath.endsWith('.m3u8')) return 'hls';
  // CDN 路径段包含 /m3u8/ 也视为 HLS（如 /nby/m3u8/play/ts/...）
  if (lowerPath.includes('/m3u8/')) return 'hls';
  if (lowerPath.endsWith('.mp4') || lowerPath.endsWith('.m4v') || lowerPath.endsWith('.mov')) return 'mp4';
  if (lowerPath.endsWith('.webm')) return 'webm';
  if (lowerPath.endsWith('.ts')) return 'ts';
  return null;
}

/** 是否为 HLS 地址（含查询串的 m3u8 也能识别） */
export function isHlsUrl(url: string | null | undefined): boolean {
  return guessFormatFromUrl(url) === 'hls';
}

/** 提取域名（用于错误文案"来自 xxx"），失败返回空串 */
export function getHost(value: string | null | undefined): string {
  if (!isValidHttpUrl(value)) return '';
  try {
    return new URL(value as string).hostname;
  } catch {
    return '';
  }
}

/** 拼接查询参数（跳过 null/undefined/空串） */
export function withQuery(
  url: string,
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  ) as Array<[string, string | number | boolean]>;
  if (entries.length === 0) return url;
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const [head, hash = ''] = url.split('#');
  const sep = head!.includes('?') ? '&' : '?';
  return `${head}${sep}${query}${hash ? `#${hash}` : ''}`;
}

/** 去除 URL 中的敏感查询参数（日志用，技术方案 13 章） */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  return url.replace(/([?&](?:token|api_key|apikey|password|pwd|pw|auth|sign|key)=)[^&#]*/gi, '$1***');
}
