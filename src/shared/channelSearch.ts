/**
 * 直播频道搜索（C2）
 *
 * 复用 `normalizeChannelName` 的归一化口径，于是「cctv 1」「CCTV-1 高清」「cctv1综合」
 * 都能命中同一路频道——直播源的命名习惯千奇百怪，逐字符比对等于搜不到。
 *
 * 但归一化会剥掉「高清/综合」这类后缀，用户偏偏可能就想搜这两个词，
 * 所以同时保留一份只去分隔符的宽松名，两者任一命中即算命中。
 *
 * 排序按相关性分档，档内保持源顺序（稳定）：
 * 全等 > 前缀 > 名称包含 > 仅分组命中。
 */
import { normalizeChannelName } from '@/shared/channelKey';

const SEPARATORS = /[\s\u3000\-_·.,:;!?/\\|"'`()[\]{}<>~@#$%^&*+=]+/g;

export interface SearchableChannel {
  name: string;
  group: string;
}

function loose(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(SEPARATORS, '');
}

/** 相关性档位；null = 不命中 */
function tierOf(channel: SearchableChannel, query: string, looseQuery: string): number | null {
  const name = normalizeChannelName(channel.name);
  const looseName = loose(channel.name);
  if (name === query || looseName === looseQuery) return 0;
  if (name.startsWith(query) || looseName.startsWith(looseQuery)) return 1;
  if (name.includes(query) || looseName.includes(looseQuery)) return 2;
  if (loose(channel.group).includes(looseQuery)) return 3;
  return null;
}

/** 跨分组过滤 + 相关性排序。空查询原样返回（调用方据此走正常分组视图） */
export function filterChannelsByQuery<T extends SearchableChannel>(channels: T[], query: string): T[] {
  const looseQuery = loose(query);
  // 纯分隔符查询归一化后为空串，`includes('')` 会把整份列表判成命中
  if (!looseQuery) return channels.slice();
  const normalized = normalizeChannelName(query) || looseQuery;

  const hits: Array<{ channel: T; tier: number; index: number }> = [];
  channels.forEach((channel, index) => {
    const tier = tierOf(channel, normalized, looseQuery);
    if (tier !== null) hits.push({ channel, tier, index });
  });

  hits.sort((a, b) => (a.tier === b.tier ? a.index - b.index : a.tier - b.tier));
  return hits.map((hit) => hit.channel);
}