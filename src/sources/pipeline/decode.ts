/**
 * 响应体字节 → 文本解码（管道第一环）
 *
 * 为什么不直接 `response.text()`：
 * - Web 端 `response.text()` 按 header charset 解码，缺失时按 UTF-8；
 * - 有些源声明 `text/html` 但正文是 GBK，声明 charset 反而不可信。
 *
 * 策略：`arrayBuffer` 取原始字节，按 BOM → header charset → 探测
 * （**全量** UTF-8 严格解码失败则换 GBK），全部失败时兜底 UTF-8 非严格解码。
 * 任意路径都不抛异常：解码失败必然产出一个可交给规则判定的字符串。
 *
 * CHG-28：探测从「只看前 4KB」改为全量——ASCII 头 + 中文在 4KB 之后的 GBK
 * 页面（列表 JSON 里很常见）会被前缀探测误判为 UTF-8，产出不可逆乱码。
 * TextDecoder 全量校验为原生实现，2MB 级响应体也在毫秒位。
 */
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

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

/** 按 charset 严格解码（fatal）：任一字节非法返回 null（CHG-28：全量校验） */
function tryStrictDecode(bytes: Uint8Array, charset: string): string | null {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return null;
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

  // 探测（CHG-28 全量严格解码）：UTF-8 严格成功就用 UTF-8；
  // 失败（中文 GBK 常见，包括 ASCII 头 + 4KB 后才出现中文的场景）换 GBK 严格，
  // 仍失败兜底 UTF-8 非严格（产生替换字符，交给规则判定）
  const utf8 = tryStrictDecode(bytes, 'utf-8');
  if (utf8 !== null) return { text: utf8, charset: 'utf-8' };
  const gbk = tryStrictDecode(bytes, 'gbk');
  if (gbk !== null) return { text: gbk, charset: 'gbk' };
  return { text: decodeWith(bytes, 'utf-8'), charset: 'utf-8' };
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
