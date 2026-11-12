/**
 * 观影报告聚合（D2）
 *
 * 纯函数：只吃历史记录 + 媒体元数据 + 源名，不碰 Service/Store，便于逐条断言。
 *
 * **口径必须诚实**：`history` 表同一 `sourceId:mediaId` 只保留一条，且只记得
 * 最近一集的 `positionSec`（完播时还会被归零）。因此没有任何字段能给出真实的
 * "累计观看时长"，这里给出的是**估算**：
 * - 电影 / 第 1 集：完播算整集时长，未完播算 positionSec；
 * - 第 N 集（N > 1）：前 N-1 集按看完算 + 当前集进度。
 * 同理，月度分布只能按 `updatedAt`（最后一次观看）归月，不是"每次观看"的流水。
 * 页面上这两处都写明了口径，不许把估算包装成精确统计。
 */
import { PROGRESS_FINISHED_THRESHOLD } from '@/shared/constants';
import type { HistoryRecord, MediaType } from '@/types';

/** 集号异常兜底：某些综艺把日期当集号（20240101），乘上去会估出几千小时 */
const MAX_COUNTABLE_EPISODES = 500;
/** 月度柱状图窗口 */
export const REPORT_MONTH_WINDOW = 6;
/** 口味榜最多展示几项，其余并入「其它」 */
export const REPORT_TOP_SLICES = 6;
/** 片源榜最多展示几项 */
export const REPORT_TOP_SOURCES = 5;

export type TasteDimension = 'type' | 'genre' | 'area';
export type TasteMeasure = 'count' | 'seconds';

export interface ReportMeta {
  type: MediaType;
  genres: string[];
  area: string | null;
}

export interface ReportSlice {
  key: string;
  /** 展示名；`type` 维度返回的是 MediaType 原值，由调用方本地化 */
  label: string;
  count: number;
  seconds: number;
  /** 按部数的占比 0~1，分母见 buildWatchReport 内注释 */
  share: number;
  /** 按估算时长的占比 0~1，切到「时长」口径时用它，否则数字和百分比不同源 */
  secondsShare: number;
}

export interface ReportMonth {
  /** `2026-11` */
  key: string;
  /** `11月`；跨年时首个柱带年份 */
  label: string;
  count: number;
  seconds: number;
}

export interface ReportTitleRef {
  id: string;
  mediaId: string;
  sourceId: string;
  title: string;
  posterUrl: string | null;
  seconds: number;
}

export interface WatchReport {
  totalRecords: number;
  finishedCount: number;
  /** 完播率 0~1 */
  completionRate: number;
  estimatedSeconds: number;
  /** 有记录的天数（按 updatedAt 的本地日期去重） */
  activeDays: number;
  /** 首末记录跨越天数，含首日；无记录为 0 */
  spanDays: number;
  bestStreakDays: number;
  /** 最近一次观看在今天或昨天时才计入，否则为 0 */
  currentStreakDays: number;
  taste: Record<TasteDimension, ReportSlice[]>;
  months: ReportMonth[];
  sources: ReportSlice[];
  /** 投入最多的一部 */
  topTitle: ReportTitleRef | null;
  /** 全部记录，updatedAt 倒序，供片单区筛选与分页 */
  titles: HistoryRecord[];
  /** 媒体缓存已被清理、拿不到题材/地区的条数 */
  unknownMetaCount: number;
}

export interface ReportInput {
  records: HistoryRecord[];
  /** key = mediaId；缓存缺失的条目可以不传 */
  meta: Map<string, ReportMeta>;
  /** key = sourceId */
  sourceNames: Map<string, string>;
  now?: number;
}

const UNKNOWN_KEY = '__unknown';
const REMOVED_KEY = '__removed';
const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function dayStamp(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function monthKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * 单条记录的估算观看秒数。导出供页面对单行展示同一口径，避免两处算法漂移。
 */
export function estimatedWatchSeconds(record: HistoryRecord): number {
  const per = Number(record.durationSec);
  if (!Number.isFinite(per) || per <= 0) return 0;

  const position = Math.min(per, Math.max(0, Number(record.positionSec) || 0));
  const current = record.finished ? per : position;

  const episode = Number(record.episodeNumber);
  if (!Number.isFinite(episode) || episode <= 1) return current;

  const total = Number(record.totalEpisodes);
  const hasTotal = Number.isFinite(total) && total > 0;
  // 没有总集数兜底时，超出常理的集号（综艺用日期当集号）直接退回单集，不做乘法
  if (!hasTotal && episode > MAX_COUNTABLE_EPISODES) return current;

  // 有总集数就信它：集号越界属于源数据不一致，钳到总集数而不是把前面几集一起丢掉
  const countable = Math.min(episode, hasTotal ? total : MAX_COUNTABLE_EPISODES, MAX_COUNTABLE_EPISODES);
  // 当前集算不算看完由 current 决定，这里只累加它之前的集数，否则完播会多算一集
  return (countable - 1) * per + current;
}

/** 降序排列后截断到 limit，余项合并成「其它」；空输入返回空数组 */
function rankSlices(
  buckets: Map<string, { label: string; count: number; seconds: number }>,
  denominator: { count: number; seconds: number },
  limit: number,
  otherLabel: string,
): ReportSlice[] {
  const shareOf = (count: number, seconds: number): Pick<ReportSlice, 'share' | 'secondsShare'> => ({
    share: denominator.count > 0 ? count / denominator.count : 0,
    secondsShare: denominator.seconds > 0 ? seconds / denominator.seconds : 0,
  });
  const sorted = [...buckets.entries()]
    .map(([key, value]) => ({
      key,
      label: value.label,
      count: value.count,
      seconds: value.seconds,
      ...shareOf(value.count, value.seconds),
    }))
    .sort((a, b) => (b.count === a.count ? b.seconds - a.seconds : b.count - a.count));

  if (sorted.length <= limit) return sorted;

  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const rest = tail.reduce(
    (acc, slice) => ({ count: acc.count + slice.count, seconds: acc.seconds + slice.seconds }),
    { count: 0, seconds: 0 },
  );
  head.push({
    key: '__rest',
    label: otherLabel,
    count: rest.count,
    seconds: rest.seconds,
    ...shareOf(rest.count, rest.seconds),
  });
  return head;
}

export function buildWatchReport(input: ReportInput): WatchReport {
  const now = input.now ?? Date.now();
  const records = [...input.records].sort((a, b) => b.updatedAt - a.updatedAt);
  const totalRecords = records.length;

  const typeBuckets = new Map<string, { label: string; count: number; seconds: number }>();
  const genreBuckets = new Map<string, { label: string; count: number; seconds: number }>();
  const areaBuckets = new Map<string, { label: string; count: number; seconds: number }>();
  const sourceBuckets = new Map<string, { label: string; count: number; seconds: number }>();
  const monthBuckets = new Map<string, { count: number; seconds: number }>();
  const days = new Set<number>();

  let estimatedSeconds = 0;
  let finishedCount = 0;
  let unknownMetaCount = 0;
  let genreTaggedRecords = 0;
  let genreTaggedSeconds = 0;
  let topTitle: ReportTitleRef | null = null;

  const bump = (
    buckets: Map<string, { label: string; count: number; seconds: number }>,
    key: string,
    label: string,
    seconds: number,
  ): void => {
    const found = buckets.get(key);
    if (found) {
      found.count += 1;
      found.seconds += seconds;
      return;
    }
    buckets.set(key, { label, count: 1, seconds });
  };

  for (const record of records) {
    const seconds = estimatedWatchSeconds(record);
    estimatedSeconds += seconds;
    if (record.finished) finishedCount += 1;
    days.add(dayStamp(record.updatedAt));

    const monthKey = monthKeyOf(record.updatedAt);
    const month = monthBuckets.get(monthKey);
    if (month) {
      month.count += 1;
      month.seconds += seconds;
    } else {
      monthBuckets.set(monthKey, { count: 1, seconds });
    }

    // 源已删除时名字不可考，多个死源合并成一行，否则报告里会出现好几条一模一样的「已移除的源」
    const sourceName = input.sourceNames.get(record.sourceId);
    if (sourceName) bump(sourceBuckets, record.sourceId, sourceName, seconds);
    else bump(sourceBuckets, REMOVED_KEY, '已移除的源', seconds);

    const meta = input.meta.get(record.mediaId);
    if (!meta) unknownMetaCount += 1;

    // 类型：元数据缺失时退回快照，快照也没有才归「未知」
    const type = meta?.type ?? record.mediaSnapshot?.type ?? null;
    if (type) bump(typeBuckets, type, type, seconds);
    else bump(typeBuckets, UNKNOWN_KEY, '未识别', seconds);

    const genres = meta?.genres.filter((g) => g.trim().length > 0) ?? [];
    if (genres.length > 0) {
      genreTaggedRecords += 1;
      genreTaggedSeconds += seconds;
      // 一部片可属多个题材，逐个 +1；因此分母用「有题材的条数」而不是总条数
      for (const genre of new Set(genres.map((g) => g.trim()))) {
        bump(genreBuckets, genre, genre, seconds);
      }
    } else {
      bump(genreBuckets, UNKNOWN_KEY, '未分类', seconds);
    }

    const area = meta?.area?.trim();
    if (area) bump(areaBuckets, area, area, seconds);
    else bump(areaBuckets, UNKNOWN_KEY, '未标注', seconds);

    if (!topTitle || seconds > topTitle.seconds) {
      topTitle = {
        id: record.id,
        mediaId: record.mediaId,
        sourceId: record.sourceId,
        title: record.title,
        posterUrl: record.posterUrl,
        seconds,
      };
    }
  }

  const sortedDays = [...days].sort((a, b) => a - b);
  let bestStreakDays = 0;
  let run = 0;
  let previous = 0;
  for (const stamp of sortedDays) {
    run = previous !== 0 && stamp - previous === DAY_MS ? run + 1 : 1;
    previous = stamp;
    if (run > bestStreakDays) bestStreakDays = run;
  }
  const lastDay = sortedDays[sortedDays.length - 1] ?? 0;
  const today = dayStamp(now);
  const currentStreakDays = today - lastDay <= DAY_MS ? run : 0;

  const months: ReportMonth[] = [];
  const cursor = new Date(now);
  cursor.setDate(1);
  for (let i = REPORT_MONTH_WINDOW - 1; i >= 0; i -= 1) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    const bucket = monthBuckets.get(key);
    const showYear = i === REPORT_MONTH_WINDOW - 1 || d.getMonth() === 0;
    months.push({
      key,
      label: showYear ? `${d.getFullYear()}/${d.getMonth() + 1}` : `${d.getMonth() + 1}月`,
      count: bucket?.count ?? 0,
      seconds: bucket?.seconds ?? 0,
    });
  }

  // 跨度用 createdAt（首次观看，覆盖写入时保留），比 updatedAt 更接近"陪伴了多少天"
  let earliest = now;
  for (const record of records) {
    const start = Number(record.createdAt) || record.updatedAt;
    if (start < earliest) earliest = start;
  }
  const spanDays = totalRecords > 0 ? Math.round((dayStamp(now) - dayStamp(earliest)) / DAY_MS) + 1 : 0;
  const totalDenominator = { count: totalRecords, seconds: estimatedSeconds };

  return {
    totalRecords,
    finishedCount,
    completionRate: totalRecords > 0 ? finishedCount / totalRecords : 0,
    estimatedSeconds,
    activeDays: sortedDays.length,
    spanDays,
    bestStreakDays,
    currentStreakDays,
    taste: {
      type: rankSlices(typeBuckets, totalDenominator, REPORT_TOP_SLICES, '其它类型'),
      genre: rankSlices(
        genreBuckets,
        { count: genreTaggedRecords, seconds: genreTaggedSeconds },
        REPORT_TOP_SLICES,
        '其它题材',
      ),
      area: rankSlices(areaBuckets, totalDenominator, REPORT_TOP_SLICES, '其它地区'),
    },
    months,
    sources: rankSlices(sourceBuckets, totalDenominator, REPORT_TOP_SOURCES, '其它源'),
    topTitle,
    titles: records,
    unknownMetaCount,
  };
}

/** 片单筛选：全部 / 已看完 / 还没看完 */
export type TitleFilter = 'all' | 'finished' | 'watching';

export function filterTitles(
  records: HistoryRecord[],
  filter: TitleFilter,
  monthKey: string | null,
): HistoryRecord[] {
  return records.filter((record) => {
    if (monthKey !== null && monthKeyOf(record.updatedAt) !== monthKey) return false;
    if (filter === 'finished') return record.finished;
    if (filter === 'watching') return !record.finished && record.progress > 0.01;
    return true;
  });
}

/** 差一点就看完：进度过 60% 但未完播，按进度倒序 */
export function almostFinished(records: HistoryRecord[], limit = 4): HistoryRecord[] {
  return records
    .filter((r) => !r.finished && r.progress >= 0.6 && r.progress < PROGRESS_FINISHED_THRESHOLD)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, limit);
}

/** 报告分享文案（纯文本，便于系统分享面板与剪贴板兜底） */
export function formatReportText(report: WatchReport, typeLabel: (key: string) => string): string {
  const hours = report.estimatedSeconds / 3600;
  const lines = [
    'PeanutMov 观影报告',
    `累计估算观看 ${hours.toFixed(1)} 小时 · ${report.totalRecords} 部作品`,
    `完播 ${report.finishedCount} 部（${Math.round(report.completionRate * 100)}%） · 活跃 ${report.activeDays} 天`,
    `最长连续观影 ${report.bestStreakDays} 天`,
  ];
  const topGenres = report.taste.genre.filter((s) => s.key !== UNKNOWN_KEY).slice(0, 3);
  if (topGenres.length > 0) {
    lines.push(`偏好题材：${topGenres.map((s) => s.label).join(' / ')}`);
  }
  const topTypes = report.taste.type.filter((s) => s.key !== UNKNOWN_KEY).slice(0, 3);
  if (topTypes.length > 0) {
    lines.push(`常看类型：${topTypes.map((s) => typeLabel(s.key)).join(' / ')}`);
  }
  if (report.topTitle) {
    lines.push(`投入最多：《${report.topTitle.title}》约 ${(report.topTitle.seconds / 3600).toFixed(1)} 小时`);
  }
  lines.push('（时长为按历史进度估算，非精确统计）');
  return lines.join('\n');
}