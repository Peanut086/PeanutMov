/**
 * 上游提示的来源登记与展示脱敏（P1-2）
 *
 * 需求口径：一条提示（弹窗 / Toast / 页面弹框）要能回答「它是从哪儿冒出来的」，
 * 且界面**只显示脱敏文字**。此前两条都不成立：
 * - `SpiderAdapter` 把爬虫 `playerContent` 的 `msg` 原样塞进 `AppError.message`，
 *   UI 直接显示——上游那句「本接口免费使用…」「加载go服务…」于是原封不动顶到用户面前，
 *   而 `code`（业务码）字段声明了却从没被读过；
 * - 日志里没有任何一行能说明提示是业务响应、爬虫 msg、系统 Toast、WebView 页面还是视频画面，
 *   下一轮复现时还是只能靠猜。
 *
 * 本模块只负责**来源与脱敏**这两件事；分档（鉴权 / 额度 / 限流 / 无地址）仍然走
 * `sourceFailure.classifySourceFailure` 这一套唯一口径，这里不建第二套分类。
 *
 * 能力边界（不假装覆盖）：
 * - `webview_page`：只有 App 自己创建的离屏嗅探 WebView 能挂 `WebChromeClient` 记录并拦下
 *   页面 `alert()`；主 Capacitor WebView 的页面弹窗由 Capacitor 全局托管，换掉它会波及
 *   App 自身的 `alert/confirm`，故不在本轮覆盖；
 * - `video_frame`（画面里烧录的字幕/提示）没有任何可编程入口，只能人工判定，
 *   这里保留档位是为了让人工结论也有统一写法可记。
 */
import { logger } from '@/shared/logger';
import { djb2 } from '@/shared/id';
import { redactUrl } from '@/shared/url';
import {
  classifySourceFailure,
  guidanceOf,
  type SourceFailureKind,
} from '@/shared/sourceFailure';
import type { AppErrorShape, ErrorCode } from '@/types';

/** 提示来源（与需求五项一一对应） */
export type NoticeOrigin =
  /** 爬虫接口返回体里的 msg（playerContent / detailContent） */
  | 'spider_msg'
  /** 业务响应：解析接口 / 网盘开放平台返回的 code + msg */
  | 'business_response'
  /** 系统 Toast：App 展示层自己弹的那一条 */
  | 'system_toast'
  /** WebView 页面里弹出来的提示（页面 JS alert / confirm） */
  | 'webview_page'
  /** 视频画面里烧录的提示（只能人工判定） */
  | 'video_frame';

export const NOTICE_ORIGIN_LABELS: Record<NoticeOrigin, string> = {
  spider_msg: '爬虫 msg',
  business_response: '业务响应',
  system_toast: '系统 Toast',
  webview_page: 'WebView 页面',
  video_frame: '视频画面',
};

/** 一次提示登记的上下文：能拿到几项就记几项，缺项记 null（不猜） */
export interface NoticeContext {
  origin: NoticeOrigin;
  /** 发起这次上游调用的动作，如 `resolvePlay` / `parse` / `sniff` */
  operation?: string;
  sourceId?: string;
  httpStatus?: number | null;
  /** 业务码：爬虫/解析接口响应里的 `code`（此前从未被读取） */
  businessCode?: string | number | null;
  /** 命中限流时上游给的等待秒数 */
  retryAfterSec?: number | null;
  /** 上游原文所在错误码，登记后进分类 */
  errorCode?: ErrorCode;
}

export interface RecordedNotice {
  requestId: string;
  noticeOrigin: NoticeOrigin;
  /** 分档结果（唯一口径来自 classifySourceFailure） */
  kind: SourceFailureKind;
  /** 可直接展示的脱敏文字 */
  text: string;
  /** 入日志的脱敏原文（截断） */
  detail: string;
  httpStatus: number | null;
  businessCode: string | number | null;
  retryAfterSec: number | null;
}

/**
 * 一次登记的关联号：短、可 grep、不含用户数据。
 *
 * 形如 `n-1k2x9ab-7f3d`：时间戳 base36 + 原文与来源的 djb2 尾缀，
 * 同一轮解析里多次登记的 requestId 共享前缀，肉眼能串起来。
 */
let noticeSeq = 0;
export function newNoticeRequestId(seed?: string): string {
  noticeSeq = (noticeSeq + 1) % 1_296;
  const head = Date.now().toString(36);
  const tail = djb2(`${seed ?? ''}|${noticeSeq}`);
  return `n-${head}-${tail}`;
}

/**
 * 凭据形态脱敏：只打值、留键名。
 *
 * 上游 msg 常把带签名的直链或整串 cookie 拼进提示里；`redactUrl` 只管 URL 查询串，
 * 管不了 `Cookie: __pus=…`、`token=…` 这种头部写法，所以这里补齐值区。
 * 键名保留是因为「上游带过哪些会话键」本身就是排障线索；值不足 6 位不打码，
 * 免得把 `t=1` 这类短参数打成一片星号。
 *
 * 规则口径刻意与原生 `LogRedactor` 一致（cookie 值区逐对打码、属性名保留、`,` 是响应头
 * map 的分隔符而非 cookie 的分隔符）——界面与日志两处必须给出同一句话，否则用户拿界面上
 * 那行字去日志里 grep 会 grep 到两个版本。**cookie 必须先于具名键处理**：否则
 * `Cookie: __pus=x; __puus=y` 会被通用键值规则当成一个值整段吞掉，后半串反而漏码。
 */

/** 带方案名的键：值区第一个词可能是 `Bearer`/`Basic`，真令牌在它后面 */
const AUTH_KEY = /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)(bearer|basic)?(\s*)["']?[^\s"',;&}\\]+/gi;

/** 没带键名、方案名与长令牌同时出现（curl 回显、原始请求行） */
const BARE_SCHEME_TOKEN = /\b(bearer|basic)\s+[A-Za-z0-9._+/=\-]{8,}/gi;

/** 其余具名凭据与身份键（`cookie` 不在内，由值区规则逐对处理） */
const CREDENTIAL_KEY = new RegExp(
  '\\b(auth|token|access_token|refresh_token|id_token|open_token|opentoken|ptoken|jwt'
    + '|api_?key|apikey|app_?key|secret|secret_key|app_?secret|client_secret|sign|msign|qsign|signature|tmp_key|temp_key'
    + '|pwd|password|passwd|session|sessionid|session_id|jsessionid|phpsessid|wssecret|wssession'
    + '|device_id|android_id|oaid|imei|idfa|uid|user_id|userid|unionid|open_id|openid|nickname|nick_name'
    + '|mobile|phone|share_id|shareid|surl|fid)\\b(\\s*[:=]\\s*)["\']?([^"\';&,\\s}\\]]{6,})',
  'gi',
);

/** cookie 属性名：值留着才能判断域与有效期，不算凭据 */
const COOKIE_ATTRS = new Set([
  'path', 'domain', 'expires', 'max-age', 'httponly', 'secure', 'samesite',
  'version', 'comment', 'partitioned',
]);

/** cookie 头定位：`Cookie:` / `Set-Cookie=` / `"cookie":"` 之后的值区起点 */
const COOKIE_HEAD = /\b(?:set-)?cookie["']?\s*[:=]\s*["']?/i;

/** 值区里的一个 `名=值` */
const COOKIE_PAIR = /([A-Za-z0-9_.\-]{1,64})=([^;,)}\]'"\\]*)/g;

/** 到下一个分隔符为止（不含）；`,` 之后就是响应头的下一项 */
function segmentEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (',;}])\'"\\'.includes(text[i]) || text[i] === '\n' || text[i] === '\r') return i;
  }
  return text.length;
}

/** 这一段还像 cookie 吗（`名=值` 或纯属性名） */
function isCookieSegment(raw: string): boolean {
  const seg = raw.trim();
  if (seg.length === 0) return false;
  const eq = seg.indexOf('=');
  if (eq < 0) return COOKIE_ATTRS.has(seg.toLowerCase());
  return /^[A-Za-z0-9_.\-]{1,64}$/.test(seg.slice(0, eq));
}

/** cookie 值区右边界：`;` 之后仍是 cookie 段就继续，遇 `,` 引号 括号 换行即止 */
function cookieRunEnd(text: string, from: number): number {
  let pos = from;
  for (;;) {
    const stop = segmentEnd(text, pos);
    if (!isCookieSegment(text.slice(pos, stop))) return pos;
    if (stop >= text.length || text[stop] !== ';') return stop;
    let next = stop + 1;
    while (next < text.length && text[next] === ' ') next++;
    if (next >= text.length) return stop;
    pos = next;
  }
}

/** 值区内逐个 `名=值` 打码，属性名（path / Max-Age 等）原样保留 */
function maskCookieRun(run: string): string {
  return run.replace(COOKIE_PAIR, (match, name: string) =>
    COOKIE_ATTRS.has(name.toLowerCase()) ? match : `${name}=***`,
  );
}

/** `Cookie: <没有 名=值 结构的长串>`：整段就是凭据，直接盖掉 */
const BARE_COOKIE = /^[0-9A-Za-z._+/=-]{8,}$/;

/** 所有 cookie 头之后的值区逐个打码 */
function maskCookieRuns(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const head = COOKIE_HEAD.exec(rest);
    if (!head || head.index === undefined) break;
    const from = head.index + head[0].length;
    const to = cookieRunEnd(rest, from);
    out += rest.slice(0, from);
    if (to > from) {
      out += maskCookieRun(rest.slice(from, to));
    } else {
      // 没有 cookie 结构可留：值区起点到第一个分隔符之间若是长串，整段打掉（裸令牌形态）
      const stop = segmentEnd(rest, from);
      const seg = rest.slice(from, stop).trim();
      out += BARE_COOKIE.test(seg) ? '***' : seg.length > 0 ? seg : '';
      rest = rest.slice(stop);
      continue;
    }
    rest = rest.slice(to);
  }
  out += rest;
  return out;
}

export function redactNoticeText(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let masked = maskCookieRuns(raw);
  masked = masked.replace(AUTH_KEY, (_m, name: string, sep: string, scheme?: string, sp?: string) =>
    `${name}${sep}${scheme ?? ''}${sp ?? ''}***`,
  );
  masked = masked.replace(BARE_SCHEME_TOKEN, '$1 ***');
  masked = masked.replace(
    CREDENTIAL_KEY,
    (_m, name: string, sep: string) => `${name}${sep}***`,
  );
  return redactUrl(masked);
}

/** 从上游原文里读 Retry-After（只认纯秒数，HTTP-date 形态不猜） */
export function retryAfterSecOf(raw: string | null | undefined): number | null {
  const m = /retry[-_ ]after["']?\s*[:=]\s*(\d{1,6})/i.exec(raw ?? '');
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec >= 0 && sec <= 86_400 ? sec : null;
}

/**
 * 登记一条上游提示：分档 + 脱敏 + 一行结构化日志。
 *
 * 展示文字一律来自分档后的固定话术（`kind`），绝不回吐上游原文；原文脱敏后只进日志。
 * 日志行同时带上 requestId，下一轮复现时能把「屏幕上的那句话」和「哪一次调用」对上。
 */
export function recordUpstreamNotice(
  rawMessage: string | null | undefined,
  ctx: NoticeContext,
): RecordedNotice {
  const trimmed = (rawMessage ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const detail = redactNoticeText(trimmed).slice(0, 300);
  const httpStatus = ctx.httpStatus ?? null;
  const businessCode = ctx.businessCode ?? null;
  const retryAfterSec = ctx.retryAfterSec ?? retryAfterSecOf(trimmed);
  // 分档只有一套口径：把已知信号拼成错误形状交给 classifySourceFailure
  const shape: AppErrorShape = {
    code: ctx.errorCode ?? 'E_UNKNOWN',
    message: trimmed,
    detail,
    retryable: false,
    httpStatus,
  };
  const kind = classifySourceFailure(shape);
  const notice: RecordedNotice = {
    requestId: newNoticeRequestId(`${ctx.origin}|${trimmed}`),
    noticeOrigin: ctx.origin,
    kind,
    // 展示位用分档后的固定话术；原文（脱敏）只进日志，两者在同一行里能对起来
    text: guidanceOf(shape).title,
    detail,
    httpStatus,
    businessCode,
    retryAfterSec,
  };
  logger.info('上游提示登记', {
    requestId: notice.requestId,
    noticeOrigin: notice.noticeOrigin,
    originLabel: NOTICE_ORIGIN_LABELS[ctx.origin],
    kind: notice.kind,
    operation: ctx.operation ?? '',
    sourceId: ctx.sourceId ?? '',
    httpStatus,
    businessCode,
    retryAfterSec,
    displayText: notice.text,
    text: detail,
  });
  return notice;
}
