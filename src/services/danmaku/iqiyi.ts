/**
 * 爱奇艺直连弹幕源（无凭证）
 *
 * 链路：搜索取专辑号 qipuId → avlistinfo 分集取本集 tvId 与时长 → cmts 弹幕分片（Brotli 压缩）。
 * 爱奇艺独播剧（狂飙/莲花楼等）此前只能落到 dandanplay，由本源补齐。
 *
 * 分片地址自带校验位：`md5(`${tvid}_60_${页号}${SALT}`)` 取末 8 位，目录位取 tvid 末 4/末 2 位；
 * 解压后按首字节分流——`<` 是旧版 XML，否则是 protobuf（两者时间字段都是相对视频起点的秒）。
 */
import { decompress } from 'brotli';

import { md5 } from './md5';
import { requestBytes, requestWithHeaders } from './nativeHttp';
import { episodeNumberOf, fetchInBatches, parseDurationSec } from './segments';
import { pickCandidate, titleMatchScore, type Scored } from './titlePick';
import type { DanmakuComment } from '@/types';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const SEARCH_URL = 'https://mesh.if.iqiyi.com/portal/lw/search/homePageV3';
const EPISODES_URL = 'https://pcw-api.iqiyi.com/albums/album/avlistinfo';
const BULLET_URL = 'https://cmts.iqiyi.com/bullet';

/** 分片签名的固定后缀（爱奇艺前端常量） */
const BULLET_SALT = 'cbzuw1259a';
const SEGMENT_STEP_SEC = 60;
const EPISODE_PAGE_SIZE = 30;
const MAX_EPISODE_PAGES = 10;
/** 低于此时长的分集按预告/花絮处理 */
const MIN_FEATURE_LENGTH_SEC = 300;

const IQIYI_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.iqiyi.com/',
};

interface IqiyiAlbum {
  title?: string;
  qipuId?: string | number;
  playQipuId?: string | number;
  channel?: string;
  year?: { key?: string; value?: string } | string;
}

interface IqiyiSearchResponse {
  code?: string | number;
  data?: {
    templates?: Array<{
      template?: number;
      albumInfo?: IqiyiAlbum;
      intentAlbumInfos?: IqiyiAlbum[];
    }>;
  };
}

interface IqiyiEpisode {
  order?: number | string;
  tvId?: string | number;
  duration?: string;
  name?: string;
}

interface IqiyiEpisodesResponse {
  code?: string;
  data?: { total?: number; epsodelist?: IqiyiEpisode[] };
}

/** `year` 既可能是 `{value:'2023'}` 也可能是纯文本 */
function yearOf(album: IqiyiAlbum): number | null {
  const raw = typeof album.year === 'string' ? album.year : album.year?.value;
  const match = /(19|20)\d{2}/.exec(raw ?? '');
  return match ? Number(match[0]) : null;
}

/** 综艺/纪录类不参与（按期数编排，集号语义与播放器不一致）；剧集/电影/动漫参与 */
function isEpisodeNumbered(album: IqiyiAlbum): boolean {
  const channel = album.channel ?? '';
  if (channel.length === 0) return true;
  if (channel.includes('电影') || channel.includes('电视剧') || channel.includes('动漫')) return true;
  return false;
}

interface AlbumHit {
  albumId: string;
  title: string;
}

function toHit(album: IqiyiAlbum | undefined): AlbumHit | null {
  const id = album?.qipuId ?? album?.playQipuId;
  if (album === undefined || id === undefined) return null;
  return { albumId: String(id), title: (album.title ?? '').replace(/<[^>]*>/g, '').trim() };
}

function pickAlbum(albums: IqiyiAlbum[], query: DanmakuQuery): AlbumHit | null {
  const candidates: Array<AlbumHit & Scored> = [];
  for (const album of albums) {
    if (!isEpisodeNumbered(album)) continue;
    const hit = toHit(album);
    if (hit === null) continue;
    candidates.push({ ...hit, score: titleMatchScore(hit.title, query.title), year: yearOf(album) });
  }
  // 片名精确度优先于年份：爱奇艺的搜后卡片同名不同年很多，让年份越级就会串到另一季
  const chosen = pickCandidate(candidates, query.year);
  return chosen === null ? null : { albumId: chosen.albumId, title: chosen.title };
}

/** 搜索接口被风控时 code 为 -1；空结果不是错误，返回 null 由调用方回退下一源 */
async function searchAlbum(query: DanmakuQuery): Promise<AlbumHit | null> {
  const params = new URLSearchParams({
    key: query.searchTitle ?? query.title,
    current_page: '1',
    mode: '1',
    source: 'input',
    pageNum: '1',
    pageSize: '20',
    scale: '100',
    vipType: '-1',
    osShortName: 'win10',
  });
  const url = `${SEARCH_URL}?${params.toString()}`;
  const request = () =>
    requestWithHeaders<IqiyiSearchResponse>(url, {
      headers: IQIYI_HEADERS,
      responseType: 'json',
      timeoutMs: 8000,
      retries: 0,
      signal: query.signal,
    });

  let response = await request();
  if (String(response.code) === '-1') {
    // 风控是瞬时的，退避一次再放弃，避免整集直接掉到下一级回退
    await new Promise((resolve) => setTimeout(resolve, 1200));
    response = await request();
    if (String(response.code) === '-1') return null;
  }
  const albums: IqiyiAlbum[] = [];
  for (const template of response.data?.templates ?? []) {
    if (template.albumInfo) albums.push(template.albumInfo);
    albums.push(...(template.intentAlbumInfos ?? []));
  }
  return pickAlbum(albums, query);
}

/** 分集列表：接口每页 30 条，按 `total` 或目标集号提前收敛 */
async function fetchEpisode(
  albumId: string,
  episode: number,
  signal?: AbortSignal,
): Promise<IqiyiEpisode | null> {
  const seen: IqiyiEpisode[] = [];
  for (let page = 1; page <= MAX_EPISODE_PAGES; page += 1) {
    const response = await requestWithHeaders<IqiyiEpisodesResponse>(
      `${EPISODES_URL}?aid=${encodeURIComponent(albumId)}&page=${page}&pagesize=${EPISODE_PAGE_SIZE}`,
      { headers: IQIYI_HEADERS, responseType: 'json', timeoutMs: 8000, retries: 0, signal },
    );
    const list = response.data?.epsodelist ?? [];
    if (list.length === 0) break;
    seen.push(...list);
    const target = seen.filter((item) => episodeNumberOf(item.order) === episode);
    if (target.length > 0) return longest(target);
    const total = Number(response.data?.total ?? 0);
    if (total > 0 && seen.length >= total) break;
  }
  return null;
}

/** 同集号并存正片与预告时按时长取最长 */
function longest(items: IqiyiEpisode[]): IqiyiEpisode | null {
  let chosen: IqiyiEpisode | null = null;
  let bestSec = -1;
  for (const item of items) {
    const sec = parseDurationSec(item.duration) ?? 0;
    if (sec > bestSec) {
      bestSec = sec;
      chosen = item;
    }
  }
  return bestSec >= MIN_FEATURE_LENGTH_SEC ? chosen : null;
}

/** tvid 末 4 位的前两位 / 末 2 位构成 CDN 目录；前面补零保证短 id 也有两位目录 */
function bulletUrl(tvid: string, page: number): string {
  const padded = `0000${tvid}`;
  const dir = `${padded.slice(-4, -2)}/${padded.slice(-2)}`;
  const sign = md5(`${tvid}_${SEGMENT_STEP_SEC}_${page}${BULLET_SALT}`).slice(-8);
  return `${BULLET_URL}/${dir}/${tvid}_${SEGMENT_STEP_SEC}_${page}_${sign}.br`;
}

/* ---------- 分片负载解析 ---------- */

/** 旧版分片是 XML：`<danmu><p><showTime>12.3</showTime><content>文本</content><color>...</color>` */
function parseXmlPayload(text: string): DanmakuComment[] {
  const out: DanmakuComment[] = [];
  for (const block of text.match(/<p>[\s\S]*?<\/p>/g) ?? []) {
    const content = /<content>([\s\S]*?)<\/content>/.exec(block)?.[1] ?? '';
    const showTime = Number(/<showTime>([\s\S]*?)<\/showTime>/.exec(block)?.[1]);
    const hex = /<color>([\s\S]*?)<\/color>/.exec(block)?.[1] ?? '';
    const text2 = decodeEntities(content).trim();
    if (text2.length === 0) continue;
    if (!Number.isFinite(showTime) || showTime < 0) continue;
    out.push({ time: showTime, mode: 'scroll', color: colorOf(hex), text: text2 });
  }
  return out;
}

/** 颜色字段可能是 `ffffff` / `#ffffff` / 十进制 */
function colorOf(raw: string): number {
  const value = raw.trim();
  if (/^#?[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.replace('#', ''), 16);
  const decimal = Number(value);
  return Number.isFinite(decimal) && decimal > 0 ? decimal : 0xffffff;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** protobuf 只读解析：只需 varint 与长度分隔两种 wire type */
interface ProtoField {
  number: number;
  wireType: number;
  value: string;
  bytes: Uint8Array | null;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor] ?? 0;
    cursor += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, next: cursor };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function readFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const key = readVarint(bytes, cursor);
    if (key === null) break;
    cursor = key.next;
    const number = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (number === 0) break;
    if (wireType === 0) {
      const value = readVarint(bytes, cursor);
      if (value === null) break;
      cursor = value.next;
      fields.push({ number, wireType, value: String(value.value), bytes: null });
    } else if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (length === null) break;
      cursor = length.next;
      const end = cursor + length.value;
      if (end > bytes.length) break;
      const raw = bytes.subarray(cursor, end);
      cursor = end;
      fields.push({ number, wireType, value: new TextDecoder().decode(raw), bytes: raw });
    } else if (wireType === 5) {
      cursor += 4;
    } else if (wireType === 1) {
      cursor += 8;
    } else {
      break;
    }
  }
  return fields;
}

function fieldValue(fields: ProtoField[], number: number): string {
  return fields.find((field) => field.number === number)?.value ?? '';
}

/**
 * 新版分片是 protobuf：顶层 field 6 是时间块，块内 field 1 是块起始秒，
 * field 2 是单条弹幕（field 2 文本、field 6 秒、field 8 颜色）。
 */
function parseProtoPayload(bytes: Uint8Array): DanmakuComment[] {
  const out: DanmakuComment[] = [];
  for (const block of readFields(bytes)) {
    if (block.number !== 6 || block.bytes === null) continue;
    const fields = readFields(block.bytes);
    const blockTime = Number(fieldValue(fields, 1));
    for (const item of fields) {
      if (item.number !== 2 || item.bytes === null) continue;
      const comment = readFields(item.bytes);
      const text = fieldValue(comment, 2).trim();
      if (text.length === 0) continue;
      const time = Number(fieldValue(comment, 6)) || (Number.isFinite(blockTime) ? blockTime : 0);
      if (!Number.isFinite(time) || time < 0) continue;
      out.push({ time, mode: 'scroll', color: colorOf(fieldValue(comment, 8)), text });
    }
  }
  return out;
}

export const iqiyiProvider: DanmakuProvider = {
  id: 'iqiyi',
  available: () => true,
  async match(query) {
    if (query.episode < 1) return null;
    const album = await searchAlbum(query);
    if (album === null) return null;

    const episode = await fetchEpisode(album.albumId, query.episode, query.signal);
    const tvid = episode?.tvId === undefined ? null : String(episode.tvId);
    const durationSec = parseDurationSec(episode?.duration);
    if (tvid === null || durationSec === null || !/^\d+$/.test(tvid)) return null;

    const pages: number[] = [];
    for (let page = 1; (page - 1) * SEGMENT_STEP_SEC < durationSec; page += 1) pages.push(page);

    const comments = await fetchInBatches(pages, async (page) => {
      const compressed = await requestBytes(bulletUrl(tvid, page), {
        headers: { ...IQIYI_HEADERS, Accept: 'application/octet-stream' },
        timeoutMs: 8000,
        retries: 0,
        signal: query.signal,
      });
      if (compressed.length === 0) return [];
      // 分片是静态 Brotli 文件，服务端不带 Content-Encoding，必须自行解压
      const payload = decompress(compressed);
      if (payload.length === 0) return [];
      return payload[0] === 0x3c ? parseXmlPayload(new TextDecoder().decode(payload)) : parseProtoPayload(payload);
    });
    if (comments.length === 0) return null;
    return { comments, matchedTitle: album.title.length > 0 ? album.title : null };
  },
};
