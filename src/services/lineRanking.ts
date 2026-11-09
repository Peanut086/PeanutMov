/**
 * 线路评分与排序（批次1 核心，纯函数无 IO）
 *
 * 根据线路健康记忆、历史播放记录、线路名关键词等信号，对线路进行评分排序，
 * 供详情页默认线路选择使用。
 *
 * 评分优先级（从高到低）：
 * 1. 会话内用户手动选过 → 绝对尊重（由调用方保证，本函数不处理）
 * 2. 历史记录命中的线路 → 恢复上次播放线路
 * 3. 记忆 ok（按 successCount 降序、lastResolveMs 升序）
 * 4. 免费信号：线路名关键词加分（4K/蓝光/高清/专线/自建）/ 减分（测试/维护/失效）
 * 5. unknown 未探测
 * 6. 记忆 fail 沉底
 * 7. 同分保持源返回顺序（稳定排序）
 */
import type { PlayLine } from '@/types';
import { lineHealthService, type LineHealthStatus } from '@/services/lineHealthService';

export interface LineRankingContext {
  /** 当前所有线路（源返回顺序） */
  lines: PlayLine[];
  /** 历史记录中的 episodeId（用于恢复上次播放线路） */
  historyEpisodeId: string | null;
  /** 所有剧集列表（用于从 episodeId 解析 lineId） */
  episodes: Array<{ id: string; lineId: string }>;
  /** 线路 key 构建器（sourceId|sourceItemId|lineName） */
  buildKey: (line: PlayLine) => string;
}

/** 线路名关键词加分（质量高） */
const QUALITY_BOOST_KEYWORDS = ['4K', '蓝光', '高清', '超清', '专线', '自建', 'HDR', '杜比', '原盘'];

/** 线路名关键词减分（质量低或不可用） */
const QUALITY_PENALTY_KEYWORDS = ['测试', '维护', '失效', '备用', '临时', 'demo'];

/**
 * 计算线路的免费信号分（基于线路名关键词）
 */
function qualitySignalScore(lineName: string): number {
  const lower = lineName.toLowerCase();
  let score = 0;
  for (const kw of QUALITY_BOOST_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) score += 10;
  }
  for (const kw of QUALITY_PENALTY_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) score -= 20;
  }
  return score;
}

/**
 * 从历史记录中恢复上次播放的线路
 */
function resumeLineId(ctx: LineRankingContext): string | null {
  if (!ctx.historyEpisodeId) return null;
  const ep = ctx.episodes.find((e) => e.id === ctx.historyEpisodeId);
  return ep?.lineId ?? null;
}

/**
 * 线路评分（数值越高越优先）
 */
function scoreLine(line: PlayLine, ctx: LineRankingContext, index: number): number {
  const key = ctx.buildKey(line);
  const status: LineHealthStatus = lineHealthService.statusOf(key);
  const entry = lineHealthService.entryOf(key);

  // 历史记录命中的线路 → 最高优先（但低于手动选择，手动选择由调用方保证）
  const resumeId = resumeLineId(ctx);
  if (resumeId && line.id === resumeId) {
    return 10000 - index; // 减去 index 保持稳定排序
  }

  // 记忆 ok → 按 successCount 和 resolveMs 排序
  if (status === 'ok' && entry) {
    const successScore = entry.successCount * 100;
    const resolveScore = entry.lastResolveMs ? Math.max(0, 1000 - entry.lastResolveMs) : 0;
    return 5000 + successScore + resolveScore - index;
  }

  // 免费信号分（线路名关键词）
  const qualityScore = qualitySignalScore(line.name);

  // unknown 未探测 → 中等优先
  if (status === 'unknown') {
    return 1000 + qualityScore - index;
  }

  // 记忆 fail → 沉底
  if (status === 'fail') {
    return -1000 + qualityScore - index;
  }

  return 0 - index;
}

/**
 * 对线路按评分降序排序（纯函数，不修改原数组）
 */
export function rankLines(ctx: LineRankingContext): PlayLine[] {
  if (ctx.lines.length <= 1) return [...ctx.lines];
  return [...ctx.lines]
    .map((line, index) => ({ line, score: scoreLine(line, ctx, index), index }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index; // 同分保持源返回顺序
    })
    .map((entry) => entry.line);
}

/**
 * 获取评分最高的线路（默认选择）
 */
export function pickBestLine(ctx: LineRankingContext): PlayLine | null {
  const ranked = rankLines(ctx);
  return ranked[0] ?? null;
}
