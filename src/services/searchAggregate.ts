/**
 * 跨源聚合检索（v1.7 / CHG-20，纯函数无 IO）
 *
 * 现状问题：远程检索逐源流式追加，同一部片在每个源各出一条（`item.id` 含 sourceId，
 * 去重等于没去），用户要在几十条重复卡片里自己辨认「同一部片」。
 *
 * 本模块把结果按「归一化片名 + 年份」归并成组：
 * - 归一化复用豆瓣借播的既有口径（`stripTitleNoise`：去季/部/清晰度/年份后缀、全半角、繁简不区分）；
 * - 组内按 源健康 tier → 延迟 → sort 排序（与 `pickPlayCandidates` 同一口径）；
 * - 相关度排序：包含 > 前缀 > 分词包含 > 其它。
 */
import type { MediaItem, SearchResultGroup, SourceHealth } from '@/types';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';
import { normalizeTitleForMatch, stripTitleNoise } from '@/sources/douban/playMatch';

/** 组键：归一化根标题 + 年份（缺失为 unknown） */
function groupKeyOf(title: string, year: number | null): string {
  const root = stripTitleNoise(title) || normalizeTitleForMatch(title) || title.trim().toLowerCase();
  return `${root}:${year ?? 'unknown'}`;
}

/** 组内条目排序：健康 tier → 延迟 → 保持到达顺序 */
function sortGroupItems(
  items: MediaItem[],
  healthOf: (sourceId: string) => SourceHealth,
  latencyOf: (sourceId: string) => number | null,
): MediaItem[] {
  if (items.length <= 1) return [...items];
  return [...items].sort((a, b) => {
    const tierA = HEALTH_TIER_ORDER[healthTierOf(healthOf(a.sourceId), latencyOf(a.sourceId))];
    const tierB = HEALTH_TIER_ORDER[healthTierOf(healthOf(b.sourceId), latencyOf(b.sourceId))];
    if (tierA !== tierB) return tierA - tierB;
    const latencyA = latencyOf(a.sourceId);
    const latencyB = latencyOf(b.sourceId);
    const rankA = latencyA === null || !Number.isFinite(latencyA) ? Number.POSITIVE_INFINITY : latencyA;
    const rankB = latencyB === null || !Number.isFinite(latencyB) ? Number.POSITIVE_INFINITY : latencyB;
    if (rankA !== rankB) return rankA - rankB;
    return 0; // 保持原始到达顺序（sort 稳定）
  });
}

/**
 * 按组展示时的组间排序（v1.8 修订）：
 * **相关度 → 组内最优 tier → 最优延迟 → 组大小 → 首次出现顺序**。
 *
 * v1.7 把 tier 放在首位，实测产生「垃圾健康源霸屏」：采集站对任意关键词返回
 * 固定站内内容（如「找新影视片 001~N」），其源健康 tier 好，把唯一精确匹配
 * 的组（未体检源 tier=unknown）挤到列表尾部。搜索场景用户的意图是找片——
 * 相关度必须是第一优先级，健康度只在同等相关度时决定谁先（AC-121 口径修订）。
 */
export function groupSearchResults(
  items: MediaItem[],
  keyword: string,
  healthOf: (sourceId: string) => SourceHealth = () => 'unknown',
  latencyOf: (sourceId: string) => number | null = () => null,
): SearchResultGroup[] {
  const groups = new Map<string, { key: string; title: string; year: number | null; items: MediaItem[]; order: number }>();
  let order = 0;
  for (const item of items) {
    const key = groupKeyOf(item.title, item.year);
    const found = groups.get(key);
    if (found) {
      found.items.push(item);
    } else {
      groups.set(key, { key, title: item.title, year: item.year, items: [item], order: order++ });
    }
  }

  const list = [...groups.values()].map((group) => ({
    key: group.key,
    title: group.title,
    year: group.year,
    items: sortGroupItems(group.items, healthOf, latencyOf),
    order: group.order,
  }));

  const rankOf = (group: (typeof list)[number]): [number, number, number, number] => {
    const best = group.items[0];
    const tier = best
      ? HEALTH_TIER_ORDER[healthTierOf(healthOf(best.sourceId), latencyOf(best.sourceId))]
      : HEALTH_TIER_ORDER.unknown;
    const latency = best ? latencyOf(best.sourceId) : null;
    const latencyRank = latency === null || !Number.isFinite(latency) ? Number.POSITIVE_INFINITY : latency;
    // 相关度第一（越大越靠前取负）；同相关度时健康 tier / 延迟 / 来源数做次级排序
    return [-scoreRelevance(group.title, keyword), tier, latencyRank, -group.items.length];
  };

  return list
    .sort((a, b) => {
      const [tierA, latA, sizeA, relA] = rankOf(a);
      const [tierB, latB, sizeB, relB] = rankOf(b);
      if (tierA !== tierB) return tierA - tierB;
      if (latA !== latB) return latA - latB;
      if (sizeA !== sizeB) return sizeA - sizeB;
      if (relA !== relB) return relA - relB;
      return a.order - b.order;
    })
    .map(({ key, title, year, items: groupItems }) => ({ key, title, year, items: groupItems }));
}

/**
 * 相关度打分（v1.7/AC-121）：包含(4) > 前缀(3) > 分词包含(2) > 其它(0)。
 * 关键词空格分词 AND 命中才给分词分；空关键词返回 0。
 */
export function scoreRelevance(title: string, keyword: string): number {
  const t = normalizeTitleForMatch(title);
  const k = normalizeTitleForMatch(keyword);
  if (t.length === 0 || k.length === 0) return 0;
  if (t === k) return 4;
  if (t.includes(k)) return t.startsWith(k) ? 4 : 3;
  // 分词：空格分隔，全部命中才计分
  const words = keyword.trim().split(/\s+/).map((w) => normalizeTitleForMatch(w)).filter((w) => w.length > 0);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 2;
  return 0;
}

/** 按相关度降序稳定排序（同分保持到达顺序） */
export function sortByRelevance(items: MediaItem[], keyword: string): MediaItem[] {
  if (items.length <= 1) return [...items];
  return [...items]
    .map((item, index) => ({ item, index, score: scoreRelevance(item.title, keyword) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((entry) => entry.item);
}

/**
 * 平铺视图的去重键：片名（去空白、小写）+ 年份（CHG-28 修订）。
 * 原实现只按片名，同名不同年的片（如《三体》2008 / 2023 剧集版）会被误并成一条，
 * 与聚合视图的 `groupKeyOf`（片名+年份）口径不一致。
 */
export function titleDedupKey(title: string, year: number | null): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, '');
  return `${normalized}:${year ?? 'unknown'}`;
}
