/**
 * 跨源聚合检索（v1.7 / CHG-20，纯函数无 IO）
 *
 * 现状问题：远程检索逐源流式追加，同一部片在每个源各出一条（`item.id` 含 sourceId，
 * 去重等于没去），用户要在几十条重复卡片里自己辨认「同一部片」。
 *
 * 本模块把结果按「归一化片名 + 年份」归并成组：
 * - 归一化复用豆瓣借播的既有口径（`stripTitleNoise`：去季/部/清晰度/年份后缀、全半角、繁简不区分）；
 * - 组内按 源健康 tier → 延迟 → sort 排序（与 `pickPlayCandidates` 同一口径）；
 * - 相关度排序：精确 > 前缀 > 包含 > 分词包含 > 其它（分值严格递减）。
 */
import type { AppErrorShape, MediaItem, SearchResultGroup, SourceHealth } from '@/types';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';
import { normalizeTitleForMatch, stripTitleNoise } from '@/sources/douban/playMatch';
import { classifySourceFailure, sanitizeSourceMessage } from '@/shared/sourceFailure';
import type { SourceFailureKind } from '@/shared/sourceFailure';

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
 * 相关度打分（v1.9/AC-121）：精确(4) > 前缀(3) > 包含(2) > 分词包含(1) > 无关(0)。
 * 四档严格递减：精确匹配必须压过前缀命中（旧实现两者同为 4，违反 AC-121）。
 * 关键词空格分词 AND 命中才给分词分；空关键词返回 0。
 */
export function scoreRelevance(title: string, keyword: string): number {
  const t = normalizeTitleForMatch(title);
  const k = normalizeTitleForMatch(keyword);
  if (t.length === 0 || k.length === 0) return 0;
  if (t === k) return 4; // 精确
  if (t.startsWith(k)) return 3; // 前缀（含关键词但更长的标题）
  if (t.includes(k)) return 2; // 包含（关键词落在标题中段）
  // 分词：空格分隔，全部命中才计分
  const words = keyword.trim().split(/\s+/).map((w) => normalizeTitleForMatch(w)).filter((w) => w.length > 0);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 1;
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

/* ---------- OPT-04：失败源汇总（结果页「失败源默认折叠」面板的数据来源） ---------- */

/**
 * 失败原因 → 搜索场景短标签。
 *
 * 分类口径唯一：`classifySourceFailure`（`shared/sourceFailure.ts`）；这里只换措辞——
 * 该模块的 `guidanceOf` 面向「播放失败」，搜索场景的 `unknown` 说「播放失败」会误导。
 */
/**
 * 失败原因短标签（面板「一句话原因」用）
 *
 * 与 `@/shared/sourceFailure` 的 `guidanceOf().title` 同一口径，只在措辞上
 * 压短到面板一行放得下（如「规则脚本异常（源站问题）」→「规则脚本异常」），
 * 不新增第二套分类。
 */
export const SEARCH_FAILURE_LABELS: Record<SourceFailureKind, string> = {
  source_dead: '源站已失效',
  timeout: '解析超时',
  protocol_unsupported: '格式不支持',
  rule_script: '规则脚本异常',
  source_internal: '源侧执行异常',
  auth: '需要登录',
  unknown: '原因未知',
};

/** 汇总里最多列几类原因（面板一行放得下；明细行仍逐源可查） */
export const SEARCH_FAILURE_REASON_LIMIT = 2;

/** 面板明细行（一源一行；`detail` 已收敛脚本内部异常） */
export interface SearchFailureRow {
  sourceId: string;
  kind: SourceFailureKind;
  label: string;
  detail: string;
}

export interface SearchFailureSummary {
  /** 失败源数（按 sourceId 去重） */
  total: number;
  rows: SearchFailureRow[];
  /** 原因聚类（count 降序，同数保持首次出现顺序） */
  reasons: Array<{ label: string; count: number }>;
  /** 一句话原因（如「33 源站已失效 · 5 规则脚本异常」）；无失败为空串 */
  text: string;
}

/** 失败源 id 列表（去重、保持首次出现顺序）：只重试这些源，不重查全部 */
export function failedSourceIds(
  failures: ReadonlyArray<{ sourceId: string; error: AppErrorShape }>,
): string[] {
  return [...new Set(failures.map((failure) => failure.sourceId))];
}

/**
 * 失败源汇总：按 sourceId 去重（同一源只算一次，保留最后一次错误），
 * 再按 `classifySourceFailure` 聚类成一句话。任何输入都不抛错。
 */
export function summarizeSearchFailures(
  failures: ReadonlyArray<{ sourceId: string; error: AppErrorShape }>,
  opts?: { reasonLimit?: number },
): SearchFailureSummary {
  const rowsBySource = new Map<string, SearchFailureRow>();
  for (const failure of failures) {
    const error = failure.error;
    const kind = classifySourceFailure(error);
    const detail = sanitizeSourceMessage(error?.detail || error?.message);
    rowsBySource.set(failure.sourceId, {
      sourceId: failure.sourceId,
      kind,
      label: SEARCH_FAILURE_LABELS[kind],
      detail,
    });
  }
  const rows = [...rowsBySource.values()];

  const counts = new Map<string, { label: string; count: number; order: number }>();
  rows.forEach((row, index) => {
    const found = counts.get(row.kind);
    if (found) found.count += 1;
    else counts.set(row.kind, { label: row.label, count: 1, order: index });
  });
  const reasons = [...counts.values()]
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.order - b.order))
    .map(({ label, count }) => ({ label, count }));

  const limit = Math.max(0, Math.min(opts?.reasonLimit ?? SEARCH_FAILURE_REASON_LIMIT, reasons.length));
  return {
    total: rows.length,
    rows,
    reasons,
    text: reasons
      .slice(0, limit)
      .map((reason) => `${reason.count} ${reason.label}`)
      .join(' · '),
  };
}
