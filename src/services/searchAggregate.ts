/**
 * 跨源聚合检索（v2.0 / P0-P1 搜索优化，纯函数无 IO）
 *
 * 把搜索结果按「归一化根标题 + 年份宽容归组」合并成组：
 * - 归一化复用 `stripTitleNoise`（去季/部/清晰度/年份后缀、全半角、繁简不区分）；
 * - 年份宽容：同一根标题下，一方缺年份则并入有年份组；双方年份冲突才拆分；
 * - 组内按 可播性 → 源健康 tier → 延迟 排序（P0-1 可播优先代表）；
 * - 组间按 相关度 → 已确认有集 → 健康 tier → 延迟 → 来源数 排序。
 */
import type { AppErrorShape, MediaItem, SearchResultGroup, SourceHealth } from '@/types';
import type { PlayabilityStatus } from '@/services/playabilityService';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';
import { normalizeTitleForMatch, stripTitleNoise } from '@/sources/douban/playMatch';
import { classifySourceFailure, sanitizeSourceMessage } from '@/shared/sourceFailure';
import type { SourceFailureKind } from '@/shared/sourceFailure';

/** 根标题（归一化后，用于归组） */
function rootTitleOf(title: string): string {
  return stripTitleNoise(title) || normalizeTitleForMatch(title) || title.trim().toLowerCase();
}

/** 从标题推断年份（item.year 为 null 时的兜底） */
function inferYear(item: MediaItem): number | null {
  if (item.year !== null) return item.year;
  const match = item.title.match(/\b((?:19|20)\d{2})\b(?![集话期])/);
  if (!match) return null;
  const y = parseInt(match[1], 10);
  return y >= 1900 && y <= 2099 ? y : null;
}

interface RawGroup {
  key: string;
  title: string;
  year: number | null;
  items: MediaItem[];
  order: number;
}

/**
 * 年份宽容归组（P1-5）：
 * 同一根标题下，一方缺年份则并入有年份组；双方年份冲突才拆分。
 */
function buildYearTolerantGroups(items: MediaItem[]): Map<string, RawGroup> {
  const buckets = new Map<string, MediaItem[]>();
  const bucketOrder = new Map<string, number>();
  let orderCounter = 0;
  for (const item of items) {
    const root = rootTitleOf(item.title);
    let bucket = buckets.get(root);
    if (!bucket) {
      bucket = [];
      buckets.set(root, bucket);
      bucketOrder.set(root, orderCounter++);
    }
    bucket.push(item);
  }

  const groups = new Map<string, RawGroup>();
  for (const [root, bucketItems] of buckets) {
    const yearCounts = new Map<number, number>();
    const nullItems: MediaItem[] = [];
    for (const item of bucketItems) {
      const y = inferYear(item);
      if (y === null) nullItems.push(item);
      else yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
    }
    const distinctYears = [...yearCounts.keys()];
    const order = bucketOrder.get(root)!;

    if (distinctYears.length <= 1) {
      const year = distinctYears[0] ?? null;
      const key = `${root}:${year ?? 'unknown'}`;
      groups.set(key, { key, title: bucketItems[0].title, year, items: [...bucketItems], order });
    } else {
      const yearGroups = new Map<number, MediaItem[]>();
      for (const item of bucketItems) {
        const y = inferYear(item);
        if (y === null) continue;
        let g = yearGroups.get(y);
        if (!g) { g = []; yearGroups.set(y, g); }
        g.push(item);
      }
      let largestYear = distinctYears[0];
      let largestSize = yearGroups.get(largestYear)?.length ?? 0;
      for (const [y, g] of yearGroups) {
        if (g.length > largestSize) { largestSize = g.length; largestYear = y; }
      }
      yearGroups.get(largestYear)!.push(...nullItems);
      for (const [year, groupItems] of yearGroups) {
        const key = `${root}:${year}`;
        groups.set(key, { key, title: groupItems[0].title, year, items: groupItems, order });
      }
    }
  }
  return groups;
}

/** 可播性排序权重：playable=0, verifying/unknown=1, empty/error=2 */
function playabilityRank(status: PlayabilityStatus): number {
  if (status === 'playable') return 0;
  if (status === 'verifying' || status === 'unknown') return 1;
  return 2;
}

/** 组内条目排序：可播性 → 健康 tier → 延迟 → 到达顺序 */
function sortGroupItems(
  items: MediaItem[],
  healthOf: (sourceId: string) => SourceHealth,
  latencyOf: (sourceId: string) => number | null,
  playabilityOf: (mediaId: string) => PlayabilityStatus,
): MediaItem[] {
  if (items.length <= 1) return [...items];
  const indexed = items.map((item, i) => ({ item, i }));
  return indexed
    .sort((a, b) => {
      const pA = playabilityRank(playabilityOf(a.item.id));
      const pB = playabilityRank(playabilityOf(b.item.id));
      if (pA !== pB) return pA - pB;
      const tierA = HEALTH_TIER_ORDER[healthTierOf(healthOf(a.item.sourceId), latencyOf(a.item.sourceId))];
      const tierB = HEALTH_TIER_ORDER[healthTierOf(healthOf(b.item.sourceId), latencyOf(b.item.sourceId))];
      if (tierA !== tierB) return tierA - tierB;
      const latA = latencyOf(a.item.sourceId);
      const latB = latencyOf(b.item.sourceId);
      const rA = latA === null || !Number.isFinite(latA) ? Number.POSITIVE_INFINITY : latA;
      const rB = latB === null || !Number.isFinite(latB) ? Number.POSITIVE_INFINITY : latB;
      if (rA !== rB) return rA - rB;
      return a.i - b.i;
    })
    .map((e) => e.item);
}

/**
 * F6：非正片内容形态——字面命中关键词、但不是剧集的内容。
 *
 * 真机四档实测（关键词「绝命毒师」）：正片始终排第一（第五季 88 来源），所以症状
 * 「只返回 B 站解说/网盘资源」不是排序压制了正片，而是这批条目混在结果尾部：
 * `【第1次补档】…【非AI真人语音解说】`(560分鐘)、`【黑屏·弹幕版】一口气24小时看完…`(1536分鐘)、
 * `【加急点播-…reaction】`、`【yuwapeach ASMR】绝命毒师乐高收藏`、`跟经典美剧《绝命毒师》学英语-001`、
 * `王橹杰最新微博视频re：…`，以及网盘源的垃圾命名 `绝命毒师的搜索有80条`。
 *
 * `scoreRelevance` 只看标题包含、`isKeywordIgnored` 又要求整批相关度全 0，两者都抓不到它们，
 * 所以单列一个形态维度。词表只收实测出现过的形态，不预防性地扩张（避免误杀真实片名）。
 *
 * 注意：这里只降权、不删除；且不动 `stripTitleNoise`——那个函数服务于豆瓣跨源借播放地址，
 * 把「解说」剥掉会让解说条目匹配到正片地址，属于制造错误播放。
 */
const NON_FEATURE_PATTERN =
  /(解说|reaction|asmr|学英语|一口气.{0,10}(看完|解读)|补档|黑屏|弹幕版|乐高|微博视频)/i;

/** 网盘源的垃圾结果名（把"搜索结果条数"当成片名返回） */
const NETDISK_JUNK_TITLE = /的搜索有\d+条$/;

/**
 * 是否为非正片内容。
 *
 * `keyword` 参与判定做自卫：用户主动搜「绝命毒师 解说」时不该把这些内容再压下去。
 */
export function isNonFeatureContent(title: string, keyword = ''): boolean {
  if (NON_FEATURE_PATTERN.test(keyword)) return false;
  return NON_FEATURE_PATTERN.test(title) || NETDISK_JUNK_TITLE.test(title.trim().toLowerCase());
}

/**
 * 聚合分组（v2.0）：年份宽容归组 + 可播性优先排序。
 *
 * 组间排序：**相关度 → 是否非正片 → 已确认有集 → 健康 tier → 延迟 → 来源数 → 首次出现顺序**。
 */
export function groupSearchResults(
  items: MediaItem[],
  keyword: string,
  healthOf: (sourceId: string) => SourceHealth = () => 'unknown',
  latencyOf: (sourceId: string) => number | null = () => null,
  playabilityOf: (mediaId: string) => PlayabilityStatus = () => 'unknown',
): SearchResultGroup[] {
  const rawGroups = buildYearTolerantGroups(items);

  const list: Array<RawGroup & { items: MediaItem[] }> = [];
  for (const group of rawGroups.values()) {
    list.push({
      ...group,
      items: sortGroupItems(group.items, healthOf, latencyOf, playabilityOf),
    });
  }

  type RankTuple = [number, number, number, number, number, number];
  const rankOf = (group: (typeof list)[number]): RankTuple => {
    const rep = group.items[0];
    const pRank = rep ? playabilityRank(playabilityOf(rep.id)) : 1;
    const tier = rep
      ? HEALTH_TIER_ORDER[healthTierOf(healthOf(rep.sourceId), latencyOf(rep.sourceId))]
      : HEALTH_TIER_ORDER.unknown;
    const latency = rep ? latencyOf(rep.sourceId) : null;
    const latencyRank = latency === null || !Number.isFinite(latency) ? Number.POSITIVE_INFINITY : latency;
    // F6：非正片（解说/reaction/ASMR/网盘垃圾命名）整组沉到正片之后，但不删除
    const nonFeature = isNonFeatureContent(group.title, keyword) ? 1 : 0;
    return [-scoreRelevance(group.title, keyword), nonFeature, pRank, tier, latencyRank, -group.items.length];
  };

  return list
    .sort((a, b) => {
      const rA = rankOf(a);
      const rB = rankOf(b);
      for (let i = 0; i < rA.length; i++) {
        if (rA[i] !== rB[i]) return rA[i] - rB[i];
      }
      return a.order - b.order;
    })
    .map(({ key, title, year, items: groupItems }) => ({ key, title, year, items: groupItems }));
}

/**
 * 选出组的代表条目（可播优先 + 线路可靠度）：
 * 1. 第一个 status === 'playable' 且线路可靠度 > 0.3 的条目；
 * 2. 都没有则取 playable 中可靠度最高的；
 * 3. 都不可播则取排序后的第一个（tier/latency 最优）。
 */
export function selectRepresentative(
  group: SearchResultGroup,
  playabilityOf: (mediaId: string) => PlayabilityStatus = () => 'unknown',
  reliabilityOf?: (sourceId: string) => number,
): MediaItem | undefined {
  // 批次2-5：引入线路可靠度
  const RELIABILITY_THRESHOLD = 0.3;
  
  // 优先选 playable + 可靠度高的
  let bestPlayable: MediaItem | undefined;
  let bestReliability = -1;
  
  for (const item of group.items) {
    if (playabilityOf(item.id) === 'playable') {
      const reliability = reliabilityOf ? reliabilityOf(item.sourceId) : 0.5;
      if (reliability > RELIABILITY_THRESHOLD && reliability > bestReliability) {
        bestPlayable = item;
        bestReliability = reliability;
      }
    }
  }
  
  if (bestPlayable) return bestPlayable;
  
  // 退而求其次：任何 playable
  for (const item of group.items) {
    if (playabilityOf(item.id) === 'playable') return item;
  }
  
  // 都不可播，取第一个
  return group.items[0];
}

/**
 * 相关度打分（v1.9/AC-121）：精确(4) > 前缀(3) > 包含(2) > 分词包含(1) > 无关(0)。
 */
export function scoreRelevance(title: string, keyword: string): number {
  const t = normalizeTitleForMatch(title);
  const k = normalizeTitleForMatch(keyword);
  if (t.length === 0 || k.length === 0) return 0;
  if (t === k) return 4;
  if (t.startsWith(k)) return 3;
  if (t.includes(k)) return 2;
  const words = keyword.trim().split(/\s+/).map((w) => normalizeTitleForMatch(w)).filter((w) => w.length > 0);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 1;
  return 0;
}

/**
 * P0-1：判定一批搜索结果是否属于"源忽略关键词"（典型：采集站关闭搜索，返回最新目录）。
 *
 * 判定条件（保守，避免误杀演员搜索）：
 * - 返回条数 ≥ `minCount`（默认 15，量子资源等采集站固定返回 20）；
 * - 所有条目标题对关键词的相关度均为 0（既不包含、也不分词命中）。
 *
 * 命中即视为"源忽略关键词"，调用方应过滤这批结果（不上屏、不落库、不判活）。
 */
export function isKeywordIgnored(
  items: ReadonlyArray<{ title: string }>,
  keyword: string,
  minCount = 15,
): boolean {
  if (items.length < minCount) return false;
  for (const item of items) {
    if (scoreRelevance(item.title, keyword) > 0) return false;
  }
  return true;
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
 * 平铺视图的去重键（保留兼容旧调用方；主流程已改用年份宽容归组）。
 */
export function titleDedupKey(title: string, year: number | null): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, '');
  return `${normalized}:${year ?? 'unknown'}`;
}

/* ---------- OPT-04：失败源汇总 ---------- */

export const SEARCH_FAILURE_LABELS: Record<SourceFailureKind, string> = {
  source_dead: '源站已失效',
  timeout: '解析超时',
  protocol_unsupported: '格式不支持',
  rule_script: '规则脚本异常',
  source_internal: '源侧执行异常',
  safe_mode: '安全模式暂停',
  quarantined: '爬虫被隔离',
  spider_mismatch: '爬虫类缺失',
  jar_conflict: 'jar 依赖冲突',
  auth: '需要登录',
  keyword_ignored: '源忽略关键词',
  unknown: '原因未知',
};

export const SEARCH_FAILURE_REASON_LIMIT = 2;

export interface SearchFailureRow {
  sourceId: string;
  kind: SourceFailureKind;
  label: string;
  detail: string;
}

export interface SearchFailureSummary {
  total: number;
  rows: SearchFailureRow[];
  reasons: Array<{ label: string; count: number }>;
  text: string;
}

export function failedSourceIds(
  failures: ReadonlyArray<{ sourceId: string; error: AppErrorShape }>,
): string[] {
  return [...new Set(failures.map((failure) => failure.sourceId))];
}

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

/**
 * P0-2：关键词规范化
 *
 * 去除用户可能从标题复制时带入的标点符号，提取纯文本关键词。
 * 例如：《今天是太阳雨》 → 今天是太阳雨
 */
export function normalizeSearchKeyword(raw: string): string {
  return raw
    .replace(/[《》「」【】\[\]（）()〈〉〝〞〟‟‟″＂]/g, '')
    .trim();
}

/**
 * C-12：搜不到时的尾词建议（最多 3 条）。
 *
 * 「去掉尾字」排第一——中文搜索最后一字打错的概率最高；其余是缩短兜底。
 * 算不出就返回空数组，不用无意义的短词硬凑到 3 个。
 */
export function buildTailSuggestions(rawKeyword: string): string[] {
  const keyword = normalizeSearchKeyword(rawKeyword);
  if (keyword.length < 3) return [];
  const candidates = [keyword.slice(0, -1), keyword.slice(0, 2)];
  if (keyword.length >= 5) candidates.push(keyword.slice(-3));
  if (keyword.length >= 4) candidates.push(keyword.slice(-2));
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < 2 || candidate === keyword) continue;
    if (out.includes(candidate)) continue;
    out.push(candidate);
    if (out.length >= 3) break;
  }
  return out;
}
