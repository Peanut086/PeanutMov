/**
 * 观影口令（SHARE-CODE）
 *
 * 把「在看的片 + 集号 + 时间点」编码成一段可粘贴传播的纯元数据文本，朋友在自己的
 * PeanutMov 里粘进搜索框即可直达同一位置起播。
 *
 * 隐私与合规边界（刻意的设计，不是遗漏）：
 * - 口令**不含任何播放地址、源 id、订阅地址**——对方能否看到取决于其自有订阅，
 *   我们分享的是"坐标"，不是"资源"；
 * - 不含设备标识与账号信息；标题来自媒体库元数据，无用户输入内容。
 *
 * 格式：`#PeanutMov<版本>.<base64url(JSON)>#`，解码对未知字段宽容、对越界值收紧，
 * 永远不因脏数据抛错（口令文本来自外部剪贴板，属于不可信输入）。
 */

export interface ShareCodePayload {
  /** 片名（口令的检索主键） */
  title: string;
  year: number | null;
  /** 集号（电影为 null） */
  episodeNumber: number | null;
  /** 时间点（秒），0~86400 之外视为无效 */
  positionSec: number | null;
}

const CODE_VERSION = 1;
const CODE_PATTERN = /PeanutMov(\d+)\.([A-Za-z0-9_-]{4,800})/;
const TITLE_MAX_LENGTH = 120;
const EPISODE_MAX = 5000;
const POSITION_MAX_SEC = 24 * 60 * 60;

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(encoded: string): string | null {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function clampInt(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const value = Math.round(raw);
  if (value < min || value > max) return null;
  return value;
}

/** 编码为口令正文（不含说明文案） */
export function encodeShareCode(payload: ShareCodePayload): string {
  const compact: Record<string, number | string> = { t: payload.title.slice(0, TITLE_MAX_LENGTH) };
  if (payload.year !== null) compact.y = payload.year;
  if (payload.episodeNumber !== null) compact.e = payload.episodeNumber;
  if (payload.positionSec !== null && payload.positionSec > 0) compact.s = Math.round(payload.positionSec);
  return `#PeanutMov${CODE_VERSION}.${b64urlEncode(JSON.stringify(compact))}#`;
}

/** 组装分享文案：人话一行 + 口令一行，粘进搜索框整段可用 */
export function buildShareText(payload: ShareCodePayload): string {
  const parts = [`《${payload.title}》`];
  if (payload.episodeNumber !== null) parts.push(`第${payload.episodeNumber}集`);
  if (payload.positionSec !== null && payload.positionSec > 0) parts.push(formatClock(payload.positionSec));
  return [
    `我在 PeanutMov 看${parts.join(' ')}，把下面的口令粘到对方的 PeanutMov 搜索框里就能直接续上：`,
    encodeShareCode(payload),
  ].join('\n');
}

/** 从任意文本（整段分享文案/脏输入）提取口令；解析失败返回 null，不抛错 */
export function decodeShareCode(text: string): (ShareCodePayload & { version: number }) | null {
  const match = CODE_PATTERN.exec(text ?? '');
  if (!match) return null;
  const version = Number.parseInt(match[1] ?? '0', 10);
  if (!Number.isFinite(version) || version > CODE_VERSION || version < 1) return null;
  const json = b64urlDecode(match[2] ?? '');
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const title = typeof candidate.t === 'string' ? candidate.t.trim().slice(0, TITLE_MAX_LENGTH) : '';
  if (title.length === 0) return null;
  return {
    version,
    title,
    year: clampInt(candidate.y, 1900, 2100),
    episodeNumber: clampInt(candidate.e, 1, EPISODE_MAX),
    positionSec: clampInt(candidate.s, 0, POSITION_MAX_SEC),
  };
}

/** 文本里是否带口令（搜索框提交前的快速判定，避免每次输入都走完整解码） */
export function looksLikeShareCode(text: string): boolean {
  return CODE_PATTERN.test(text ?? '');
}

/** 秒 → `m:ss`（超过一小时补时位），口令文案与跳转 toast 共用 */
export function formatClock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
