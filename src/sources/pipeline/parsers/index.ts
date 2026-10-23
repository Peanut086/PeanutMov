/**
 * 内置解析器集合
 *
 * 每个解析器只做"从已解码正文里取出结构化结果"，不发请求、不写全局状态。
 * 用户文案沿用契约规定的常量，`detail` 放诊断信息（前若干字符片段）。
 *
 * 订阅意图只做"格式校验 + 原样返回文本"：`subscriptionParser` 已实现
 * 多仓索引识别、`//` 注释容错、逐条字段校验与 issue 汇总，
 * 在管道里重复实现会让两份语义漂移。
 */
import { AppError } from '@/shared/errors';
import { toAbsoluteUrl } from '@/shared/url';
import { decodeBody } from '../decode';
import { extractMediaFromPage } from '../mediaExtract';
import { NOT_TVBOX_MESSAGE, PLAY_PAGE_NOT_FOUND_MESSAGE, UNSUPPORTED_FORMAT_MESSAGE } from '../messages';
import type { CrawlIntent, CrawlParser } from '../types';

const LIST_INTENTS: readonly CrawlIntent[] = ['catalog', 'detail', 'search', 'probe'];

/** 顶层值类型描述（诊断用） */
function topLevelTypeOf(payload: unknown): string {
  if (payload === null) return 'null';
  if (Array.isArray(payload)) return 'array';
  return typeof payload;
}

/* ---------- json.tvbox：严格 JSON + TVBox 形状判定 ---------- */

interface TvboxListResponseLike {
  code?: number | string;
  msg?: string | null;
  page?: number | string;
  pagecount?: number | string;
  limit?: number | string;
  total?: number | string;
  list?: unknown[] | null;
  class?: unknown[] | null;
}

export const jsonTvboxParser: CrawlParser<unknown> = {
  id: 'json.tvbox',
  version: 1,
  intents: LIST_INTENTS,

  parse(ctx) {
    const parsed: unknown = ctx.parsedJson ?? JSON.parse(ctx.text);
    return classifyTvbox(parsed, ctx.fingerprint.contentType);
  },
};

/**
 * TVBox 形状判定（从 `SiteAdapter.classifyParsed` 搬来，行为不变）。
 *
 * - 数组：少数站点直接返回数组 → 包成 `{list}`；
 * - 非对象：拒绝；
 * - `list` 存在但非数组：拒绝；
 * - 既无 `list` 也无 `class`：按"不是 TVBox 格式"拒绝。
 */
export function classifyTvbox(payload: unknown, contentType: string | null): unknown {
  const suffix = contentType ? '' : '；Content-Type 不可读';

  if (Array.isArray(payload)) {
    return { list: payload };
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new AppError('E_UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE, {
      detail: `顶层值类型：${topLevelTypeOf(payload)}${suffix}`,
      retryable: false,
    });
  }

  const response = payload as TvboxListResponseLike;
  if (response.list !== undefined && response.list !== null && !Array.isArray(response.list)) {
    throw new AppError('E_UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE, {
      detail: `list 字段不是数组${suffix}`,
      retryable: false,
    });
  }
  if (response.list === undefined || response.list === null) {
    if (response.class === undefined || response.class === null) {
      const keys = Object.keys(payload).slice(0, 10).join(',');
      throw new AppError('E_UNSUPPORTED_FORMAT', NOT_TVBOX_MESSAGE, {
        detail: `顶层键：${keys.length > 0 ? keys : '（空对象）'}${suffix}`,
        retryable: false,
      });
    }
  }
  return response;
}

/* ---------- sub.raw：订阅文本原样交给 subscriptionParser ---------- */

export interface SubscriptionText {
  text: string;
}

/**
 * 订阅意图只做"非空"校验，正文原样交给 `subscriptionParser`。
 *
 * 为什么不在管道里判定 JSON 形状：订阅解析已实现多仓索引识别、`//` 注释容错、
 * 硬折行拼接、逐条字段校验与可操作诊断。在管道里提前拒绝（例如以 `//` 注释开头的
 * 合法订阅）会把这些能力挡在门外，属于行为漂移。
 */
export const subRawParser: CrawlParser<SubscriptionText> = {
  id: 'sub.raw',
  version: 1,
  intents: ['subscription'],

  parse(ctx) {
    if (ctx.text.trim().length === 0) {
      throw new AppError('E_UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE, {
        detail: '响应体为空',
        retryable: false,
      });
    }
    return { text: ctx.text };
  },
};

/* ---------- html.media：网页播放页取 m3u8/mp4 ---------- */

export const htmlMediaParser: CrawlParser<string> = {
  id: 'html.media',
  version: 1,
  intents: ['playpage'],

  parse(ctx) {
    // 页面本身就是清单（某些站点直接吐 m3u8 文本）
    if (ctx.text.trimStart().startsWith('#EXTM3U')) return ctx.url;

    const candidates = extractMediaFromPage(ctx.text, ctx.url);
    if (candidates.length === 0) {
      throw new AppError('E_NO_PLAY_URL', PLAY_PAGE_NOT_FOUND_MESSAGE, {
        detail: `页面内未匹配到 m3u8/mp4 地址（前 80 字符：${ctx.text.trim().replace(/\s+/g, ' ').slice(0, 80)}）`,
        retryable: false,
      });
    }
    // 只取首个：与既有 resolvePlayPage 行为一致，不猜多候选
    return candidates[0]!.url;
  },
};

/* ---------- xml.vod：返回 XML/RSS 的接口 ---------- */

/** 简易 XML 实体还原（不引依赖，覆盖 rss 常见实体） */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/gi, '&');
}

interface XmlVodOptions {
  /** 列表项路径（如 `rss/channel/item`） */
  listPath: string;
  /** 字段映射：TVBox 字段 ← XML 标签（支持 `tag@attr`） */
  map: Record<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按 `/` 分层路径抓取同名标签集合（足够 rss/channel/item 这类结构） */
function selectXmlNodes(xml: string, path: string): string[] {
  const steps = path.split('/').filter((s) => s.length > 0);
  let scope = [xml];
  for (const step of steps) {
    const next: string[] = [];
    const pattern = new RegExp(`<${escapeRegExp(step)}(\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(step)}>`, 'gi');
    for (const chunk of scope) {
      for (const match of chunk.matchAll(pattern)) {
        if (match[2] !== undefined) next.push(match[2]);
      }
    }
    scope = next;
    if (scope.length === 0) return [];
  }
  return scope;
}

/** 从一段 XML 里取标签文本（支持 `tag@attr`） */
function xmlFieldOf(node: string, field: string): string | null {
  const [tag, attr] = field.split('@');
  if (!tag) return null;
  const pattern = new RegExp(`<${escapeRegExp(tag)}(\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(tag)}>`, 'i');
  const match = pattern.exec(node);
  if (!match) return null;
  const inner = match[2] ?? '';
  if (attr) {
    const attrPattern = new RegExp(`${escapeRegExp(attr)}\\s*=\\s*"([^"]*)"`, 'i');
    const attrMatch = attrPattern.exec(match[1] ?? '');
    return attrMatch?.[1] ? unescapeXml(attrMatch[1]) : null;
  }
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(inner);
  const raw = cdata?.[1] ?? inner;
  return unescapeXml(raw.replace(/<[^>]*>/g, '').trim());
}

export const xmlVodParser: CrawlParser<unknown> = {
  id: 'xml.vod',
  version: 1,
  intents: ['catalog', 'detail', 'search'],

  parse(ctx) {
    const options = ctx.options as unknown as Partial<XmlVodOptions>;
    if (!options.listPath || !options.map) {
      throw new AppError('E_UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE, {
        detail: 'xml.vod 规则缺少 listPath / map 配置',
        retryable: false,
      });
    }

    const nodes = selectXmlNodes(ctx.text, options.listPath);
    if (nodes.length === 0) {
      throw new AppError('E_UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE, {
        detail: `XML 未匹配到列表节点 ${options.listPath}（前 80 字符：${ctx.text.trim().slice(0, 80)}）`,
        retryable: false,
      });
    }

    const list = nodes.map((node) => {
      const vod: Record<string, unknown> = {};
      for (const [target, source] of Object.entries(options.map!)) {
        vod[target] = xmlFieldOf(node, source);
      }
      // 播放地址归一成 TVBox 的 `名称$地址` 形态，复用 SiteAdapter 的线路/剧集解析
      const link = typeof vod['vod_play_url'] === 'string' ? (vod['vod_play_url'] as string) : '';
      if (link.length > 0) {
        const absolute = toAbsoluteUrl(ctx.url, link) ?? link;
        const name = typeof vod['vod_name'] === 'string' ? (vod['vod_name'] as string) : '';
        vod['vod_play_url'] = `${name}$${absolute}`;
        vod['vod_play_from'] = '线路1';
      }
      return vod;
    });

    return { code: 1, list };
  },
};

/* ---------- text.charset：按规则显式指定的字符集重新解码 ---------- */

/**
 * 管道默认按 BOM → header → 探测解码（GBK 站点已自动识别）；
 * 本解析器用于规则**显式指定**字符集的源：header 声明 `text/html`（无 charset）
 * 且正文恰好能被 UTF-8 宽松解码、真实内容是 GBK 的极端情况。
 */
export const textCharsetParser: CrawlParser<{ text: string; charset: string }> = {
  id: 'text.charset',
  version: 1,
  intents: ['subscription', 'catalog', 'detail', 'search', 'playpage'],

  parse(ctx) {
    const wanted = typeof ctx.options.charset === 'string' ? ctx.options.charset : 'gbk';
    if (wanted === ctx.charset) return { text: ctx.text, charset: ctx.charset };
    try {
      const decoded = decodeBody({ bytes: ctx.bytes, contentType: `text/plain; charset=${wanted}` });
      return { text: decoded.text, charset: decoded.charset };
    } catch {
      throw new AppError('E_PARSE', '数据解析失败，源可能已变更', {
        detail: `按 ${wanted} 重新解码失败（当前解码为 ${ctx.charset}）`,
        retryable: false,
      });
    }
  },
};

/* ---------- reject.fixed：参数化拒绝器 ---------- */

interface RejectOptions {
  code?: string;
  message?: string;
  detailPrefix?: string;
}

export const rejectFixedParser: CrawlParser<never> = {
  id: 'reject.fixed',
  version: 1,
  intents: ['subscription', 'catalog', 'detail', 'search', 'playpage', 'probe'],

  parse(ctx) {
    const options = ctx.options as unknown as Partial<RejectOptions>;
    const code = options.code === 'E_PARSE' ? 'E_PARSE' : 'E_UNSUPPORTED_FORMAT';
    const contentType = ctx.fingerprint.contentType ?? '不可读';
    const magic = ctx.fingerprint.magic ?? 'none';
    const snippet = ctx.text.trim().replace(/\s+/g, ' ').slice(0, 80);
    throw new AppError(code, options.message, {
      detail: `${options.detailPrefix ?? '响应被拒绝'}（Content-Type: ${contentType}；magic: ${magic}；前 80 字符：${snippet}）`,
      retryable: false,
    });
  },
};
