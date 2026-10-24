/**
 * 直播播放列表解析（CHG-13）
 *
 * 三种形态：
 * - M3U/M3U8（`#EXTM3U` + `#EXTINF`，IPTV 社区主流，如 iptv-org / fanmingming）；
 * - TVBox 直播 txt（`分组名,#genre#` + `频道名,http://…`，如 live.zbds.top）；
 * - TVBox 配置的 `lives[]` 字段（指向 txt 播放列表的索引，v1 不支持内联 channels）。
 *
 * 全部为纯函数：非法行静默跳过（直播源更新频繁，坏行不该整份报废），
 * URL 只接受 http(s)/rtmp（rtmp 浏览器不能播，标记出来由上层决定是否保留）。
 */

export interface LiveChannel {
  /** 频道名（如 `CCTV-1`） */
  name: string;
  url: string;
  /** 分组名（m3u 的 group-title / txt 的 #genre#；缺失为「未分组」） */
  group: string;
  logo: string | null;
}

export interface TvboxLiveSource {
  name: string;
  /** txt / m3u 播放列表地址 */
  url: string;
}

/** 按 URL 协议粗判是否能播：浏览器/WebView 只吃 http(s) 与 hls；rtmp 列出来但不保证可播 */
export function isPlayableLiveUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^rtmp:\/\//i.test(url);
}

/** 检测播放列表格式；无法识别返回 null */
export function detectLiveFormat(text: string): 'm3u' | 'txt' | null {
  if (/^\s*#EXTM3U/m.test(text)) return 'm3u';
  if (/^.*,#genre#\s*$/m.test(text)) return 'txt';
  return null;
}

/** 解析 m3u 属性串（`tvg-name="x" group-title="y"`） */
function extInfAttr(line: string, attr: string): string | null {
  const match = new RegExp(`${attr}="([^"]*)"`).exec(line);
  return match?.[1] ?? null;
}

/** M3U/M3U8 → 频道列表（非法行跳过） */
export function parseM3u(text: string): LiveChannel[] {
  const channels: LiveChannel[] = [];
  const lines = text.split(/\r?\n/);
  let pending: { name: string; group: string; logo: string | null } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#EXTINF')) {
      const name = line.slice(line.lastIndexOf(',') + 1).trim();
      pending = {
        name: name.length > 0 ? name : (extInfAttr(line, 'tvg-name') ?? '未命名频道'),
        group: extInfAttr(line, 'group-title')?.trim() || '未分组',
        logo: extInfAttr(line, 'tvg-logo') || null,
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending && isPlayableLiveUrl(line)) {
      channels.push({ ...pending, url: line });
    }
    pending = null;
  }
  return channels;
}

/** TVBox 直播 txt → 频道列表（`分组,#genre#` + `频道,URL`；URL 可带 `$` 后缀备注） */
export function parseLiveTxt(text: string): LiveChannel[] {
  const channels: LiveChannel[] = [];
  let group = '未分组';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const comma = line.indexOf(',');
    if (comma <= 0) continue;
    const name = line.slice(0, comma).trim();
    const value = line.slice(comma + 1).trim();
    if (/^#genre#$/i.test(value)) {
      group = name;
      continue;
    }
    // `url#需要验证$备注` 等后缀：取到第一个 # 前的地址
    const url = value.split('#')[0]?.trim() ?? '';
    if (name.length > 0 && isPlayableLiveUrl(url)) {
      channels.push({ name, url, group, logo: null });
    }
  }
  return channels;
}

/** 自动检测格式并解析；无法识别返回空 */
export function parseLiveList(text: string): LiveChannel[] {
  const format = detectLiveFormat(text);
  if (format === 'm3u') return parseM3u(text);
  if (format === 'txt') return parseLiveTxt(text);
  return [];
}

/** 频道按分组聚合（保持出现顺序） */
export function groupChannels(channels: LiveChannel[]): Array<{ name: string; channels: LiveChannel[] }> {
  const groups: Array<{ name: string; channels: LiveChannel[] }> = [];
  const byName = new Map<string, LiveChannel[]>();
  for (const channel of channels) {
    const list = byName.get(channel.group);
    if (list) {
      list.push(channel);
    } else {
      const created: LiveChannel[] = [channel];
      byName.set(channel.group, created);
      groups.push({ name: channel.group, channels: created });
    }
  }
  return groups;
}

/** TVBox 配置 JSON → lives[]（type 0 的 url 型直播源；内联 channels 暂不支持） */
export function extractTvboxLives(configText: string): TvboxLiveSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const lives = (parsed as { lives?: unknown }).lives;
  if (!Array.isArray(lives)) return [];
  const out: TvboxLiveSource[] = [];
  for (const item of lives) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, url, type } = item as { name?: unknown; url?: unknown; type?: unknown };
    if (typeof url !== 'string' || url.length === 0) continue;
    if (!isPlayableLiveUrl(url)) continue;
    // type 0 = url 指向播放列表；其它类型（1 组播等）v1 不支持
    if (typeof type === 'number' && type !== 0) continue;
    out.push({
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : '直播源',
      url,
    });
  }
  return out;
}
