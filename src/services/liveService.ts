/**
 * 直播服务（CHG-13）
 *
 * 职责：直播播放列表（`LiveRecord`）的增删查 + 频道拉取解析（带 5min 内存缓存）。
 * 频道不落库：直播源更新频繁，每次进页拉最新，解析失败回落上一次缓存。
 * 频道播放复用现有 PlayerController / HlsEngine（直播 m3u8 天然适配），
 * 不写历史与进度（v1 口径）。
 */
import { liveRepo } from '@/db/repositories/liveRepo';
import { channelPrefsRepo } from '@/db/repositories/channelPrefsRepo';
import { reminderService } from '@/services/reminderService';
import { replayService } from '@/services/replayService';
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { clampCatchupDays, validateCatchupTemplate } from '@/shared/catchupTemplate';
import { normalizeChannelName } from '@/shared/channelKey';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { newId } from '@/shared/id';
import { httpClient } from '@/sources/base/httpClient';
import {
  detectLiveFormat,
  groupChannels,
  parseLiveList,
  type LiveChannel,
} from '@/sources/live/liveParsers';
import { parseLiveExtras } from '@/sources/live/liveExtras';
import type {
  LiveCatchupSettings,
  LiveChannelExtrasMap,
  LiveGroup,
  LiveListFormat,
  LiveRecord,
} from '@/types';

const CHANNELS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  channels: LiveChannel[];
  /** EXT-06：以频道 URL 为键的旁路属性（tvg-id / catchup-*） */
  extras: LiveChannelExtrasMap;
  fetchedAt: number;
}

const channelsCache = new Map<string, CacheEntry>();

function resetChannelsCache(): void {
  channelsCache.clear();
}

async function fetchListText(url: string, signal?: AbortSignal): Promise<string> {
  const { value: text } = await withGithubMirrorFallback(
    url,
    (variantUrl) =>
      httpClient.request(variantUrl, {
        method: 'GET',
        responseType: 'text',
        timeoutMs: 10_000,
        retries: 1,
        signal,
      }),
    signal,
  );
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new AppError('E_PARSE', '直播列表内容为空');
  }
  return text;
}

/** 频道拉取（5min 缓存 + 失败回落）：`channelsOf` / `channelsWithExtrasOf` 共用 */
async function loadChannels(
  record: LiveRecord,
  opts?: { refresh?: boolean; signal?: AbortSignal },
): Promise<{ channels: LiveChannel[]; extras: LiveChannelExtrasMap }> {
  const cached = channelsCache.get(record.id);
  if (!opts?.refresh && cached && Date.now() - cached.fetchedAt < CHANNELS_CACHE_TTL_MS) {
    return { channels: cached.channels, extras: cached.extras };
  }
  try {
    const text = await fetchListText(record.url, opts?.signal);
    const channels = parseLiveList(text);
    if (channels.length === 0) throw new AppError('E_PARSE', '未解析出任何频道');
    // EXT-06：旁路解析 tvg-id / catchup-*（不改动 parseM3u 的取值规则）
    const extras = parseLiveExtras(text);
    channelsCache.set(record.id, { channels, extras, fetchedAt: Date.now() });
    if (record.channelCount !== channels.length) {
      await liveRepo.save({ ...record, channelCount: channels.length, updatedAt: Date.now() });
    }
    return { channels, extras };
  } catch (e) {
    if (cached) return { channels: cached.channels, extras: cached.extras };
    throw e;
  }
}

export const liveService = {
  list(): Promise<LiveRecord[]> {
    return liveRepo.list();
  },

  /** 新增播放列表：立即拉取一次验证可解析，频道数随记录落库 */
  async add(input: {
    name: string;
    url: string;
    format?: LiveListFormat;
    subscriptionId?: string | null;
    signal?: AbortSignal;
  }): Promise<LiveRecord> {
    const url = input.url.trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new AppError('E_INVALID_INPUT', '直播地址必须是 http(s):// 开头');
    }
    if (input.name.trim().length === 0) {
      throw new AppError('E_INVALID_INPUT', '请填写直播源名称');
    }
    const existing = await liveRepo.getByUrl(url);
    if (existing) throw new AppError('E_INVALID_INPUT', '该直播地址已存在');

    const text = await fetchListText(url, input.signal);
    const channels = parseLiveList(text);
    if (channels.length === 0) {
      throw new AppError('E_PARSE', '无法从该地址解析出任何频道（支持 m3u 与 TVBox txt 格式）');
    }

    const now = Date.now();
    const record: LiveRecord = {
      id: newId(),
      name: input.name.trim(),
      url,
      format: input.format ?? (detectLiveFormat(text) ?? 'auto'),
      channelCount: channels.length,
      subscriptionId: input.subscriptionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await liveRepo.save(record);
    resetChannelsCache();
    return record;
  },

  async remove(id: string): Promise<void> {
    await liveRepo.remove(id);
    channelsCache.delete(id);
    // EXT-06：直播源删除时级联清理分组/排序与提醒（加法调用）
    await Promise.all([
      channelPrefsRepo.remove(id).catch(() => undefined),
      reminderService.cancelBySource(id).catch(() => undefined),
      replayService.invalidateSourceCapabilities(id).catch(() => undefined),
    ]);
  },

  /**
   * EXT-06/FR-68（P1-01）：写入或清除直播源级回看设置。
   * - 模板走 `validateCatchupTemplate`（未知占位符 → `E_INVALID_INPUT` 并附合法占位符清单）；
   * - 天数经 `clampCatchupDays` 收敛到 1~`CATCHUP_MAX_DAYS`；
   * - 变更后清该源的 `live-catchup-probes` 探测缓存，让节目单重新探测；
   * - `input = null` 表示清除设置（回到"仅 m3u catchup-source"）。
   */
  async updateCatchup(
    id: string,
    input: { enabled: boolean; template: string; days: number } | null,
  ): Promise<LiveRecord> {
    const record = await liveRepo.get(id);
    if (!record) throw new AppError('E_NOT_FOUND', '直播源不存在');
    let catchup: LiveCatchupSettings | undefined;
    if (input) {
      const template = (input.template ?? '').trim();
      const invalid = validateCatchupTemplate(template);
      if (invalid) throw new AppError('E_INVALID_INPUT', invalid);
      catchup = {
        enabled: input.enabled !== false,
        template,
        days: clampCatchupDays(input.days),
      };
    }
    const next: LiveRecord = { ...record, catchup, updatedAt: Date.now() };
    await liveRepo.save(next);
    await replayService.invalidateSourceCapabilities(id).catch(() => undefined);
    return next;
  },

  /**
   * 按订阅 ID 删除全部关联直播源（功能扩展-2：直播源纳入订阅生命周期）
   * 返回删除数量
   */
  async removeBySubscription(subscriptionId: string): Promise<number> {
    // EXT-06：先取出将被删除的源 id，用于级联清理分组/排序与提醒
    const doomed = (await liveRepo.list()).filter(
      (record) => record.subscriptionId === subscriptionId,
    );
    const removed = await liveRepo.removeBySubscription(subscriptionId);
    if (removed > 0) {
      // 清缓存：删除的直播源可能还在缓存中
      channelsCache.clear();
      for (const record of doomed) {
        channelsCache.delete(record.id);
        await channelPrefsRepo.remove(record.id).catch(() => undefined);
        await reminderService.cancelBySource(record.id).catch(() => undefined);
      }
    }
    return removed;
  },

  /** 拉取并解析频道（5min 缓存）；失败时回落上一次成功缓存，缓存也没有才抛错 */
  async channelsOf(record: LiveRecord, opts?: { refresh?: boolean; signal?: AbortSignal }): Promise<LiveGroup[]> {
    const loaded = await loadChannels(record, opts);
    return groupChannels(loaded.channels);
  },

  /**
   * EXT-06/FR-67：频道 + 旁路属性（tvg-id / catchup-*）一次返回。
   * 与 `channelsOf` 共用 5min 缓存与失败回落语义（AC-124 口径不变）。
   */
  async channelsWithExtrasOf(
    record: LiveRecord,
    opts?: { refresh?: boolean; signal?: AbortSignal },
  ): Promise<{ groups: LiveGroup[]; channels: LiveChannel[]; extras: LiveChannelExtrasMap }> {
    const loaded = await loadChannels(record, opts);
    return {
      groups: groupChannels(loaded.channels),
      channels: loaded.channels,
      extras: loaded.extras,
    };
  },

  /**
   * 按频道名反查直播源 id（仅查 5min 内存缓存，不发网络请求）。
   * 供节目单页在缺少 `source` 查询参数时定位回看/提醒的归属源。
   */
  findSourceIdByChannelName(name: string): string | null {
    const target = normalizeChannelName(name);
    if (!target) return null;
    for (const [sourceId, entry] of channelsCache) {
      if (entry.channels.some((channel) => normalizeChannelName(channel.name) === target)) {
        return sourceId;
      }
    }
    return null;
  },

  /**
   * 批量添加 TVBox `lives[]` 提取出的直播源（CHG-13；已存在同 URL 的跳过）。
   * 返回新增/失败数；供订阅导入成功后调用（单个失败不阻塞其它，但必须让调用方看得见）。
   */
  async addTvboxLives(
    lives: Array<{ name: string; url: string }>,
    subscriptionId?: string | null,
  ): Promise<{ added: number; failed: number }> {
    let added = 0;
    let failed = 0;
    for (const live of lives) {
      const existing = await liveRepo.getByUrl(live.url);
      if (existing) continue;
      try {
        await liveService.add({
          name: live.name,
          url: live.url,
          format: 'txt',
          subscriptionId: subscriptionId ?? null,
        });
        added += 1;
      } catch (e) {
        // 单个直播源写入失败不阻塞其它（导入订阅是主流程），但要计入 failed
        failed += 1;
        logger.warn('添加 TVBox 直播源失败', live.url, e);
      }
    }
    return { added, failed };
  },
};

/** 测试辅助：清空频道缓存 */
export function resetLiveCacheForTest(): void {
  resetChannelsCache();
}
