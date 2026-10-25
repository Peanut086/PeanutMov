/**
 * 订阅内容检测器（v1.7 / CHG-18，纯函数无 IO）
 *
 * 回答「拉到的东西不是普通 TVBox 订阅时，它到底是什么」：
 * - macCMS 采集接口 JSON（`code` + `list`/`class`，无 `sites[]`）→ 建议建 site 源；
 * - m3u / TVBox txt 直播播放列表 → 建议加入直播页；
 * - 单流 m3u8（无 EXTINF 或仅 1 路）→ 建议加入自定义频道。
 *
 * 供 importService 在 `subscriptionParser` 判定 FORMAT_UNSUPPORTED 后兜底调用；
 * `sub.html-sniff` 管道解析器复用 `sniffHtmlConfigLinks` 抽取落地页候选。
 */

/** macCMS 采集接口响应特征（v1.7/FR-50）：`code` + (`list`|`class`) 且无 TVBox `sites[]`/`urls[]` */
export function detectCmsApiPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if ('sites' in record || 'urls' in record || 'lives' in record) return false;
  const hasCode = record['code'] !== undefined;
  const hasList = Array.isArray(record['list']);
  const hasClass = Array.isArray(record['class']);
  // macCMS v10 惯例：code=1（或 "1"）+ list；分类接口可能只有 class
  if (!hasCode || (!hasList && !hasClass)) return false;
  if (hasList && (record['list'] as unknown[]).length === 0 && !hasClass) return false;
  return true;
}

export interface LiveListDetection {
  kind: 'live-list' | 'single-stream';
  format: 'm3u' | 'txt';
  channelCount: number;
}

/** m3u / TVBox txt 直播播放列表检测（v1.7/FR-49） */
export function detectLiveList(text: string): LiveListDetection | null {
  const trimmed = text.trim();

  if (/^#EXTM3U/m.test(trimmed)) {
    const channelCount = (trimmed.match(/^#EXTINF/gm) ?? []).length;
    // 媒体清单（ts/fmp4 分片）没有 EXTINF；只有 1 路 EXTINF 视为单流
    if (channelCount <= 1) return { kind: 'single-stream', format: 'm3u', channelCount };
    return { kind: 'live-list', format: 'm3u', channelCount };
  }

  // TVBox txt：存在 `xx,#genre#` 行才算
  if (/^.*,#genre#\s*$/m.test(trimmed)) {
    const channelCount = trimmed.split(/\r?\n/).filter((line) => {
      const comma = line.indexOf(',');
      if (comma <= 0) return false;
      const value = line.slice(comma + 1).trim();
      return value.length > 0 && /^#genre#$/i.test(value) === false && /^https?:\/\//i.test(value.split('#')[0] ?? '');
    }).length;
    if (channelCount === 0) return null;
    return { kind: 'live-list', format: 'txt', channelCount };
  }

  return null;
}

/** 页面是否像 HTML（与管道指纹口径一致的首字符判定，供 importService 兜底用） */
export function looksLikeHtmlText(text: string): boolean {
  return /^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|meta[\s>]|script[\s>]|div[\s>]|a[\s>]|\?xml)/i.test(
    text.trimStart(),
  );
}

/** 配置链接候选（href/src 与裸串里的 .json/.txt/api.php） */
const CANDIDATE_PATTERN =
  /(?:href|src)\s*=\s*["']([^"']*\.(?:json|txt)(?:\?[^"']*)?|[^"']*api\.php[^"']*)["']|(https?:\/\/[^\s"'<>，。；）】]+\.(?:json|txt)(?:\?[^\s"'<>，。；）】]*)?)/gi;

/** meta refresh / JS 跳转目标（短链落地页常见） */
const REDIRECT_PATTERN =
  /url=\s*([^"'>;\s]+)/gi;

/**
 * HTML 落地页嗅探：抽取**同域**（或相对路径解析后同域）的候选配置链接，≤limit 条。
 * 优先级：api.php > .json > .txt；同名去重。
 */
export function sniffHtmlConfigLinks(html: string, pageUrl: string, limit = 3): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }

  const found: Array<{ url: string; rank: number }> = [];
  const push = (raw: string, rank: number): void => {
    const value = raw.trim();
    if (value.length === 0) return;
    let absolute: string;
    try {
      absolute = new URL(value, base).toString();
    } catch {
      return;
    }
    const parsed = new URL(absolute);
    if (parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return; // 只认同域
    if (!/\.(?:json|txt)(?:[?#]|$)|api\.php/i.test(parsed.pathname + parsed.search)) return;
    if (found.some((item) => item.url === absolute)) return;
    found.push({ url: absolute, rank });
  };

  for (const match of html.matchAll(CANDIDATE_PATTERN)) {
    const value = match[1] ?? match[2];
    if (value) push(value, /api\.php/i.test(value) ? 0 : /\.json/i.test(value) ? 1 : 2);
  }
  for (const match of html.matchAll(REDIRECT_PATTERN)) {
    const value = match[1];
    if (value) push(value, 3); // meta refresh / JS 跳转目标排最后
  }

  return found
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((item) => item.url);
}
