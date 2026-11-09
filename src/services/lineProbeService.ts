/**
 * 线路后台探测服务（批次2 核心）
 *
 * 进详情页后按评分排序逐条探测线路（只探目标集），第一条成功即停。
 * 探测结果写入 lineHealthService，供后续默认线路选择使用。
 *
 * 设计要点：
 * - 按 lineRanking 排序，优先探测评分高的线路；
 * - 单条超时 8s、总预算 15s，避免拖慢详情页加载；
 * - 并发 1（顺序探测），避免爬虫源并发请求被限流；
 * - 离线跳过；
 * - 探测成功的地址进 resolvePlay 内存缓存（复用现有机制），点播放时零成本命中。
 */
import type { Episode, MediaItem, PlayLine } from '@/types';
import { libraryService } from '@/services/libraryService';
import { lineHealthService, lineKey } from '@/services/lineHealthService';
import { rankLines } from '@/services/lineRanking';
import { isOnline } from '@/native/network';
import { logger } from '@/shared/logger';

const PROBE_TIMEOUT_MS = 8000;
const PROBE_BUDGET_MS = 15000;

export interface ProbeContext {
  item: MediaItem;
  lines: PlayLine[];
  targetEpisode: Episode;
  historyEpisodeId?: string | null;
}

export interface ProbeResult {
  probedCount: number;
  successLineId: string | null;
  allFailed: boolean;
}

/**
 * 后台顺序探测线路（fire-and-forget，不阻塞 UI）
 */
export async function probeLines(ctx: ProbeContext): Promise<ProbeResult> {
  if (!isOnline()) {
    return { probedCount: 0, successLineId: null, allFailed: false };
  }

  const { item, lines, targetEpisode, historyEpisodeId } = ctx;
  if (lines.length === 0) {
    return { probedCount: 0, successLineId: null, allFailed: false };
  }

  // 按评分排序
  const ranked = rankLines({
    lines,
    historyEpisodeId: historyEpisodeId ?? null,
    episodes: [{ id: targetEpisode.id, lineId: targetEpisode.lineId }],
    buildKey: (line) => lineKey(item.sourceId, item.sourceItemId, line.name),
  });

  const budgetStart = Date.now();
  let probedCount = 0;
  let successLineId: string | null = null;

  for (const line of ranked) {
    // 总预算检查
    if (Date.now() - budgetStart > PROBE_BUDGET_MS) {
      logger.debug('线路探测总预算耗尽', { probedCount });
      break;
    }

    probedCount++;
    const key = lineKey(item.sourceId, item.sourceItemId, line.name);
    const startTime = Date.now();

    try {
      // 单条探测：调 resolvePlay（会进内存缓存）
      const probePromise = libraryService.resolvePlay({
        mediaId: item.id,
        episodeId: targetEpisode.id,
        lineId: line.id,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('E_TIMEOUT')), PROBE_TIMEOUT_MS),
      );

      await Promise.race([probePromise, timeoutPromise]);
      const resolveMs = Date.now() - startTime;

      // 探测成功
      lineHealthService.recordSuccess(key, resolveMs);
      successLineId = line.id;
      logger.debug('线路探测成功', { lineId: line.id, lineName: line.name, resolveMs });
      break; // 第一条成功即停
    } catch (e) {
      // 探测失败（按错误分类记录）
      const errorCode = (e as any)?.code ?? 'E_UNKNOWN';
      lineHealthService.recordFail(key, errorCode);
      logger.debug('线路探测失败', { lineId: line.id, lineName: line.name, errorCode });
    }
  }

  const allFailed = successLineId === null && probedCount === lines.length;
  return { probedCount, successLineId, allFailed };
}
