/**
 * 存量离线文件优化：`.ts` → `.mp4` 无损转封装（P0-1）
 *
 * 背景：新下载链路在 HLS 合并完成后已就地转封装（`hlsDownloader`），但本次修复之前
 * 下载的离线文件仍是裸 MPEG-TS。TS 没有样本索引，ExoPlayer 每次 seek 都要
 * `TsBinarySearchSeeker` 按 PCR 二分读盘 + 回退到关键帧 + 重启硬件解码器，
 * 表现为"时间跳了、画面卡住 3~5 秒"。转成 MP4 后 seek 走 `stss` 精确定位，问题消失。
 *
 * 调度约束（都是为了让这件事对用户完全无感）：
 * - 只在 Android + `MediaTool` 插件可用时运行，Web / 旧 APK 直接返回；
 * - 启动后延迟一段时间再开跑，且每次转封装前重新确认下载队列空闲；
 * - 串行一个（插件本身就是单线程 executor），不做并行；
 * - 剩余空间不足以容纳一份同量级输出时整轮放弃，避免写到一半 E_STORAGE_QUOTA；
 * - 正在播放的那一条跳过（转封装产物会取代原件成为播放对象），留到下次启动。
 *
 * 交付顺序（P0-3）：`.part` → 复检（容器 / 有效轨道 / 时长 / 首中尾定位）→ 改指 `.mp4` 落库 →
 * 才删 `.ts`。任何一步中断都还留着一份可引用的产物，剩下的由本轮开头的对账结算。
 *
 * 幂等：迁移成功的任务 `filePath` 变成 `.mp4`，下一轮扫描不再命中；
 * 未交付的保持 `.ts` 原样，下次启动重试。
 */
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { settingsService } from '@/services/settingsService';
import { appEvents, type OfflineOptimizeSnapshot } from '@/services/events';
import { getStorageInfo, isMediaToolAvailable, MediaTool } from '@/native/mediaToolPlugin';
import {
  decideRemuxDelivery,
  deliverRemux,
  deliverRenamedArtifact,
  reconcileRemuxDeliveries,
  type RemuxDelivery,
  type RemuxResultLike,
} from '@/services/remuxDelivery';
import { deleteFile, stat } from '@/native/fs';
import { toErrorShape } from '@/shared/errors';
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';
import { isRepairableTsTask, repairLocalTsIndex } from '@/services/localTsRepair';
import type { DownloadRemuxOutcome, DownloadTask } from '@/types';

/** 启动后的静默期：让首页数据加载、起播预热先跑完 */
const FIRST_RUN_DELAY_MS = 15_000;
/** 队列占用时的重试间隔 */
const IDLE_POLL_MS = 10_000;
/** 单轮等待队列空闲的上限，超时放弃本轮（下次启动再来） */
const IDLE_WAIT_LIMIT_MS = 10 * 60_000;
/** 转封装期间文件体积可能略增，按输入体积留 15% 余量 */
const MIN_FREE_RATIO = 1.15;
/** 插件侧上限（MediaToolPlugin.MAX_TIMEOUT_MS）；存量文件普遍较大，直接给满 */
const REMUX_TIMEOUT_MS = 600_000;

export type OfflineOptimizeState = OfflineOptimizeSnapshot;

/** 当前正在播放的离线任务：迁移据此跳过，避免删掉播放中的文件 */
let inUseTaskId: string | null = null;
let runStarted = false;
/** 当前正在转封装的输入路径：原生进度事件按它归属到本轮任务 */
let activeInputPath: string | null = null;
let currentState: OfflineOptimizeState = {
  active: false,
  done: 0,
  total: 0,
  percent: 0,
  title: null,
};

/**
 * 标记"这条离线文件刚被交给播放器"。
 *
 * 只在新的本地播放开始时覆盖，不做显式清除：残留的旧 ID 最多多跳过一条任务，
 * 下一轮启动会重新处理；反过来若提前清除，就可能把正在播放的文件转封装删掉。
 */
export function markOfflineFileInUse(taskId: string): void {
  inUseTaskId = taskId;
}

export function isOfflineFileInUse(taskId: string): boolean {
  return inUseTaskId === taskId;
}

export function getOfflineOptimizeState(): OfflineOptimizeState {
  return currentState;
}

function emitState(next: Partial<OfflineOptimizeState>): void {
  currentState = { ...currentState, ...next };
  appEvents.emit('offline:optimize', currentState);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 有任务正在传输 = 不空闲（queued 只排队不占 IO，不作为阻塞条件） */
async function isQueueBusy(): Promise<boolean> {
  const running = await downloadRepo.listByStatus(['downloading']);
  return running.length > 0;
}

/** 等到队列空闲；返回等待时长（毫秒），超时放弃本轮时返回 `null` */
async function waitForQueueIdle(): Promise<number | null> {
  const startedAt = Date.now();
  for (;;) {
    if (!(await isQueueBusy())) return Date.now() - startedAt;
    if (Date.now() - startedAt > IDLE_WAIT_LIMIT_MS) return null;
    await delay(IDLE_POLL_MS);
  }
}

/** 待迁移任务：已完成、产物仍是 `.ts`、且不是正在播放的那条 */
async function listCandidates(): Promise<DownloadTask[]> {
  const completed = await downloadRepo.listByStatus(['completed']);
  return completed.filter(
    (task) => typeof task.filePath === 'string' && /\.ts$/i.test(task.filePath) && !isOfflineFileInUse(task.id),
  );
}

async function repairUnindexedTs(): Promise<void> {
  const completed = await downloadRepo.listByStatus(['completed']);
  for (const task of completed) {
    if (!isRepairableTsTask(task) || isOfflineFileInUse(task.id)) continue;
    if (await waitForQueueIdle() === null) return;
    try {
      await repairLocalTsIndex(task.id);
    } catch (e) {
      logger.warn('存量 TS 索引修复失败，保留原文件', { taskId: task.id, error: e });
    }
  }
}

type FileOutcome = 'done' | 'missing' | 'busy' | 'no-space' | DownloadRemuxOutcome;

/** 单文件迁移：复检 + 落库都通过才把记录改指 `.mp4`，输入 `.ts` 排在落库之后删 */
async function migrateOne(taskId: string): Promise<FileOutcome> {
  const task = await downloadRepo.get(taskId);
  if (!task || task.status !== 'completed') return 'missing';
  const inputPath = task.filePath;
  if (!inputPath || !/\.ts$/i.test(inputPath)) return 'missing';
  const outputPath = inputPath.replace(/\.ts$/i, '.mp4');
  if (outputPath === inputPath) return 'failed';
  if (isOfflineFileInUse(task.id)) return 'busy';

  const inputStat = await stat(inputPath).catch(() => null);
  if (!inputStat?.exists || inputStat.size <= 0) return 'missing';

  const update = async (patch: Partial<DownloadTask>): Promise<void> => {
    // 每一笔都按「当下库里的记录」叠加：`deliverRemux` 会连续写多次，
    // 用过期的 `task` 快照做底会把已经改指的 .mp4 又退回 .ts。
    const latest = await downloadRepo.get(task.id);
    if (!latest) throw new Error('记录已不存在');
    await downloadRepo.save({ ...latest, ...patch, updatedAt: Date.now() });
    appEvents.emit('downloads:changed', { id: latest.id });
  };

  /*
   * P0-4：存量文件按记录上的容器分流，和新下载同一口径。
   * fMP4 的字节本来就是 MP4 家族，请原生转封装只会拿到一句 `skipped: fmp4-passthrough`
   * （什么都不做，于是这一集永远修不好）；它走「复检 → 改名 → 落库」，
   * 连空间余量都不用留。容器尚未判定（旧记录 / 预检缺席）沿用旧口径按 TS 处理。
   */
  if (task.container === 'fmp4') {
    activeInputPath = inputPath;
    let renamed: RemuxDelivery;
    try {
      renamed = await deliverRenamedArtifact({
        taskId: task.id,
        inputPath,
        outputPath,
        inputBytes: inputStat.size,
        previousRemux: task.remux,
        container: 'fmp4',
        deps: { update },
      });
    } finally {
      activeInputPath = null;
    }
    if (renamed.outcome === 'done') {
      logger.info('存量 fMP4 已按复检结论改指 MP4 交付名', {
        taskId,
        inputBytes: inputStat.size,
        probeVerdict: 'pass',
      });
      return 'done';
    }
    return renamed.outcome ?? 'failed';
  }

  // 取不到空间信息时放行：真正的写失败会以 E_STORAGE_QUOTA 落地，输入文件不受影响
  const storage = await getStorageInfo('downloads');
  if (storage && storage.freeBytes < inputStat.size * MIN_FREE_RATIO) return 'no-space';

  let result: RemuxResultLike | null = null;
  let thrown: unknown = null;
  activeInputPath = inputPath;
  try {
    result = await MediaTool.remuxMp4({
      inputPath,
      outputPath,
      taskId: task.id,
      // P0-4：这一路只在容器是 TS / 未判定时进入，fMP4 已在上面交付
      container: 'ts',
      // P0-3：原件的删除权在 JS 侧，且排在「复检通过 + 记录改指 .mp4」之后
      deleteInput: false,
      timeoutMs: REMUX_TIMEOUT_MS,
    });
  } catch (e) {
    thrown = e;
  } finally {
    activeInputPath = null;
  }

  const decision = thrown !== null ? decideRemuxDelivery({ error: thrown }) : decideRemuxDelivery({ result });
  if (!decision.deliverable) {
    logger.warn('离线文件转封装未交付，保持 .ts', {
      taskId: task.id,
      outcome: decision.outcome,
      code: result?.code,
      reason: decision.reason,
      probeVerdict: decision.probeVerdict,
    });
  }

  const delivery = await deliverRemux({
    taskId: task.id,
    inputPath,
    outputPath,
    inputBytes: inputStat.size,
    decision,
    result,
    previousRemux: task.remux,
    deps: {
      update,
      removeInput: async () => {
        await deleteFile(inputPath);
      },
    },
  });

  if (delivery.outcome === 'done') {
    logger.info('离线文件已优化为 MP4', {
      taskId,
      inputBytes: inputStat.size,
      outputBytes: result?.outputBytes ?? inputStat.size,
      durationMs: result?.durationMs,
      inputRetained: delivery.inputRetained,
      probeVerdict: 'pass',
    });
    return 'done';
  }
  return delivery.outcome ?? 'failed';
}

/** 订阅原生转封装进度，用于 UI 百分比；插件不支持时静默降级为不确定进度 */
async function bindProgress(): Promise<() => void> {
  try {
    const handle = await MediaTool.addListener('remuxProgress', (info) => {
      if (!activeInputPath || (info.inputPath && info.inputPath !== activeInputPath)) return;
      const durationUs = info.durationUs ?? 0;
      if (durationUs <= 0) return;
      const percent = Math.min(1, Math.max(0, (info.processedUs ?? 0) / durationUs));
      if (Math.abs(percent - currentState.percent) < 0.02) return;
      emitState({ percent });
    });
    return () => void handle?.remove?.();
  } catch {
    return () => undefined;
  }
}

/**
 * 启动一次性离线文件优化（幂等，fire-and-forget）。
 *
 * 失败与中断都不上报 UI：这是纯优化，用户看不到"失败"，只会在下次播放时
 * 继续沿用旧的 `.ts` 文件。
 */
export async function runOfflineRemuxMigration(): Promise<void> {
  if (runStarted) return;
  runStarted = true;
  try {
    if (!isNative() || !isMediaToolAvailable()) return;

    await delay(FIRST_RUN_DELAY_MS);
    const bootWaitMs = await waitForQueueIdle();
    if (bootWaitMs === null) return;

    /*
     * P0-3：开机对账先跑，再开始本轮迁移。
     * 上一轮如果崩在「`.mp4` 已发布、记录还没改指」或「记录已改指、`.ts` 没删掉」之间，
     * 这里凭盘上实况 + 复检结论结算掉；否则迁移会把同一集再转封装一遍，
     * 而那条「有记账无文件 / 有文件无记账」的账也永远修不好。
     *
     * 排在设置开关之前：关掉的只是「新文件要不要转封装」，已经中断的交付照样要收口。
     */
    await reconcileRemuxDeliveries({
      list: async () =>
        (await downloadRepo.listByStatus(['completed'])).filter(
          (task) => typeof task.filePath === 'string' && /\.(ts|mp4)$/i.test(task.filePath),
        ),
      update: async (taskId, patch) => {
        const latest = await downloadRepo.get(taskId);
        if (!latest) return;
        await downloadRepo.save({ ...latest, ...patch, updatedAt: Date.now() });
        appEvents.emit('downloads:changed', { id: taskId });
      },
      remove: (path) => deleteFile(path),
      sizeOf: async (path) => {
        const info = await stat(path).catch(() => null);
        return info?.exists ? info.size : null;
      },
    });

    const settings = await settingsService.get();
    const shouldRemux = settings.download.remuxToMp4 !== false;
    const candidates = shouldRemux ? await listCandidates() : [];

    if (candidates.length > 0) {
      logger.info(`开始优化离线文件：${candidates.length} 个待转封装`, { queueWaitMs: bootWaitMs });
      const unbind = await bindProgress();
      let done = 0;
      let noSpace = false;
      emitState({ active: true, done: 0, total: candidates.length, percent: 0, title: candidates[0]?.title ?? null });

      try {
        for (const candidate of candidates) {
          // 迁移期间用户可能新建下载：每次开始前重新让路
          const queueWaitMs = await waitForQueueIdle();
          if (queueWaitMs === null) break;
          if (queueWaitMs > 0) logger.info('离线文件优化让路后重新开跑', { taskId: candidate.id, queueWaitMs });
          emitState({ done, percent: 0, title: candidate.title });
          const outcome = await migrateOne(candidate.id);
          done += 1;
          if (outcome === 'no-space') {
            noSpace = true;
            break;
          }
        }
      } finally {
        unbind();
        emitState({ active: false, done, total: candidates.length, percent: 0, title: null });
      }

      if (noSpace) {
        logger.warn('离线文件优化因空间不足提前结束', { done, total: candidates.length });
      } else {
        logger.info(`离线文件优化结束：${done}/${candidates.length}`);
      }
    }

    // 索引修复与 remux 开关无关；转封装因 B 帧等原因跳过时，也在这里补真实时间轴索引。
    await repairUnindexedTs();
  } catch (e) {
    // F11：此前只记 `e.message`——原生插件抛出的非 Error 载荷（Java 侧字符串）与堆栈全部丢失，
    // 真机上「异常退出」后无从定位是空间、权限还是插件本身。本轮只把现场留全，迁移逻辑不动。
    const shape = toErrorShape(e);
    logger.warn('离线文件优化任务异常退出（不影响播放）', {
      code: shape.code,
      message: shape.message,
      detail: shape.detail,
      kind: e instanceof Error ? e.name : typeof e,
      stack: e instanceof Error ? e.stack : String(e),
    });
  }
}
