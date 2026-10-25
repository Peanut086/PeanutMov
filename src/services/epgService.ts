/**
 * EPG 节目单服务（v1.7 / CHG-23，FR-55）
 *
 * 两种数据形态（按响应自动识别）：
 * - diyp 风格 JSON：`GET {endpoint}?ch={频道名}&date={yyyy-MM-dd}` →
 *   `[{ start: "2026-10-25 20:00:00", end: "...", title: "新闻联播" }]`；
 * - XMLTV：`<tv><programme start="20261025200000 +0800" ...><title>…</title></programme></tv>`。
 *
 * 缓存 24h（TTL，`epgCache`）；失败静默返回空列表（EPG 缺失不影响播放）。
 */
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { httpClient } from '@/sources/base/httpClient';
import { EPG_DEFAULT_ENDPOINT } from '@/shared/constants';
import { logger } from '@/shared/logger';

export interface EpgProgramme {
  /** hh:mm（24 小时制） */
  start: string;
  end: string;
  title: string;
  desc: string | null;
  /** 当天 0 点起的秒偏移（UI 定位「现在播」用） */
  startSec: number;
  endSec: number;
}

/** 尾部 hh:mm:ss（diyp 的 start 常是 `2026-10-25 20:06:00` 全时间戳） */
const TIME_HM = /(\d{1,2}):(\d{2})(?::\d{2})?\s*$/;

/** "20:06:00" / "2026-10-25 20:06:00" → 当天秒偏移 */
function secOfDay(value: string): number {
  const match = TIME_HM.exec(value.trim());
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

/** "2026-10-25 20:06:00" → "20:06"（展示用，截不到回落原值） */
function hmOf(value: string): string {
  const match = /(\d{1,2}:\d{2})(?::\d{2})?\s*$/.exec(value.trim());
  return match ? match[1]! : value.trim();
}

interface DiypItem {
  start?: string;
  end?: string;
  title?: string;
  desc?: string;
}

function normalizeDiyp(items: DiypItem[]): EpgProgramme[] {
  const out: EpgProgramme[] = [];
  for (const item of items) {
    if (!item.start || !item.title) continue;
    const startSec = secOfDay(item.start);
    const endSec = item.end ? secOfDay(item.end) : startSec;
    out.push({
      start: hmOf(item.start),
      end: item.end ? hmOf(item.end) : '',
      title: item.title.trim(),
      desc: item.desc?.trim() || null,
      startSec,
      endSec: endSec > startSec ? endSec : startSec + 1800,
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/* ---------- XMLTV ---------- */

function xmlEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** XMLTV 时间 `20261025200600 +0800` → 当天秒偏移 */
function xmltvSec(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value.trim());
  if (!match) return 0;
  return Number(match[4]) * 3600 + Number(match[5]) * 60;
}

function xmltvHm(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value.trim());
  return match ? `${match[4]}:${match[5]}` : '';
}

function parseXmltv(xml: string): EpgProgramme[] {
  const out: EpgProgramme[] = [];
  const pattern = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const startAttr = /\bstart\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? '';
    const stopAttr = /\bstop\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? '';
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? '';
    if (!startAttr || title.length === 0) continue;
    const desc = /<desc[^>]*>([\s\S]*?)<\/desc>/i.exec(body)?.[1];
    const startSec = xmltvSec(startAttr);
    const endSec = stopAttr ? xmltvSec(stopAttr) : startSec + 1800;
    out.push({
      start: xmltvHm(startAttr),
      end: xmltvHm(stopAttr),
      title: xmlEntities(title),
      desc: desc ? xmlEntities(desc.trim()) : null,
      startSec,
      endSec: endSec > startSec ? endSec : startSec + 1800,
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** 解析调度（供单测）：diyp JSON 数组或 XMLTV 文本 */
export function parseEpgResponse(text: string): EpgProgramme[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) return parseXmltv(trimmed);
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (Array.isArray(payload)) return normalizeDiyp(payload as DiypItem[]);
    if (payload !== null && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const list = record['epg'] ?? record['list'] ?? record['data'];
      if (Array.isArray(list)) return normalizeDiyp(list as DiypItem[]);
    }
  } catch {
    /* 非 JSON：落入空 */
  }
  return [];
}

function dateKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const epgService = {
  /**
   * 拉取某频道某天的节目单（默认今天）。缓存命中不发请求；失败返回 []。
   * `endpoint` 缺省用 `EPG_DEFAULT_ENDPOINT`（diyp 风格）。
   */
  async programmes(channel: string, date: Date = new Date(), endpoint: string = EPG_DEFAULT_ENDPOINT): Promise<EpgProgramme[]> {
    const key = `${channel}:${dateKeyOf(date)}`;
    const cached = await cacheRepo.getEpg(key);
    if (cached) return cached;
    try {
      // diyp 协议要求 query 带 ch/date；对 XMLTV 端点附加参数无害
      const url = new URL(endpoint);
      url.searchParams.set('ch', channel);
      url.searchParams.set('date', dateKeyOf(date));
      const text = await httpClient.request<string>(url.toString(), {
        responseType: 'text',
        timeoutMs: 6000,
        retries: 0,
        headers: { Accept: 'application/json, text/xml, */*' },
      });
      if (text.trim().length === 0) return [];
      const programmes = parseEpgResponse(text);
      if (programmes.length > 0) await cacheRepo.putEpg(key, programmes);
      return programmes;
    } catch (e) {
      logger.debug('EPG 拉取失败（不影响播放）', channel, e);
      return [];
    }
  },

  /** 当前正在播的节目（无命中返回 null） */
  nowPlaying(programmes: EpgProgramme[], now: Date = new Date()): EpgProgramme | null {
    const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    return programmes.find((p) => p.startSec <= sec && sec < p.endSec) ?? null;
  },

  /** 接下来的节目（最多 limit 条） */
  upNext(programmes: EpgProgramme[], now: Date = new Date(), limit = 3): EpgProgramme[] {
    const current = this.nowPlaying(programmes, now);
    const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    return programmes
      .filter((p) => p !== current && p.startSec > sec)
      .slice(0, limit);
  },
};
