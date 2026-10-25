/**
 * 内置规则包
 *
 * 规则只描述"匹配条件 + 解析器 id + 参数"，**不能携带代码**。
 * 匹配顺序按 priority 升序；同优先级按数组声明顺序。
 *
 * 优先级约定：
 *   1-9   拒绝类（图片伪装、落地页）——命中即失败，不浪费解析
 *   10-29 精确格式（HTML 包装的 JSON、播放页、XML）
 *   30-49 通用格式（TVBox JSON、纯文本 URL 列表）
 */
import type { CrawlRule, RetryPolicy } from '../types';

/** 网络类失败才重试；格式错误不重试（重试同一份响应没有意义） */
const NETWORK_RETRY: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: [400, 900],
  retryOn: ['E_TIMEOUT', 'E_NETWORK', 'E_HTTP_5XX', 'E_HTTP_429'],
  jitterRatio: 0.2,
};

/** 一次性规则：不重试 */
const NO_RETRY: RetryPolicy = { maxAttempts: 1, backoffMs: [], retryOn: [] };

/** 桌面浏览器 UA（部分站点对非浏览器 UA 直接 403） */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** 移动浏览器 UA（播放页多为移动端页面） */
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export const BUILTIN_RULES: readonly CrawlRule[] = [
  /* ---------- 拒绝：图片伪装（反爬常见） ---------- */
  {
    id: 'reject.image-masquerade',
    priority: 1,
    intent: ['subscription', 'catalog', 'detail', 'search', 'probe', 'playpage'],
    when: {
      any: [
        { field: 'contentType', op: 'contains', value: 'image/' },
        { field: 'looksLike.image', op: 'eq', value: true },
      ],
    },
    parser: 'reject.fixed',
    parserOptions: {
      code: 'E_UNSUPPORTED_FORMAT',
      message: '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截',
      detailPrefix: '响应为图片',
    },
    terminal: true,
    retry: NO_RETRY,
    cost: 'cheap',
  },

  /* ---------- v1.7/CHG-18：订阅 HTML 落地页嗅探（优先于通用拒绝） ----------
   * 官网主页 / 短链落地页（影视仓.com、Link3.cc 这类）拉到的是 HTML，
   * 先抽同域 .json/.txt/api.php 候选链接给 importService 二次拉取；
   * 无候选时由解析器自身按同文案拒绝。其余意图维持 reject.html-landing。
   */
  {
    id: 'sub.html-sniff',
    priority: 2,
    intent: ['subscription'],
    when: {
      all: [
        { field: 'looksLike.html', op: 'eq', value: true },
        { field: 'looksLike.json', op: 'eq', value: false },
      ],
    },
    parser: 'sub.html-sniff',
    terminal: true,
    retry: NO_RETRY,
    cost: 'cheap',
  },

  /* ---------- 拒绝：HTML 落地页（不是播放页、也不是 JSON；订阅意图由 sub.html-sniff 接管） ---------- */
  {
    id: 'reject.html-landing',
    priority: 2,
    intent: ['catalog', 'detail', 'search', 'probe'],
    when: {
      all: [
        { field: 'looksLike.html', op: 'eq', value: true },
        { field: 'looksLike.json', op: 'eq', value: false },
      ],
    },
    parser: 'reject.fixed',
    parserOptions: {
      code: 'E_UNSUPPORTED_FORMAT',
      message: '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截',
      detailPrefix: '响应不是合法 JSON',
    },
    terminal: true,
    retry: NO_RETRY,
    cost: 'cheap',
  },

  /* ---------- 拒绝：空响应 ---------- */
  {
    id: 'reject.empty',
    priority: 3,
    intent: ['subscription', 'catalog', 'detail', 'search', 'probe', 'playpage'],
    when: { all: [{ field: 'looksLike.empty', op: 'eq', value: true }] },
    parser: 'reject.fixed',
    parserOptions: {
      code: 'E_UNSUPPORTED_FORMAT',
      message: '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截',
      detailPrefix: '响应体为空',
    },
    terminal: true,
    retry: NO_RETRY,
    cost: 'cheap',
  },

  /* ---------- CHG-06：text/html 但正文是 TVBox JSON（Cloudflare 代理特征） ---------- */
  {
    id: 'cms.json-on-html-mime',
    priority: 10,
    intent: ['catalog', 'detail', 'search', 'probe'],
    when: {
      all: [
        { field: 'status', op: 'eq', value: 200 },
        { field: 'contentType', op: 'contains', value: 'text/html' },
        { field: 'looksLike.json', op: 'eq', value: true },
      ],
    },
    parser: 'json.tvbox',
    terminal: true,
    retry: NETWORK_RETRY,
    handshake: {
      accept: 'application/json, text/plain, */*',
      timeoutMs: 8000,
      redirect: 'follow',
    },
  },

  /* ---------- 网页播放页 → 直链 ---------- */
  {
    id: 'playpage.html-media',
    priority: 20,
    intent: ['playpage'],
    when: { all: [{ field: 'status', op: 'eq', value: 200 }] },
    parser: 'html.media',
    parserOptions: { preferExt: ['m3u8', 'mp4', 'webm'] },
    terminal: true,
    handshake: { ua: MOBILE_UA, accept: 'text/html,application/xhtml+xml', timeoutMs: 8000 },
    retry: { maxAttempts: 2, backoffMs: [500], retryOn: ['E_TIMEOUT', 'E_NETWORK'], jitterRatio: 0.2 },
  },

  /* ---------- XML/RSS 接口 ---------- */
  {
    id: 'catalog.xml-vod',
    priority: 25,
    intent: ['catalog', 'detail', 'search'],
    when: {
      any: [
        { field: 'looksLike.xml', op: 'eq', value: true },
        { field: 'mime', op: 'contains', value: 'xml' },
      ],
    },
    parser: 'xml.vod',
    parserOptions: {
      listPath: 'rss/channel/item',
      map: {
        vod_id: 'guid',
        vod_name: 'title',
        vod_pic: 'enclosure@url',
        vod_play_url: 'link',
      },
    },
    terminal: true,
    retry: NETWORK_RETRY,
  },

  /* ---------- v1.7/CHG-18：直播播放列表文本透传 ----------
   * m3u（#EXTM3U）与 TVBox txt（xx,#genre#）不是 JSON、也未必匹配 sub.raw 的
   * 逐行 URL 条件，会掉进 reject.not-json。先透传给 subscriptionParser 链路，
   * 由 importService 的检测器分类「直播列表 / 单流」并产出建议。
   */
  {
    id: 'sub.live-list',
    priority: 5,
    intent: ['subscription'],
    when: {
      any: [
        { field: 'bodyRegex', op: 'regex', value: '^\\s*#EXTM3U', flags: 'm' },
        { field: 'bodyRegex', op: 'regex', value: '^.*,#genre#\\s*$', flags: 'm' },
      ],
    },
    parser: 'sub.raw',
    terminal: true,
    retry: NO_RETRY,
    cost: 'cheap',
  },

  /* ---------- 订阅：TVBox/简化 JSON 或逐行 URL 文本（原样交给 subscriptionParser） ---------- */
  {
    id: 'sub.raw',
    priority: 20,
    intent: ['subscription'],
    when: {
      any: [
        { field: 'looksLike.json', op: 'eq', value: true },
        { field: 'bodyRegex', op: 'regex', value: '^\\s*https?://\\S+\\s*$', flags: 'm' },
      ],
    },
    parser: 'sub.raw',
    terminal: true,
    retry: NO_RETRY,
    handshake: { accept: 'application/json, text/plain, */*', timeoutMs: 10000 },
  },

  /* ---------- 通用 TVBox JSON（application/json 或不可读 Content-Type） ---------- */
  {
    id: 'cms.json',
    priority: 40,
    intent: ['catalog', 'detail', 'search', 'probe'],
    when: { all: [{ field: 'looksLike.json', op: 'eq', value: true }] },
    parser: 'json.tvbox',
    terminal: true,
    retry: NETWORK_RETRY,
    handshake: { accept: 'application/json, text/plain, */*', timeoutMs: 8000, redirect: 'follow' },
  },

  /* ---------- 403/429：UA 适配（最多 2 个变体，防打挂） ---------- */
  {
    id: 'cms.ua-adaptive',
    priority: 15,
    intent: ['catalog', 'detail', 'search', 'probe'],
    when: {
      all: [
        { field: 'status', op: 'in', value: [403, 429] },
        { field: 'looksLike.json', op: 'eq', value: true },
      ],
    },
    parser: 'json.tvbox',
    terminal: false,
    handshake: { accept: 'application/json, text/plain, */*', timeoutMs: 8000 },
    handshakeVariants: [{ ua: DESKTOP_UA, accept: 'application/json, text/plain, */*' }],
    retry: NO_RETRY,
  },
  /* ---------- 兜底：能拿到正文但不是 JSON/XML/URL 列表（多为纯文本/错误页） ---------- */
  {
    id: 'reject.not-json',
    priority: 90,
    intent: ['subscription', 'catalog', 'detail', 'search', 'probe'],
    when: {
      all: [
        { field: 'looksLike.json', op: 'eq', value: false },
        { field: 'looksLike.empty', op: 'eq', value: false },
      ],
    },
    parser: 'reject.fixed',
    parserOptions: {
      code: 'E_UNSUPPORTED_FORMAT',
      message: '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截',
      detailPrefix: '响应不是合法 JSON',
    },
    terminal: true,
    retry: NO_RETRY,
    cost: 'cheap',
  },
];

/** 默认规则（内置规则包） */
export function defaultRules(): CrawlRule[] {
  return BUILTIN_RULES.map((rule) => ({ ...rule, source: 'builtin' as const, version: 1 }));
}
