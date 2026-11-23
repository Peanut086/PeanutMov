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
 * - 成功口径 = `resolvePlay` 返回 **且** 该地址空读拿到字节（P1-4：爬虫答了不等于能播）；
 *   判死单次即沉底，判不出（超时/被 CORS 挡住）不记失败，探活结论按 URL 缓存 5 分钟；
 * - 离线跳过；
 * - 探测成功的地址进 resolvePlay 内存缓存（复用现有机制），点播放时零成本命中；
 * - **P0-1**：探测是后台活动，必须给真实点播让路——
 *   ① 逐条开探前查 `isPlaybackDemandInFlight()`，有用户在等播放就立即收手
 *   （否则探测与点播抢同一个爬虫串行闸门，用户看到的就是「该源正忙」）；
 *   ② 接受 `signal`，透传进 `resolvePlay`，让"用户点播放 / 离开页面 / 换片"能真正掐断在途解析，
 *   而不是靠 15s 预算干等；探测自身 `demand:false`，不冒充点播计数。
 */
import type { Episode, MediaItem, PlayLine } from '@/types';
import { libraryService } from '@/services/libraryService';
import { lineHealthService, lineKey } from '@/services/lineHealthService';
import { rankLines } from '@/services/lineRanking';
import { probeUrlLiveness, type LivenessResult } from '@/services/urlLivenessProbe';
import { isPlaybackDemandInFlight } from '@/services/prewarmState';
import { isOnline } from '@/native/network';
import { logger } from '@/shared/logger';

const PROBE_TIMEOUT_MS = 8000;
const PROBE_BUDGET_MS = 15000;

export interface ProbeContext {
  item: MediaItem;
  lines: PlayLine[];
  targetEpisode: Episode;
  historyEpisodeId?: string | null;
  /** P0-1：取消信号——用户点播放/离开详情页/换片时中止整轮探测 */
  signal?: AbortSignal;
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

    // P0-1：被取消（用户点播放/离开详情页/换片）就整轮收手，不再投下一条
    if (ctx.signal?.aborted) {
      logger.debug('线路探测被取消', { probedCount });
      break;
    }
    // P0-1：有真实点播在等爬虫实例，探测让路——它抢的正是同一批串行闸门
    if (isPlaybackDemandInFlight()) {
      logger.debug('点播在途，线路探测让路', { probedCount });
      break;
    }

    probedCount++;
    const key = lineKey(item.sourceId, item.sourceItemId, line.name);
    const startTime = Date.now();

    try {
      // 单条探测：调 resolvePlay（会进内存缓存）。P0-1：透传取消信号，且不计入点播计数
      const probePromise = libraryService.resolvePlay({
        mediaId: item.id,
        episodeId: targetEpisode.id,
        lineId: line.id,
        signal: ctx.signal,
        demand: false,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('E_TIMEOUT')), PROBE_TIMEOUT_MS),
      );

      const resolved = await Promise.race([probePromise, timeoutPromise]);
      const resolveMs = Date.now() - startTime;

      /*
       * P1-4：爬虫答了不等于地址能取到字节。真机实测默认第一条线路指向
       * `mv.gzlcl.com`（DNS 都解析不了），而 `resolvePlay` 照样成功返回——旧探测
       * 因此在第一条就"通过"并停住，用户点播放/下载才撞上失败。
       */
      const live: LivenessResult = resolved.isLocal
        ? { verdict: 'alive', latencyMs: 0, status: null, viaProxy: false }
        : await probeUrlLiveness(resolved.url, resolved.headers);

      if (live.verdict === 'dead') {
        // 确定性证据：单次即沉底，不等连败门槛再骗用户一次
        lineHealthService.recordFail(key, 'E_SOURCE_UNAVAILABLE', { immediate: true });
        logger.debug('线路地址探活判死，继续探下一条', {
          lineId: line.id,
          lineName: line.name,
          status: live.status,
        });
        continue;
      }

      // `unknown`（超时 / CORS 挡住的裸读）不泼脏水，退回旧口径：以 resolvePlay 耗时记成功
      lineHealthService.recordSuccess(key, live.verdict === 'alive' ? live.latencyMs : resolveMs);
      successLineId = line.id;
      logger.debug('线路探测成功', {
        lineId: line.id,
        lineName: line.name,
        resolveMs,
        liveness: live.verdict,
        latencyMs: live.latencyMs,
      });
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
