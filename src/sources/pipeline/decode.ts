/**
 * 响应体字节 → 文本解码（管道第一环）
 *
 * 为什么不直接 `response.text()`：
 * - Web 端 `response.text()` 按 header charset 解码，缺失时按 UTF-8；
 * - CapacitorHttp 原生补丁把 body 读成**字符串**再塞回 `new Response(data)`，
 *   Android 侧已按 GBK 解过一遍，再 UTF-8 解码会得到乱码；
 * - 有些源声明 `text/html` 但正文是 GBK，声明 charset 反而不可信。
 *
 * 策略：`arrayBuffer` 取原始字节，按 BOM → header charset → 探测试
 * （UTF-8 严格解码失败则换 GBK），只在该次序全部失败时兜底 UTF-8 非严格解码。
 * 任意路径都不抛异常：解码失败必然产出一个可交给规则判定的字符串。
 */
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

/** 探测阶段只读这么多字节：GBK/UTF-8 判定 4KB 足够，避免整读大文件 */
const SNIFF_BYTES = 4096;
export interface DecodeOptions {
  /** 响应头 Content-Type（可能为 null） */
  contentType: string | null;
  /** 响应体字节 */
  bytes: Uint8Array;
  url?: string;
}

/** 从 Content-Type 里取 charset；`text/html`（无 charset）返回 null */
export function charsetFromContentType(contentType: string | null): string | null {
  if (typeof contentType !== 'string' || contentType.length === 0) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  if (!match?.[1]) return null;
  return match[1].toLowerCase();
}

/** 是否带 UTF-8 BOM */
function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** 是否带 UTF-16LE BOM */
function hasUtf16LeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
}

/** 是否带 UTF-16BE BOM */
function hasUtf16BeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
}

/** 前若干字节能否按 UTF-8 严格解码（不产生替换字符） */
function isValidUtf8Prefix(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  try {
    // 只解码到最后一个完整字符边界：末字节可能是被截断的多字节序列
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(bytes.subarray(0, Math.min(SNIFF_BYTES, bytes.length)), { stream: false });
    return true;
  } catch {
    return false;
  }
}

/** 归一化 charset 名：GB2312/GBK/GB18030 一族都按 gbk 解 */
function normalizeCharset(charset: string | null): string | null {
  if (!charset) return null;
  const lower = charset.trim().toLowerCase();
  if (lower === 'utf8' || lower === 'utf-8') return 'utf-8';
  if (lower === 'gb2312' || lower === 'gbk' || lower === 'gb18030' || lower === 'x-gbk') return 'gbk';
  if (lower === 'big5') return 'big5';
  if (lower === 'utf-16' || lower === 'utf-16le') return 'utf-16le';
  if (lower === 'utf-16be') return 'utf-16be';
  if (lower === 'iso-8859-1' || lower === 'latin1' || lower === 'us-ascii' || lower === 'ascii') {
    return 'iso-8859-1';
  }
  return lower;
}

/** 用指定 charset 解码（不支持的 charset 抛异常，由调用方兜底） */
function decodeWith(bytes: Uint8Array, charset: string): string {
  return new TextDecoder(charset).decode(bytes);
}

/**
 * 按 BOM → header charset → 探测 的顺序解码响应体。
 *
 * 注意 BOM 优先于 header：`text/html` 常缺 charset，但带 BOM 的 UTF-8 文件很常见；
 * 反过来若 header 明确给了 GBK 而字节是 UTF-8，以 header 为准（站点自己最清楚）。
 */
export function decodeBody(options: DecodeOptions): { text: string; charset: string } {
  const { bytes, contentType } = options;
  const declared = normalizeCharset(charsetFromContentType(contentType));

  if (hasUtf8Bom(bytes)) return { text: decodeWith(bytes.subarray(3), 'utf-8'), charset: 'utf-8' };
  if (hasUtf16LeBom(bytes)) return { text: decodeWith(bytes.subarray(2), 'utf-16le'), charset: 'utf-16le' };
  if (hasUtf16BeBom(bytes)) return { text: decodeWith(bytes.subarray(2), 'utf-16be'), charset: 'utf-16be' };

  if (declared) {
    try {
      return { text: decodeWith(bytes, declared), charset: declared };
    } catch {
      // 声明的 charset 运行时不支持（如某些少见编码名）：落到探测
    }
  }

  // 探测：UTF-8 严格解码成功就用 UTF-8；失败（中文 GBK 常见）换 GBK
  if (isValidUtf8Prefix(bytes)) return { text: decodeWith(bytes, 'utf-8'), charset: 'utf-8' };
  try {
    return { text: decodeWith(bytes, 'gbk'), charset: 'gbk' };
  } catch {
    // 极端情况：GBK 也不支持，兜底 UTF-8 非严格（产生替换字符，交给规则判定）
    return { text: decodeWith(bytes, 'utf-8'), charset: 'utf-8' };
  }
}

/** 把 fetch 响应读成字节（统一整读，不在 Web/原生间维护两套流式路径） */
export async function readResponseBytes(response: Response): Promise<Uint8Array> {
  try {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (e) {
    throw new AppError('E_PARSE', undefined, { detail: `读取响应体失败：${errorMessage(e)}`, cause: e });
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 便捷入口：fetch 响应 → 解码文本（含日志） */
export async function decodeResponse(response: Response, url?: string): Promise<{ text: string; charset: string }> {
  const contentType = response.headers.get('content-type');
  const bytes = await readResponseBytes(response);
  const decoded = decodeBody({ bytes, contentType, url });
  if (decoded.charset !== 'utf-8' && url) {
    logger.debug('响应体按非 UTF-8 字符集解码', { url, charset: decoded.charset, contentType });
  }
  return decoded;
}
