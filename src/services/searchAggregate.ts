/**
 * 跨源聚合检索（v2.0 / P0-P1 搜索优化，纯函数无 IO）
 *
 * 把搜索结果按「归一化根标题 + 季号二级归并 + 年份宽容归组」合并成组：
 * - 归一化复用 `stripTitleNoise`（去季/部/清晰度/年份后缀、全半角、繁简不区分）；
 * - 季号（P1-7）：季号从分组键里剥出来再单独作一级——`第N季/Season N/S0N` 各成一组，
 *   不再让「绝命毒师」171 条挤成一组、代表项随机落在第三季；
 * - 年份宽容：同一根标题同同一季号下，一方缺年份则并入有年份组；双方年份冲突才拆分；
 * - 组内按 可播性 → 源健康 tier → 延迟 排序（P0-1 可播优先代表）；
 * - 组间按 相关度 → 查询词点名年份/季号的一致性 → 非正片 → 可播性 → 来源数 → 健康 tier → 延迟 排序。
 */
import type { AppErrorShape, MediaItem, SearchResultGroup, SourceHealth } from '@/types';
import type { PlayabilityStatus } from '@/services/playabilityService';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';
import { normalizeTitleForMatch, stripTitleNoise } from '@/sources/douban/playMatch';
import { parseSeasonNumber, parseYear } from '@/sources/mapping/TitleNormalizer';
import { classifySourceFailure, sanitizeSourceMessage } from '@/shared/sourceFailure';
import type { SourceFailureKind } from '@/shared/sourceFailure';

/**
 * 跨季打包写法（`1-5季`、`S01-S05`、`第1~3部`）。
 *
 * 这类条目覆盖整部剧：季号判成「第一季」会把全集包挤进第一季的组，
 * 留在根标题里又会让它跟单季条目不同根。所以从根里剥掉、季号记为未知，落到主条目那一组。
 */
const CROSS_SEASON_RANGE_SRC =
  '(?:[0-9]{1,3}|[一二两三四五六七八九十]{1,4})\\s*[-–~至]\\s*(?:s?\\s*[0-9]{1,3}|[一二两三四五六七八九十]{1,4})\\s*[季部篇]?|\\bs\\s*[0-9]{1,2}\\s*[-–~至]\\s*s?\\s*[0-9]{1,2}';
const CROSS_SEASON_TEST = new RegExp(CROSS_SEASON_RANGE_SRC, 'i');
const CROSS_SEASON_STRIP = new RegExp(CROSS_SEASON_RANGE_SRC, 'gi');

/**
 * 单季写法（`第N季/部/篇`、`Season N`、`Series N`、`S0N`）。
 *
 * `stripTitleNoise` 只认前三种，`S03` 这种短写会留在根里，导致「绝命毒师 S03」与
 * 「绝命毒师 第三季」不同根、各成一组——季号写法互认必须连短写一起剥。
 * 不剥裸尾数（`庆余年2`、`流浪地球2`）：那是续集号，语义不是季。
 */
const SEASON_TOKEN_STRIP = /第\s*(?:[0-9]{1,3}|[一二两三四五六七八九十百零]{1,4})\s*[季部篇]|\b(?:season|series)\s*[0-9]{1,2}\b|\bs\s*[0-9]{1,2}\b/gi;

/** 根标题（归一化后，用于归组）：季号写法一律剥干净，季号本身另算 */
function rootTitleOf(title: string): string {
  const withoutSeason = title.replace(CROSS_SEASON_STRIP, ' ').replace(SEASON_TOKEN_STRIP, ' ');
  return stripTitleNoise(withoutSeason) || normalizeTitleForMatch(withoutSeason) || withoutSeason.trim().toLowerCase();
}

/** 从标题推断年份（item.year 为 null 时的兜底） */
function inferYear(item: MediaItem): number | null {
  if (item.year !== null) return item.year;
  const match = item.title.match(/\b((?:19|20)\d{2})\b(?![集话期])/);
  if (!match) return null;
  const y = parseInt(match[1], 10);
  return y >= 1900 && y <= 2099 ? y : null;
}

/** 季号（复用「别名图谱」同一套解析，不再另立口径）；跨季打包记为未知 */
function seasonOf(title: string): number | null {
  if (CROSS_SEASON_TEST.test(title)) return null;
  return parseSeasonNumber(title);
}

/**
 * 查询词里的季号/年份标注词。
 *
 * P1-7：搜「绝命毒师 第三季」时，这些词不参与「分词都命中」的相关度判定——
 * 否则主条目「绝命毒师」会因为标题里没有「第三季」被判成无关（0 分）折进「其它匹配」。
 */
const QUERY_SEASON_YEAR_TOKEN =
  /^(?:第\s*(?:[0-9]{1,3}|[一二两三四五六七八九十]{1,4})\s*[季部篇]|[0-9]{1,3}\s*[季部篇]|season\s*[0-9]{1,2}|series\s*[0-9]{1,2}|s\s*[0-9]{1,2}|[（(]?(?:19|20)[0-9]{2}[）)]?年?|(?:19|20)[0-9]{2}年度)$/i;

function isQueryMarkerToken(token: string): boolean {
  return QUERY_SEASON_YEAR_TOKEN.test(token.trim());
}

interface RawGroup {
  key: string;
  title: string;
  year: number | null;
  season: number | null;
  items: MediaItem[];
  order: number;
}

/**
 * 组名取哪个标题：最贴查询词的优先，同分取更短的（后缀噪声更少），再同分取先到。
 *
 * 原来固定取到达顺序第一条，实测代表项就成了「绝命毒师 第三季」这种随机某季的名字。
 */
function pickDisplayTitle(items: MediaItem[], keyword: string): string {
  let best = items[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestLength = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const score = scoreRelevance(item.title, keyword);
    const length = normalizeTitleForMatch(item.title).length;
    if (score > bestScore || (score === bestScore && length < bestLength)) {
      best = item;
      bestScore = score;
      bestLength = length;
    }
  }
  return best.title;
}

/**
 * 年份宽容归组（P1-5）：
 * 同一根标题下，一方缺年份则并入有年份组；双方年份冲突才拆分。
 */
function splitByYearTolerance(bucketItems: MediaItem[]): Array<{ year: number | null; items: MediaItem[] }> {
  const yearGroups = new Map<number, MediaItem[]>();
  const nullItems: MediaItem[] = [];
  for (const item of bucketItems) {
    const y = inferYear(item);
    if (y === null) {
      nullItems.push(item);
      continue;
    }
    const sameYear = yearGroups.get(y);
    if (sameYear) sameYear.push(item);
    else yearGroups.set(y, [item]);
  }
  if (yearGroups.size <= 1) {
    const year = yearGroups.keys().next().value ?? null;
    return [{ year, items: [...bucketItems] }];
  }
  // 缺年份的条目并入条目最多的那一年，而不是另开一组
  let largestYear = yearGroups.keys().next().value as number;
  let largestSize = yearGroups.get(largestYear)?.length ?? 0;
  for (const [year, sameYear] of yearGroups) {
    if (sameYear.length > largestSize) {
      largestSize = sameYear.length;
      largestYear = year;
    }
  }
  yearGroups.get(largestYear)!.push(...nullItems);
  return [...yearGroups.entries()].map(([year, items]) => ({ year, items }));
}

/**
 * 根标题 → 季号 → 年份，三层归组（P1-7 改动点在中间那层）。
 */
function buildYearTolerantGroups(items: MediaItem[], keyword: string): Map<string, RawGroup> {
  const rootBuckets = new Map<string, MediaItem[]>();
  const rootOrder = new Map<string, number>();
  let orderCounter = 0;
  for (const item of items) {
    const root = rootTitleOf(item.title);
    let bucket = rootBuckets.get(root);
    if (!bucket) {
      bucket = [];
      rootBuckets.set(root, bucket);
      rootOrder.set(root, orderCounter++);
    }
    bucket.push(item);
  }

  const groups = new Map<string, RawGroup>();
  for (const [root, rootItems] of rootBuckets) {
    const order = rootOrder.get(root)!;
    const seasonBuckets = new Map<number | null, MediaItem[]>();
    for (const item of rootItems) {
      const season = seasonOf(item.title);
      const sameSeason = seasonBuckets.get(season);
      if (sameSeason) sameSeason.push(item);
      else seasonBuckets.set(season, [item]);
    }
    for (const [season, seasonItems] of seasonBuckets) {
      for (const { year, items: groupItems } of splitByYearTolerance(seasonItems)) {
        const key = `${root}:${year ?? 'unknown'}:${season ?? 'na'}`;
        groups.set(key, {
          key,
          title: pickDisplayTitle(groupItems, keyword),
          year,
          season,
          items: groupItems,
          order,
        });
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
 * 第二轮实测（关键词「庆余年」）补进 有声 / 混剪 / MV / 片尾曲 / 古筝 / 幕后纪实 这几类，
 * 同时**有意不收**：`纪录片`（正经品类）、`合集` `全集`（正片常这么命名）、
 * `特别篇` `特别版`（正式发行物）、`剪辑`（「导演剪辑版」是正片，只收 `混剪`）、
 * `钢琴`（「海上钢琴师」是片名，只收 `钢琴曲`）。
 * 另一类实测出现但**抓不到**的形态是营销号标题（`这部国产剧有毒！千万不要去看《庆余年》！！！`），
 * 标题里没有稳定形态词，只能靠来源平台判定，而按平台降权会连带压掉同一源上的正片，故不做。
 *
 * 注意：这里只降权、不删除；且不动 `stripTitleNoise`——那个函数服务于豆瓣跨源借播放地址，
 * 把「解说」剥掉会让解说条目匹配到正片地址，属于制造错误播放。
 */
const NON_FEATURE_FORMS = [
  '解说|解读|解析|赏析|拆解|盘点|梳理|回顾|reaction|微博视频',
  '一口气.{0,10}(看完|解读)|补档|黑屏|弹幕版|乐高|asmr|学英语',
  '有声|纯享|混剪|二创|同人|饭拍|直拍',
  '幕后|花絮|彩蛋|片花|制作记录|预告',
  '片尾曲|主题曲|插曲|翻唱|\\bmv\\b|古筝|古琴|钢琴曲|纯音乐|演奏',
];
const NON_FEATURE_PATTERN = new RegExp(NON_FEATURE_FORMS.join('|'), 'i');

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
 * P1-7：查询词点名的年份/季号参与组间排序。
 * 0=与查询一致，1=这一项未知（主条目常不带季号、采集站常缺年份），2=与查询冲突。
 * 查询没点名的维度恒为 0——不猜用户想要哪一季、哪一年。
 */
function queryAffinity(keyword: string, year: number | null, season: number | null): number {
  const queryYear = parseYear(keyword);
  const querySeason = seasonOf(keyword);
  let worst = 0;
  if (queryYear !== null) worst = Math.max(worst, year === null ? 1 : year === queryYear ? 0 : 2);
  if (querySeason !== null) worst = Math.max(worst, season === null ? 1 : season === querySeason ? 0 : 2);
  return worst;
}

/**
 * 聚合分组（v2.0）：根标题 + 季号二级归并 + 年份宽容 + 可播性优先排序。
 *
 * 组间排序：**相关度 → 年份/季号一致性 → 是否非正片 → 已确认有集 → 来源数 → 健康 tier → 延迟 → 首次出现顺序**。
 * 来源数（同一作品被多少个来源命中）提到健康档位之前，是「首位命中错误作品」的对症修法：
 * 真机上 2023 年同名动画只有 1~2 个来源，2008 剧版有几十个，档位/延迟却可能反过来。
 */
export function groupSearchResults(
  items: MediaItem[],
  keyword: string,
  healthOf: (sourceId: string) => SourceHealth = () => 'unknown',
  latencyOf: (sourceId: string) => number | null = () => null,
  playabilityOf: (mediaId: string) => PlayabilityStatus = () => 'unknown',
): SearchResultGroup[] {
  const rawGroups = buildYearTolerantGroups(items, keyword);

  const list: Array<RawGroup & { items: MediaItem[] }> = [];
  for (const group of rawGroups.values()) {
    list.push({
      ...group,
      items: sortGroupItems(group.items, healthOf, latencyOf, playabilityOf),
    });
  }

  type RankTuple = [number, number, number, number, number, number, number];
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
    return [
      -scoreRelevance(group.title, keyword),
      queryAffinity(keyword, group.year, group.season),
      nonFeature,
      pRank,
      -group.items.length,
      tier,
      latencyRank,
    ];
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
 *
 * P1-7：分词那一步跳过查询词里的季号/年份标注词——搜「绝命毒师 第三季」时主条目
 * 「绝命毒师」仍算同作品命中（1 分、留在结果里），季号本身的一致性由 `queryAffinity`
 * 负责排序，不该把整部剧判定成无关。
 */
export function scoreRelevance(title: string, keyword: string): number {
  const t = normalizeTitleForMatch(title);
  const k = normalizeTitleForMatch(keyword);
  if (t.length === 0 || k.length === 0) return 0;
  if (t === k) return 4;
  if (t.startsWith(k)) return 3;
  if (t.includes(k)) return 2;
  const words = keyword
    .trim()
    .split(/\s+/)
    .filter((token) => !isQueryMarkerToken(token))
    .map((token) => normalizeTitleForMatch(token))
    .filter((token) => token.length > 0);
  if (words.length === 0) return 0;
  // 单 token 的情形只可能是"原词被季号/年份拆出来的剩余部分"：多 token 的 AND 判定沿用旧口径
  if (words.every((token) => t.includes(token))) return 1;
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
