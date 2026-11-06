/**
 * 频道身份键的**唯一**入口（REV-13）
 *
 * 背景：`channelKeyOf` 的规则是「有 tvgId 用 `id:`，否则 `nm:`」。
 * 之前直播页 / 分组作用域只传 `{ name }`（恒 `nm:`），节目单页传 `{ name, tvgId }`，
 * 同一频道在两处得到不同 key，导致分组归属、排序项、提醒都对不上。
 *
 * 约定：任何从 `LiveChannel`（及其 m3u 旁路属性 `extras`）出发取身份键的地方，
 * 一律走本模块，不在各页面自行拼 `channelKeyOf({ name })`。
 */
import { channelKeyOf } from '@/shared/channelKey';
import type { EpgChannelRef, LiveChannelExtras } from '@/types';

/** 可推导身份键的最小输入（LiveChannel 直接满足） */
export interface ChannelIdentityInput {
  name: string;
  /** 显式 tvgId（优先于 extras 里的同名字段） */
  tvgId?: string | null;
  /** m3u 旁路属性（LiveView 内存表按 url 索引） */
  extras?: LiveChannelExtras | null;
}

/**
 * LiveChannel（+ extras）→ channelKey。
 * 与 `buildScopes` / 节目单页 / 提醒服务使用同一口径：`tvgId` 优先，其次名称归一化。
 */
export function channelKeyFromLive(channel: ChannelIdentityInput): string {
  const tvgId = channel.tvgId ?? channel.extras?.tvgId ?? null;
  return channelKeyOf({ name: channel.name, tvgId });
}

/** extras 映射表（`url → extras`）里没有对应项时的空值 */
export function emptyExtras(): LiveChannelExtras {
  return {
    tvgId: null,
    tvgName: null,
    catchupTemplate: null,
    catchupDays: null,
    catchupCorrectionSec: null,
  };
}

/** 取某 url 的 extras（缺失返回 null，调用方无需再判 undefined） */
export function extrasOfUrl(
  extras: Record<string, LiveChannelExtras> | null | undefined,
  url: string | null | undefined,
): LiveChannelExtras | null {
  if (!extras || !url) return null;
  return extras[url] ?? null;
}

/**
 * 频道引用（EPG 查询 / 回看 / 提醒共用）。
 * 所有字段都来自同一频道，避免「name 取自播放标题、tvgId 取自另一个同名频道」的错配。
 */
export function channelRefFromLive(
  channel: { name: string; url?: string },
  extras: Record<string, LiveChannelExtras> | null | undefined,
): EpgChannelRef {
  const extra = extrasOfUrl(extras, channel.url);
  return {
    name: channel.name,
    tvgId: extra?.tvgId ?? null,
    tvgName: extra?.tvgName ?? null,
    ...(channel.url ? { url: channel.url } : {}),
  };
}
