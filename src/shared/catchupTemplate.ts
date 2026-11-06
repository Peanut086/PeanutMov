/**
 * 回看地址模板（EXT-06 / FR-68，API-23 §3.4.1，D-09）
 *
 * 声明式模板 + 12 个白名单占位符（9 组语义），不做表达式求值：
 *   {base} {channel} {tvgId} {channelId} {date} {dateDash} {start} {end} {utc} {utcend}
 *   {startSec} {durationSec}
 *
 * 编码规则（§3.4.1 + AC-163 四类样本）：
 * - `{channel}` / `{channelId}` 走 `encodeURIComponent`（中文频道名与空格）；
 * - `{base}` / `{tvgId}` 是地址/标识类 token，只允许 URL 安全字符 `[A-Za-z0-9-._~:/@]`
 *   （AC-163 的 4 类样本全部以 `{base}` 开头，不可能用纯数字字符集）；
 * - 其余时间/数值 token 只允许数字与 `-` `.` `/` `:`。
 * 渲染结果必须能被 `new URL()` 解析且协议为 http(s)，否则 `E_INVALID_INPUT`（防注入/防拼错）。
 */
import { AppError } from '@/shared/errors';
import { normalizeChannelName } from '@/shared/channelKey';
import {
  localYmd,
  localYmdHms,
  localDateKey,
  secOfLocalDay,
  utcYmdHms,
} from '@/shared/epgTime';
import { CATCHUP_MAX_DAYS } from '@/shared/constants';

export const CATCHUP_TOKENS = [
  'base',
  'channel',
  'tvgId',
  'channelId',
  'date',
  'dateDash',
  'start',
  'end',
  'utc',
  'utcend',
  'startSec',
  'durationSec',
] as const;

export type CatchupToken = (typeof CATCHUP_TOKENS)[number];

const TOKEN_SET = new Set<string>(CATCHUP_TOKENS);
const PLACEHOLDER = /\{([^{}]*)\}/g;
const SAFE_VALUE = /^[0-9\-.:/]*$/;
/** 地址/标识类 token 的安全字符集（禁止空白、引号、尖括号、花括号等会破坏 URL 的字符） */
const SAFE_URL_VALUE = /^[A-Za-z0-9\-._~:/@]*$/;
const ENCODE_TOKENS = new Set<string>(['channel', 'channelId']);
const URL_TOKENS = new Set<string>(['base', 'tvgId']);

export interface CatchupRenderContext {
  channel: { name: string; tvgId: string | null; url: string };
  programme: { startAt: number; endAt: number };
}

export interface CatchupRenderResult {
  url: string;
  /** 实际替换值（UI「高级信息」与单测断言用） */
  tokens: Record<string, string>;
}

/** `{base}`：由频道 URL 的目录部分推导（`https://cdn.example.com/live/a.m3u8` → `https://cdn.example.com/live`） */
export function baseOfChannelUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const dir = parsed.pathname.replace(/[^/]*$/, '').replace(/\/+$/, '');
    return `${parsed.origin}${dir}`;
  } catch {
    return '';
  }
}

/** 模板中出现的不在白名单内的占位符（去重、按出现顺序） */
export function unknownTokensOf(template: string): string[] {
  const unknown: string[] = [];
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(template ?? ''))) {
    const name = match[1];
    if (!TOKEN_SET.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/** 模板校验：返回错误文案（可直接 Toast），合法返回 null */
export function validateCatchupTemplate(template: string): string | null {
  const text = (template ?? '').trim();
  if (!text) return '回看模板不能为空';
  if (!/^https?:\/\//i.test(text)) return '回看模板必须以 http(s):// 开头';
  const unknown = unknownTokensOf(text);
  if (unknown.length > 0) {
    return `模板含未知占位符 ${unknown.map((t) => `{${t}}`).join(' ')}；合法占位符：${CATCHUP_TOKENS.map((t) => `{${t}}`).join(' ')}`;
  }
  // 只用占位符替换成安全样例后校验结构，避免"少斜杠/拼错协议"拖到播放时才报错
  const sample: Record<string, string> = {};
  for (const token of CATCHUP_TOKENS) sample[token] = '0';
  sample.base = 'https://example.com';
  sample.tvgId = 'tv1';
  const rendered = text.replace(PLACEHOLDER, (whole, name: string) => sample[name] ?? whole);
  try {
    const parsed = new URL(rendered);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '回看模板协议必须是 http(s)';
  } catch {
    return '回看模板无法解析为有效地址（请检查 {base} 与路径拼接）';
  }
  return null;
}

function buildTokens(ctx: CatchupRenderContext): Record<string, string> {
  const { channel, programme } = ctx;
  const durationSec = Math.max(0, Math.round((programme.endAt - programme.startAt) / 1000));
  return {
    base: baseOfChannelUrl(channel.url),
    channel: channel.name,
    tvgId: (channel.tvgId ?? '').trim(),
    channelId: (channel.tvgId ?? '').trim() || normalizeChannelName(channel.name),
    date: localYmd(programme.startAt),
    dateDash: localDateKey(programme.startAt),
    start: localYmdHms(programme.startAt),
    end: localYmdHms(programme.endAt),
    utc: utcYmdHms(programme.startAt),
    utcend: utcYmdHms(programme.endAt),
    startSec: String(secOfLocalDay(programme.startAt)),
    durationSec: String(durationSec),
  };
}

/**
 * 渲染回看地址。未知占位符 / 非法 URL → `E_INVALID_INPUT`。
 * 中文频道名与空格走 `encodeURIComponent`，其余占位符只允许安全字符。
 */
export function renderCatchupUrl(template: string, ctx: CatchupRenderContext): CatchupRenderResult {
  const text = (template ?? '').trim();
  if (!text) throw new AppError('E_INVALID_INPUT', '回看模板为空');

  const unknown = unknownTokensOf(text);
  if (unknown.length > 0) {
    throw new AppError(
      'E_INVALID_INPUT',
      `模板含未知占位符 ${unknown.map((t) => `{${t}}`).join(' ')}`,
      { detail: unknown.join(',') },
    );
  }

  const raw = buildTokens(ctx);
  const tokens: Record<string, string> = {};
  const url = text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = raw[name] ?? '';
    if (ENCODE_TOKENS.has(name)) {
      const encoded = encodeURIComponent(value);
      tokens[name] = value;
      return encoded;
    }
    const pattern = URL_TOKENS.has(name) ? SAFE_URL_VALUE : SAFE_VALUE;
    if (!pattern.test(value)) {
      throw new AppError('E_INVALID_INPUT', `占位符 {${name}} 的取值含非法字符`, { detail: name });
    }
    tokens[name] = value;
    return value;
  });

  if (url.includes('{') || url.includes('}')) {
    throw new AppError('E_INVALID_INPUT', '回看地址仍有未替换的占位符');
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError('E_INVALID_INPUT', '回看地址协议必须是 http(s)');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('E_INVALID_INPUT', '回看地址无法解析');
  }

  return { url, tokens };
}

/**
 * 回看天数：取频道级 `catchup-days` / 源级设置，缺省 1 天，上限 `CATCHUP_MAX_DAYS`。
 * 非法值（NaN/<=0）回落到 1 天。
 */
export function clampCatchupDays(raw: number | null | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), CATCHUP_MAX_DAYS);
}

/** 从 m3u 属性值解析回看天数（`catchup-days="7"`） */
export function catchupDaysOf(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 1) return null;
  return clampCatchupDays(value);
}
