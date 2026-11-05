/**
 * 直播服务（CHG-13）
 *
 * 职责：直播播放列表（`LiveRecord`）的增删查 + 频道拉取解析（带 5min 内存缓存）。
 * 频道不落库：直播源更新频繁，每次进页拉最新，解析失败回落上一次缓存。
 * 频道播放复用现有 PlayerController / HlsEngine（直播 m3u8 天然适配），
 * 不写历史与进度（v1 口径）。
 */
import { liveRepo } from '@/db/repositories/liveRepo';
import { AppError } from '@/shared/errors';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { newId } from '@/shared/id';
import { httpClient } from '@/sources/base/httpClient';
import {
  detectLiveFormat,
  groupChannels,
  parseLiveList,
  type LiveChannel,
} from '@/sources/live/liveParsers';
import type { LiveGroup, LiveListFormat, LiveRecord } from '@/types';

const CHANNELS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  channels: LiveChannel[];
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
  },

  /**
   * 按订阅 ID 删除全部关联直播源（功能扩展-2：直播源纳入订阅生命周期）
   * 返回删除数量
   */
  async removeBySubscription(subscriptionId: string): Promise<number> {
    const removed = await liveRepo.removeBySubscription(subscriptionId);
    if (removed > 0) {
      // 清缓存：删除的直播源可能还在缓存中
      channelsCache.clear();
    }
    return removed;
  },

  /** 拉取并解析频道（5min 缓存）；失败时回落上一次成功缓存，缓存也没有才抛错 */
  async channelsOf(record: LiveRecord, opts?: { refresh?: boolean; signal?: AbortSignal }): Promise<LiveGroup[]> {
    const cached = channelsCache.get(record.id);
    if (!opts?.refresh && cached && Date.now() - cached.fetchedAt < CHANNELS_CACHE_TTL_MS) {
      return groupChannels(cached.channels);
    }
    try {
      const text = await fetchListText(record.url, opts?.signal);
      const channels = parseLiveList(text);
      if (channels.length === 0) throw new AppError('E_PARSE', '未解析出任何频道');
      channelsCache.set(record.id, { channels, fetchedAt: Date.now() });
      if (record.channelCount !== channels.length) {
        await liveRepo.save({ ...record, channelCount: channels.length, updatedAt: Date.now() });
      }
      return groupChannels(channels);
    } catch (e) {
      if (cached) {
        return groupChannels(cached.channels);
      }
      throw e;
    }
  },

  /**
   * 批量添加 TVBox `lives[]` 提取出的直播源（CHG-13；已存在同 URL 的跳过）。
   * 返回新增数量；供订阅导入成功后调用（单个失败不阻塞其它）。
   */
  async addTvboxLives(
    lives: Array<{ name: string; url: string }>,
    subscriptionId?: string | null,
  ): Promise<number> {
    let added = 0;
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
      } catch {
        // 单个直播源拉取失败不阻塞其它（导入订阅是主流程）
      }
    }
    return added;
  },
};

/** 测试辅助：清空频道缓存 */
export function resetLiveCacheForTest(): void {
  resetChannelsCache();
}
