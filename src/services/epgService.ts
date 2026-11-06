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
import { epgSourceService } from '@/services/epgSourceService';
import {
  channelKeyOf,
  epgNameCandidates,
  normalizeChannelName,
  normalizeTvgId,
  programmeKeyOf,
} from '@/shared/channelKey';
import {
  BUILTIN_EPG_SOURCE_ID,
  EPG_CACHE_KEY_PREFIX,
  EPG_CACHE_TTL_MS,
  EPG_DEFAULT_ENDPOINT,
  EPG_FETCH_TIMEOUT_MS,
  EPG_MERGE_CONCURRENCY,
  EPG_PREFETCH_MAX,
} from '@/shared/constants';
import { localDateKey, parseXmltvTime, secOfLocalDay } from '@/shared/epgTime';
import { toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { ChannelEpgResult, EpgChannelRef, EpgMatchLevel, EpgSource } from '@/types';

export interface EpgProgramme {
  /** hh:mm（24 小时制） */
  start: string;
  end: string;
  title: string;
  desc: string | null;
  /** 当天 0 点起的秒偏移（UI 定位「现在播」用） */
  startSec: number;
  endSec: number;
  /** EXT-06：绝对开始时间（epoch ms，跨天/回看渲染用；兼容封装路径不填） */
  startAt?: number;
  /** EXT-06：绝对结束时间（epoch ms） */
  endAt?: number;
  /** EXT-06：`${startAt}:${title}`，提醒唯一键 */
  key?: string;
  /** EXT-06：命中源 id */
  sourceId?: string;
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

/* =====================================================================
 * EXT-06 / FR-67：多源合并与 4 级确定性匹配（API-20 §3.1.5）
 * ===================================================================== */

/** 合并请求 in-flight 去重（AC-158：同一 key 并发调用只发一次网络请求） */
const mergedInFlight = new Map<string, Promise<ChannelEpgResult>>();

/**
 * REV-17：失败源退避表（`sourceId → 可再次尝试的时间点`）。
 * 单源拉取失败后 5 分钟内跳过该源，避免每次合并都等超时；成功即清除。
 */
const failedUntil = new Map<string, number>();
const EPG_SOURCE_BACKOFF_MS = 5 * 60_000;

/* ---------- REV-15：全局并发闸门（跨页面共享，上限 EPG_MERGE_CONCURRENCY） ---------- */

let epgActiveRequests = 0;
const epgSlotWaiters: Array<() => void> = [];

/** 取一个并发槽位（满则排队）；释放时直接把槽位交接给下一个等待者 */
async function acquireEpgSlot(): Promise<void> {
  if (epgActiveRequests < EPG_MERGE_CONCURRENCY) {
    epgActiveRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => epgSlotWaiters.push(resolve));
}

function releaseEpgSlot(): void {
  const next = epgSlotWaiters.shift();
  if (next) {
    // 槽位交接：active 计数不变，避免超发
    next();
    return;
  }
  epgActiveRequests = Math.max(0, epgActiveRequests - 1);
}

/** 在并发闸门内执行网络段 */
async function withEpgSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquireEpgSlot();
  try {
    return await task();
  } finally {
    releaseEpgSlot();
  }
}

/** 测试辅助：当前占用槽位数 / 排队数 */
export function epgSlotStatsForTest(): { active: number; waiting: number } {
  return { active: epgActiveRequests, waiting: epgSlotWaiters.length };
}

const DAY_SEC = 86_400;

interface XmltvChannelEntry {
  id: string;
  names: string[];
}

interface XmltvRawProgramme {
  channel: string;
  startAt: number | null;
  endAt: number | null;
  title: string;
  desc: string | null;
}

interface XmltvParsed {
  channels: XmltvChannelEntry[];
  programmes: XmltvRawProgramme[];
}

interface SourceFetchResult {
  programmes: EpgProgramme[];
  level: EpgMatchLevel;
  stale: boolean;
}

/** 缓存键：`epgv2:{sourceId}:{channelKey}:{yyyy-MM-dd}` */
function epgCacheKeyOf(sourceId: string, channelKey: string, dateKey: string): string {
  return `${EPG_CACHE_KEY_PREFIX}:${sourceId}:${channelKey}:${dateKey}`;
}

function dayStartOfKey(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return Date.now();
  return new Date(y!, m! - 1, d!).getTime();
}

function hmFromSec(sec: number): string {
  const total = ((sec % DAY_SEC) + DAY_SEC) % DAY_SEC;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 无缓存级别时按已有字段推断（仅展示用，不参与判定） */
function fallbackLevel(channel: EpgChannelRef): EpgMatchLevel {
  if (normalizeTvgId(channel.tvgId)) return 1;
  if ((channel.tvgName ?? '').trim()) return 2;
  return 3;
}

/** XMLTV 结构化解析（`<channel>` 节点 + programme 的 channel 归属） */
function parseXmltvStructured(text: string): XmltvParsed {
  const channels: XmltvChannelEntry[] = [];
  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let match: RegExpExecArray | null;
  while ((match = channelRe.exec(text))) {
    const attrs = match[1] ?? '';
    const id = /\bid\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
    const names: string[] = [];
    const nameRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRe.exec(match[2] ?? ''))) {
      const name = xmlEntities((nameMatch[1] ?? '').trim());
      if (name) names.push(name);
    }
    if (id) channels.push({ id, names });
  }

  const programmes: XmltvRawProgramme[] = [];
  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  while ((match = programmeRe.exec(text))) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const channelId = /\bchannel\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim() ?? '';
    const startRaw = /\bstart\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const stopRaw = /\bstop\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const titleRaw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    if (!titleRaw) continue;
    const descRaw = /<desc\b[^>]*>([\s\S]*?)<\/desc>/i.exec(body)?.[1];
    programmes.push({
      channel: channelId,
      startAt: parseXmltvTime(startRaw),
      endAt: parseXmltvTime(stopRaw),
      title: xmlEntities(titleRaw.trim()),
      desc: descRaw ? xmlEntities(descRaw.trim()) : null,
    });
  }
  return { channels, programmes };
}

/** L1 tvg-id → L2 tvg-name → L3 归一化名称；命中即停（不做模糊匹配） */
function matchXmltvChannel(
  parsed: XmltvParsed,
  channel: EpgChannelRef,
  matchMode: EpgSource['matchMode'],
): { channelId: string; level: EpgMatchLevel } | null {
  const tvgId = normalizeTvgId(channel.tvgId);
  if (matchMode !== 'channel-name' && tvgId) {
    const hit = parsed.channels.find((entry) => normalizeTvgId(entry.id) === tvgId);
    if (hit) return { channelId: hit.id, level: 1 };
  }
  const tvgName = (channel.tvgName ?? '').trim().toLowerCase();
  if (matchMode !== 'xmltv-id' && tvgName) {
    const hit = parsed.channels.find((entry) =>
      entry.names.some((name) => name.trim().toLowerCase() === tvgName),
    );
    if (hit) return { channelId: hit.id, level: 2 };
  }
  if (matchMode !== 'xmltv-id') {
    const candidates = new Set(epgNameCandidates(channel));
    if (candidates.size > 0) {
      const hit = parsed.channels.find((entry) =>
        entry.names.some((name) => candidates.has(normalizeChannelName(name))),
      );
      if (hit) return { channelId: hit.id, level: 3 };
    }
  }
  return null;
}

/** 同源内 `(startAt,title)` 去重 + 按 startAt 升序（AC-158） */
function dedupeProgrammes(items: EpgProgramme[]): EpgProgramme[] {
  const seen = new Set<string>();
  const out: EpgProgramme[] = [];
  for (const item of items) {
    const key = item.key ?? programmeKeyOf(item.startAt ?? 0, item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0));
}

/** diyp 结果补绝对时间（服务端已按日期返回，startSec 为当天秒偏移） */
function enrichDiyp(items: EpgProgramme[], dayStart: number, sourceId: string): EpgProgramme[] {
  return items.map((item) => {
    const startAt = dayStart + item.startSec * 1000;
    const rawEndSec = item.endSec > item.startSec ? item.endSec : item.endSec + DAY_SEC;
    const endAt = dayStart + rawEndSec * 1000;
    return { ...item, startAt, endAt, sourceId, key: programmeKeyOf(startAt, item.title) };
  });
}

/** XMLTV 结果按「设备本地日期」过滤归属日（AC-159 跨天归属） */
function normalizeXmltvProgrammes(
  raw: XmltvRawProgramme[],
  dateKey: string,
  sourceId: string,
): EpgProgramme[] {
  const out: EpgProgramme[] = [];
  for (const item of raw) {
    if (item.startAt === null) continue;
    if (localDateKey(item.startAt) !== dateKey) continue;
    const startSec = secOfLocalDay(item.startAt);
    const endMs = item.endAt ?? item.startAt + 1_800_000;
    const endSec = startSec + Math.max(60, Math.round((endMs - item.startAt) / 1000));
    out.push({
      start: hmFromSec(startSec),
      end: hmFromSec(endSec),
      title: item.title,
      desc: item.desc,
      startSec,
      endSec,
      startAt: item.startAt,
      endAt: endMs,
      key: programmeKeyOf(item.startAt, item.title),
      sourceId,
    });
  }
  return out;
}

/** 端点 URL：diyp/auto 附带 `ch`/`date`（对 XMLTV 端点附加参数无害）；显式 xmltv 直取全量文档 */
function endpointUrlOf(source: EpgSource, channel: EpgChannelRef, dateKey: string): string {
  const url = new URL(source.endpoint);
  if (source.protocol !== 'xmltv') {
    url.searchParams.set('ch', channel.name);
    url.searchParams.set('date', dateKey);
    const tvgId = normalizeTvgId(channel.tvgId);
    if (tvgId) url.searchParams.set('xmltv_id', tvgId);
  }
  return url.toString();
}

async function requestProgrammes(
  source: EpgSource,
  channel: EpgChannelRef,
  dateKey: string,
): Promise<{ programmes: EpgProgramme[]; level: EpgMatchLevel }> {
  // REV-15：网络段统一走全局闸门（多页面并发调用 programmesFor 时总并发仍 ≤ EPG_MERGE_CONCURRENCY）
  const text = await withEpgSlot(() =>
    httpClient.request<string>(endpointUrlOf(source, channel, dateKey), {
      responseType: 'text',
      timeoutMs: EPG_FETCH_TIMEOUT_MS,
      retries: 0,
      headers: { Accept: 'application/json, text/xml, */*' },
    }),
  );
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { programmes: [], level: 3 };

  if (trimmed.startsWith('<')) {
    const parsed = parseXmltvStructured(trimmed);
    if (parsed.channels.length > 0) {
      const hit = matchXmltvChannel(parsed, channel, source.matchMode);
      if (!hit) return { programmes: [], level: 3 };
      const raw = parsed.programmes.filter((item) => item.channel === hit.channelId);
      return {
        programmes: dedupeProgrammes(normalizeXmltvProgrammes(raw, dateKey, source.id)),
        level: hit.level,
      };
    }
    // 无 `<channel>` 节点：按 programme 的 channel 属性与频道身份比对
    const candidates = new Set(epgNameCandidates(channel));
    const tvgId = normalizeTvgId(channel.tvgId);
    const raw = parsed.programmes.filter((item) => {
      if (!item.channel) return false;
      return (
        normalizeTvgId(item.channel) === tvgId || candidates.has(normalizeChannelName(item.channel))
      );
    });
    return {
      programmes: dedupeProgrammes(normalizeXmltvProgrammes(raw, dateKey, source.id)),
      level: tvgId ? 1 : 3,
    };
  }

  const items = parseEpgResponse(trimmed);
  return { programmes: enrichDiyp(items, dayStartOfKey(dateKey), source.id), level: 3 };
}

/** 单源读取：新鲜缓存 → 网络 → 过期缓存兜底（stale，受 `allowStale` 控制）；失败不写缓存 */
async function fetchFromSource(
  source: EpgSource,
  channel: EpgChannelRef,
  dateKey: string,
  options?: { allowStale?: boolean },
): Promise<SourceFetchResult> {
  const allowStale = options?.allowStale !== false;
  const cacheKey = epgCacheKeyOf(source.id, channelKeyOf(channel), dateKey);
  // 一次读出整条记录后自行判 TTL：若先用「会删过期」的读法，过期兜底（stale）就永远拿不到数据
  const cached = await cacheRepo.getEpgRecord(cacheKey, { allowExpired: true });
  const fresh = Boolean(cached) && Date.now() - (cached?.fetchedAt ?? 0) <= EPG_CACHE_TTL_MS;
  if (cached && fresh && cached.programmes.length > 0) {
    return {
      programmes: cached.programmes,
      level: cached.matchLevel ?? fallbackLevel(channel),
      stale: false,
    };
  }
  try {
    const fetched = await requestProgrammes(source, channel, dateKey);
    if (fetched.programmes.length > 0) {
      await cacheRepo.putEpgRecord({
        key: cacheKey,
        programmes: fetched.programmes,
        fetchedAt: Date.now(),
        matchLevel: fetched.level,
      });
    }
    return { programmes: fetched.programmes, level: fetched.level, stale: false };
  } catch (error) {
    // REV-16：显式 allowStale=false 时不再回落到过期缓存
    if (allowStale && cached && cached.programmes.length > 0) {
      return {
        programmes: cached.programmes,
        level: cached.matchLevel ?? fallbackLevel(channel),
        stale: true,
      };
    }
    throw error;
  }
}

function emptyResult(channel: EpgChannelRef, channelKey: string, dateKey: string): ChannelEpgResult {
  return {
    channel: { name: channel.name, tvgId: channel.tvgId, tvgName: channel.tvgName },
    channelKey,
    date: dateKey,
    programmes: [],
    matchedSource: null,
    stale: false,
    errors: [],
  };
}

export const epgService = {
  /**
   * 拉取某频道某天的节目单（默认今天）。缓存命中不发请求；失败返回 []。
   * `endpoint` 缺省用 `EPG_DEFAULT_ENDPOINT`（diyp 风格）。
   *
   * EXT-06：改为单源兼容封装（不落 `epgSources`、不参与多源合并），
   * 签名与返回类型保持不变（AC-170 回归门禁）。
   */
  async programmes(
    channel: string,
    date: Date = new Date(),
    endpoint: string = EPG_DEFAULT_ENDPOINT,
  ): Promise<EpgProgramme[]> {
    const dateKey = localDateKey(date);
    const channelKey = channelKeyOf({ name: channel });
    const cacheKey = `${EPG_CACHE_KEY_PREFIX}:builtin:${channelKey}:${dateKey}`;
    const cached = await cacheRepo.getEpgRecord(cacheKey);
    if (cached && cached.programmes.length > 0) return cached.programmes;

    const source: EpgSource = {
      id: BUILTIN_EPG_SOURCE_ID,
      name: '内置默认源',
      endpoint,
      protocol: 'auto',
      matchMode: 'auto',
      priority: 1,
      enabled: true,
      builtin: true,
      lastProbeAt: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    };
    try {
      const fetched = await requestProgrammes(
        source,
        { name: channel, tvgId: null, tvgName: null },
        dateKey,
      );
      if (fetched.programmes.length > 0) {
        await cacheRepo.putEpgRecord({
          key: cacheKey,
          programmes: fetched.programmes,
          fetchedAt: Date.now(),
          matchLevel: fetched.level,
        });
      }
      return fetched.programmes;
    } catch (e) {
      logger.debug('EPG 拉取失败（不影响播放）', channel, e);
      return [];
    }
  },

  /**
   * FR-67 核心：按优先级合并多源，整源采纳（不做节目级拼接）。
   * 命中即返回，后续源不再请求；全部未命中 → 空数组且不抛错。
   */
  async programmesFor(
    channel: EpgChannelRef,
    date: Date = new Date(),
    options?: { sourceIds?: string[]; allowStale?: boolean },
  ): Promise<ChannelEpgResult> {
    const dateKey = localDateKey(date);
    const channelKey = channelKeyOf(channel);
    // REV-19：键纳入 sourceIds / allowStale，避免不同查询条件误共享同一 in-flight 结果
    const inflightKey = `${channelKey}:${dateKey}:${(options?.sourceIds ?? [])
      .slice()
      .sort()
      .join(',')}:${options?.allowStale !== false}`;
    const running = mergedInFlight.get(inflightKey);
    if (running) return running;

    const task = epgService.runMerge(channel, dateKey, options);
    mergedInFlight.set(inflightKey, task);
    task.finally(() => mergedInFlight.delete(inflightKey)).catch(() => undefined);
    return task;
  },

  /** `programmesFor` 的合并流程本体（拆出便于 in-flight 包装与单测） */
  async runMerge(
    channel: EpgChannelRef,
    dateKey: string,
    options?: { sourceIds?: string[]; allowStale?: boolean },
  ): Promise<ChannelEpgResult> {
    const channelKey = channelKeyOf(channel);
    let sources: EpgSource[] = [];
    try {
      sources = await epgSourceService.list();
    } catch (error) {
      logger.warn('读取 EPG 源失败', error);
    }
    if (options?.sourceIds?.length) {
      const wanted = new Set(options.sourceIds);
      sources = sources.filter((source) => wanted.has(source.id));
    }
    const enabled = sources
      .filter((source) => source.enabled)
      .sort((a, b) => a.priority - b.priority);
    const result = emptyResult(channel, channelKey, dateKey);
    if (enabled.length === 0) return result;

    for (const source of enabled) {
      // REV-17：失败退避期内直接跳过（不再每轮都等一次超时）
      const until = failedUntil.get(source.id) ?? 0;
      if (until > Date.now()) {
        logger.debug('EPG 源处于失败退避期，跳过', { sourceId: source.id, until });
        continue;
      }
      try {
        const fetched = await fetchFromSource(source, channel, dateKey, {
          allowStale: options?.allowStale,
        });
        failedUntil.delete(source.id);
        if (fetched.programmes.length > 0) {
          result.programmes = fetched.programmes;
          result.matchedSource = { id: source.id, name: source.name, matchLevel: fetched.level };
          result.stale = fetched.stale;
          return result;
        }
      } catch (error) {
        failedUntil.set(source.id, Date.now() + EPG_SOURCE_BACKOFF_MS);
        const appError = toAppError(error);
        result.errors.push({
          sourceId: source.id,
          code: appError.code,
          message: appError.message,
        });
        logger.debug('EPG 源拉取失败，尝试下一源', {
          sourceId: source.id,
          code: appError.code,
        });
      }
    }
    return result;
  },

  /** 预取（收藏 + 可见分组前 N 个，≤30；并发 ≤3；失败静默） */
  async prefetch(
    channels: EpgChannelRef[],
    date: Date = new Date(),
    limit: number = EPG_PREFETCH_MAX,
  ): Promise<{ requested: number; ok: number; failed: number; elapsedMs: number }> {
    const startedAt = Date.now();
    const max = Math.min(Math.max(1, limit), EPG_PREFETCH_MAX);
    const seen = new Set<string>();
    const queue: EpgChannelRef[] = [];
    for (const channel of channels) {
      const key = channelKeyOf(channel);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(channel);
      if (queue.length >= max) break;
    }

    let ok = 0;
    let failed = 0;
    const workers = Array.from(
      { length: Math.min(EPG_MERGE_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          try {
            const merged = await epgService.programmesFor(next, date);
            if (merged.programmes.length > 0) ok += 1;
            else failed += 1;
          } catch (error) {
            failed += 1;
            logger.debug('EPG 预取失败（静默）', { channel: next.name, error });
          }
        }
      },
    );
    await Promise.all(workers);
    return { requested: seen.size, ok, failed, elapsedMs: Date.now() - startedAt };
  },

  /** 清除某源全部缓存（删除源 / 改协议 / 改匹配模式时调用），返回删除条数 */
  async clearSourceCache(sourceId: string): Promise<number> {
    let removed = await cacheRepo.deleteEpgByPrefix(`${EPG_CACHE_KEY_PREFIX}:${sourceId}:`);
    if (sourceId === BUILTIN_EPG_SOURCE_ID) {
      // 兼容封装的键空间（`epgv2:builtin:`）一并清理
      removed += await cacheRepo.deleteEpgByPrefix(`${EPG_CACHE_KEY_PREFIX}:builtin:`);
    }
    return removed;
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

/** 测试辅助：清空 in-flight 表、失败退避表与并发闸门 */
export function resetEpgInFlightForTest(): void {
  mergedInFlight.clear();
  failedUntil.clear();
  epgSlotWaiters.length = 0;
  epgActiveRequests = 0;
}
