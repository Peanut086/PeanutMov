/**
 * P0-3：转封装交付的可回滚编排（新下载与存量迁移共用一套判定）。
 *
 * 交付顺序固定为「复检 → 落库 → 删输入」，任何一步停下都还留着一份可引用的产物：
 * - 复检不通过：原生已丢弃坏 `.mp4`、`.ts` 保留，记录仍指 `.ts`；
 * - 落库失败：`.mp4` 在盘上但没人引用它，`.ts` 与记录都不动，开机对账会来认领；
 * - 删输入失败：记录已指 `.mp4`，`.ts` 多占一份空间，开机对账负责补删。
 *
 * 之所以把判定抽到这里：`hlsDownloader`（新下载）与 `offlineRemuxMigration`（存量迁移）
 * 各自接的是不同的持久化 API（`saveProgress` 补丁 / `downloadRepo.save` 整条），
 * 但「这次转封装该怎么记账、能不能删原件」必须只有一个口径。
 */
import { isMediaToolAvailable, probeVerdictOf, verifyRemuxedMedia } from '@/native/mediaToolPlugin';
import { renameFile } from '@/native/fs';
import type { DownloadContainer, DownloadRemuxInfo, DownloadRemuxOutcome, DownloadTask } from '@/types';
import { logger } from '@/shared/logger';

/** 原生 `remuxMp4` 返回里与交付有关的字段（异常路径没有这些字段，故全部可选） */
export interface RemuxResultLike {
  ok?: boolean;
  skipped?: boolean;
  code?: string;
  reason?: string;
  durationMs?: number;
  outputBytes?: number;
  probeVerdict?: string;
}

/** 一次转封装的处置结论：怎么落库 + 能不能交付 MP4 */
export interface RemuxDecision {
  status: DownloadRemuxInfo['status'];
  outcome: DownloadRemuxOutcome;
  /** 写进记录的 reason（原生原文优先） */
  reason?: string;
  probeVerdict?: string;
  /** true = 复检通过的 `.mp4` 可以成为成品（仍要求先落库后删输入） */
  deliverable: boolean;
}

/** 交付结果：调用方据此决定「占位判废要删哪一份」以及阶段事件 */
export interface RemuxDelivery extends RemuxDecision {
  /** 此刻记录所引用、且盘上存在的那份产物 */
  deliveredPath: string;
  /** 交付推进到了哪一步 */
  phase: 'none' | 'published' | 'committed' | 'input-cleaned';
  /** 输入 `.ts` 是否还在（只有复检通过且删除成功才为 false） */
  inputRetained: boolean;
}

/** 桥接层双结算 / 超时器抢跑这类异常：转封装到底成没成未知，先按失败落账，交给开机对账认盘 */
function classifyThrown(error: unknown): { code?: string; reason?: string } {
  const message = error instanceof Error ? error.message || String(error) : String(error);
  if (/cancel/i.test(message)) return { code: 'E_CANCELED', reason: message };
  if (/timeout|timed\s*out/i.test(message)) return { code: 'E_TIMEOUT', reason: message };
  return { reason: message };
}

/**
 * 把一次转封装的结局（返回值或异常）折算成处置结论。
 *
 * `probeVerdict` 缺失（旧 APK / Web / 桥接异常）一律**不**当作通过：宁可让 `.ts` 继续做成品，
 * 也不把一份没验证过的 `.mp4` 提升成唯一可引用产物。
 */
export function decideRemuxDelivery(input: {
  result?: RemuxResultLike | null;
  error?: unknown;
}): RemuxDecision {
  if (input.error !== undefined && input.error !== null) {
    const shape = classifyThrown(input.error);
    return {
      status: 'failed',
      outcome: shape.code === 'E_CANCELED' ? 'canceled' : shape.code === 'E_TIMEOUT' ? 'timeout' : 'failed',
      reason: shape.reason,
      deliverable: false,
    };
  }

  const result = input.result ?? {};
  const verdict = probeVerdictOf(result);

  if (result.skipped) {
    return {
      status: 'skipped',
      outcome: 'skipped',
      reason: result.reason ?? result.code,
      deliverable: false,
    };
  }

  if (result.ok !== true) {
    const reason = result.reason ?? result.code;
    if (result.code === 'E_CANCELED') return { status: 'failed', outcome: 'canceled', reason, deliverable: false };
    if (result.code === 'E_TIMEOUT') return { status: 'failed', outcome: 'timeout', reason, deliverable: false };
    if (typeof reason === 'string' && reason.startsWith('verify-failed')) {
      return { status: 'failed', outcome: 'verify-failed', reason, probeVerdict: verdict ?? reason, deliverable: false };
    }
    return { status: 'failed', outcome: 'failed', reason, deliverable: false };
  }

  // ok=true：只有复检明确通过才交付
  if (verdict === null) {
    return {
      status: 'failed',
      outcome: 'unverified',
      reason: 'unverified-capability',
      deliverable: false,
    };
  }
  if (verdict !== 'pass') {
    return {
      status: 'failed',
      outcome: 'verify-failed',
      reason: `verify-failed:${verdict}`,
      probeVerdict: verdict,
      deliverable: false,
    };
  }
  return {
    status: 'done',
    outcome: 'done',
    reason: undefined,
    probeVerdict: 'pass',
    deliverable: true,
  };
}

/** 失败档的落库内容：`filePath` 一律不碰，记录继续指着能播的那份 */
export function remuxFailurePatch(decision: RemuxDecision, durationMs?: number): Partial<DownloadTask> {
  const info: DownloadRemuxInfo = { status: decision.status };
  if (decision.reason !== undefined && decision.reason !== null) info.reason = decision.reason;
  info.outcome = decision.outcome;
  if (decision.probeVerdict !== undefined) info.probeVerdict = decision.probeVerdict;
  if (durationMs !== undefined) info.durationMs = durationMs;
  return { remux: info };
}

export interface RemuxDeliveryDeps {
  /** 落库一条下载记录的补丁（新下载用 `saveProgress`，迁移用 `downloadRepo.save`） */
  update: (patch: Partial<DownloadTask>) => Promise<void>;
  /** 删除输入 `.ts`；只在复检通过且记录已改指 `.mp4` 之后被调用 */
  removeInput: () => Promise<void>;
}

/**
 * 按 P0-3 顺序交付一次转封装结果，并落库对应账目。
 *
 * 落库失败不向外抛：转封装的任何问题都不该把已下好的视频判成下载失败（OPT-05 口径），
 * 但要把 `db-commit-failed` 记进日志——此时盘上有两份产物、记录只认 `.ts`。
 */
export async function deliverRemux(args: {
  taskId: string;
  inputPath: string;
  outputPath: string;
  inputBytes: number;
  decision: RemuxDecision;
  result?: RemuxResultLike | null;
  /** 记录上当前的转封装账目：发布标记只在它上面追加阶段字段，不改 `status` */
  previousRemux?: DownloadRemuxInfo | null;
  /**
   * P0-4：交付件写进记录的容器名。
   *
   * 缺省 `'mp4'`（TS 转封装的产物）。fMP4 走「只改名不转码」那条交付路时传 `'fmp4'`，
   * 这样记录上的容器名与清单声明一致，不必等下一层再从扩展名猜回来。
   */
  container?: DownloadContainer;
  deps: RemuxDeliveryDeps;
}): Promise<RemuxDelivery> {
  const { taskId, inputPath, outputPath, inputBytes, decision, deps } = args;
  const durationMs = args.result?.durationMs;

  if (!decision.deliverable) {
    let dbCommit = true;
    try {
      await deps.update(remuxFailurePatch(decision, durationMs));
    } catch (persistErr) {
      dbCommit = false;
      logger.warn('P0-3：转封装处置结论落库失败（记录保持原样）', {
        taskId,
        outcome: decision.outcome,
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }
    // 未交付的每一轮都要留一行完整读数：排障时要能一眼看出是哪一档、原件还在不在、账落没落
    logger.warn('P0-3：转封装未交付，输入保留', {
      taskId,
      phase: 'none',
      outcome: decision.outcome,
      code: args.result?.code,
      reason: decision.reason,
      probeVerdict: decision.probeVerdict,
      inputPath,
      inputExists: true,
      dbCommit,
    });
    return { ...decision, deliveredPath: inputPath, phase: 'none', inputRetained: true };
  }

  const outputBytes = args.result?.outputBytes ?? inputBytes;
  const deliveredContainer: DownloadContainer = args.container ?? 'mp4';
  const committedInfo: DownloadRemuxInfo = {
    status: 'done',
    outcome: 'done',
    probeVerdict: 'pass',
    delivery: 'committed',
    mp4Path: outputPath,
    ...(durationMs === undefined ? {} : { durationMs }),
  };

  // 发布与改指之间先留一枚阶段标记：崩在这里时，开机对账能凭它（或 `.ts`→`.mp4` 同名约定）
  // 找到那份没被任何记录引用的成品。这一笔写不成也不影响安全——记录仍指 `.ts`。
  await deps
    .update({ remux: { ...(args.previousRemux ?? { status: 'none' }), delivery: 'published', mp4Path: outputPath } })
    .catch(() => undefined);

  try {
    // 先原子改指 `.mp4`：这一步失败就当作没交付，`.ts` 绝不删
    await deps.update({
      filePath: outputPath,
      format: 'mp4',
      container: deliveredContainer,
      downloadedBytes: outputBytes,
      totalBytes: outputBytes,
      remux: committedInfo,
    });
  } catch (persistErr) {
    logger.error('P0-3：交付落库失败，保留两份产物且记录仍指 .ts', {
      taskId,
      inputPath,
      outputPath,
      outcome: 'db-commit-failed',
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
    return {
      status: 'failed',
      outcome: 'db-commit-failed',
      reason: `db-commit-failed:${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
      probeVerdict: 'pass',
      deliverable: false,
      deliveredPath: inputPath,
      phase: 'published',
      inputRetained: true,
    };
  }

  logger.info('P0-3：MP4 交付落库完成', {
    taskId,
    phase: 'committed',
    outputPath,
    outputBytes,
    probeVerdict: 'pass',
    inputExists: true,
    dbCommit: true,
  });

  // 落库成功之后才清输入
  let inputRetained = true;
  try {
    await deps.removeInput();
    inputRetained = false;
  } catch (removeErr) {
    logger.warn('P0-3：复检通过但 .ts 清理失败（多占一份空间，开机对账补删）', {
      taskId,
      inputPath,
      error: removeErr instanceof Error ? removeErr.message : String(removeErr),
    });
  }

  if (!inputRetained) {
    try {
      await deps.update({ remux: { ...committedInfo, delivery: 'input-cleaned' } });
    } catch {
      /* 只影响「对账要不要补删」这一条优化信息，交付本身已完成 */
    }
  }

  return {
    ...decision,
    deliveredPath: outputPath,
    phase: inputRetained ? 'committed' : 'input-cleaned',
    inputRetained,
  };
}

/** 失败/未验证档的落库（供调用方在异常分支直接用，口径与 `deliverRemux` 一致） */
export async function recordRemuxFailure(
  decision: RemuxDecision,
  deps: { update: (patch: Partial<DownloadTask>) => Promise<void> },
  durationMs?: number,
): Promise<void> {
  try {
    await deps.update(remuxFailurePatch(decision, durationMs));
  } catch (persistErr) {
    logger.warn('P0-3：转封装处置结论落库失败（记录保持原样）', {
      outcome: decision.outcome,
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
  }
}

/**
 * P0-4：只改名不转码的那一路（fMP4 产物）。
 *
 * 分片字节本来就是 MP4 家族，请原生转封装只会拿到一句 `skipped: fmp4-passthrough`
 * （它对 fMP4 不做任何文件操作）；把一份没验证过的文件提升成唯一产物又正是 P0-3 要拦的事。
 * 所以这里跑「复检 → 改名 → 落库」：验证通过才把交付名改指 `.mp4`，
 * 不通过或能力缺席就原样留着 `.ts`，交给播放侧按容器名选解码器。
 * 崩在改名与落库之间由开机对账（情形 1）按同名约定认领。
 *
 * 输入与交付件是同一份字节，所以 `removeInput` 是空操作——没有第二份产物要清。
 */
export async function deliverRenamedArtifact(args: {
  taskId: string;
  inputPath: string;
  outputPath: string;
  inputBytes: number;
  previousRemux?: DownloadRemuxInfo | null;
  /** 交付进记录的容器名，默认 `fmp4` */
  container?: DownloadContainer;
  deps: Pick<RemuxDeliveryDeps, 'update'>;
}): Promise<RemuxDelivery> {
  const container: DownloadContainer = args.container ?? 'fmp4';
  const verdict = await verifyRemuxedMedia(args.inputPath).catch(() => null);
  // 转码这一步没跑，但「产物能不能当成品」仍然只有复检一个口径：拿验证结果交付
  let decision = decideRemuxDelivery({
    result: {
      ok: true,
      ...(verdict ? { probeVerdict: verdict.probeVerdict, outputBytes: verdict.outputBytes } : {}),
    },
  });
  if (decision.deliverable) {
    try {
      await renameFile(args.inputPath, args.outputPath);
    } catch (renameErr) {
      decision = { status: 'failed', outcome: 'failed', reason: 'rename-failed', deliverable: false };
      logger.warn('P0-4：交付改名失败，产物保持原名', {
        taskId: args.taskId,
        error: renameErr instanceof Error ? renameErr.message || String(renameErr) : String(renameErr),
      });
    }
  }
  return deliverRemux({
    ...args,
    container,
    decision,
    result: verdict ? { outputBytes: verdict.outputBytes } : null,
    deps: { update: args.deps.update, removeInput: async () => undefined },
  });
}

/* ---------- 开机对账 ---------- */

/** 单轮对账上限：每条要一次解码器探测，别让它挤占启动 */
export const REMUX_RECONCILE_LIMIT = 12;

export interface RemuxReconcileDeps {
  /** 已完成、产物落在原生文件系统上的任务 */
  list: () => Promise<DownloadTask[]>;
  update: (taskId: string, patch: Partial<DownloadTask>) => Promise<void>;
  remove: (path: string) => Promise<void>;
  sizeOf: (path: string) => Promise<number | null>;
  verify?: (path: string) => Promise<{ ok: boolean; probeVerdict: string; outputBytes: number } | null>;
}

export interface RemuxReconcileSummary {
  checked: number;
  /** 记录指 `.ts`、盘上有复检通过的孤儿 `.mp4`：改指它 */
  adopted: number;
  /** 复检不过的孤儿 `.mp4`：删掉（没有任何记录引用它） */
  discarded: number;
  /** 记录指 `.mp4` 但那一份坏了/没了：退回 `.ts` */
  repaired: number;
  /** 已交付、`.ts` 是上次没删干净的残件：补删 */
  cleaned: number;
  /** 只记结论、不动产物（既没有原件也没有可退回的对象） */
  noted: number;
}

function sibling(inputPath: string, from: RegExp, to: string): string | null {
  const swapped = inputPath.replace(from, to);
  return swapped === inputPath ? null : swapped;
}

/**
 * P0-3 开机对账：凭盘上实况 + 复检结论，把交付推进到「要么有可引用的原件，要么有验证过的成品」。
 *
 * 只处理交付这一步可能被打断的两类记录：
 * 1. 记录仍指 `.ts`，但同目录已有 `.mp4`（崩在发布与落库之间）——复检通过就认领，不过就删掉那份没被引用的 `.mp4`；
 * 2. 记录指 `.mp4`，而那一份坏了或没了（旧 `deleteInput` 时代留下的原件已被删）——有 `.ts` 就退回，
 *    没有就只把复检结论写进记录，**绝不删唯一剩下的产物**，也绝不把这条判成需要重下。
 */
export async function reconcileRemuxDeliveries(deps: RemuxReconcileDeps): Promise<RemuxReconcileSummary> {
  const summary: RemuxReconcileSummary = { checked: 0, adopted: 0, discarded: 0, repaired: 0, cleaned: 0, noted: 0 };
  const verify = deps.verify ?? verifyRemuxedMedia;
  if (!verify) return summary;

  const tasks = await deps.list().catch((e: unknown) => {
    logger.warn('P0-3：交付对账取任务失败（跳过本轮）', { error: e instanceof Error ? e.message : String(e) });
    return [] as DownloadTask[];
  });

  // 已清理过输入的记录无需再探测；其余按最近更新的先处理（崩在交付环节的更可能是这一批）
  const pending = tasks
    .filter((task) => typeof task.filePath === 'string' && task.filePath.length > 0)
    .filter((task) => task.remux?.delivery !== 'input-cleaned')
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, REMUX_RECONCILE_LIMIT);

  for (const task of pending) {
    const filePath = task.filePath as string;
    summary.checked += 1;
    const recordPointsToMp4 = /\.mp4$/i.test(filePath);
    const tsPath = recordPointsToMp4 ? sibling(filePath, /\.mp4$/i, '.ts') : filePath;
    const mp4Path = recordPointsToMp4 ? filePath : sibling(filePath, /\.ts$/i, '.mp4') ?? task.remux?.mp4Path ?? null;

    if (!recordPointsToMp4) {
      // 情形 1：记录指 .ts，看盘上那份 .mp4 是不是上次发布完没落库的成品
      if (!mp4Path) continue;
      const size = await deps.sizeOf(mp4Path);
      if (size === null || size <= 0) continue;
      const verdict = await verify(mp4Path);
      if (verdict === null) continue; // 能力缺席（Web / 旧 APK）：不动盘上任何东西
      if (verdict.ok) {
        try {
          await deps.update(task.id, {
            filePath: mp4Path,
            format: 'mp4',
            container: 'mp4',
            downloadedBytes: verdict.outputBytes || size,
            totalBytes: verdict.outputBytes || size,
            remux: { status: 'done', outcome: 'done', probeVerdict: 'pass', delivery: 'committed' },
            updatedAt: Date.now(),
          });
          summary.adopted += 1;
          logger.info('P0-3：开机对账认领未落库的 MP4 成品', { taskId: task.id, mp4Path, bytes: size });
          if (tsPath && tsPath !== mp4Path) {
            await deps.remove(tsPath).catch(() => undefined);
            await deps
              .update(task.id, { remux: { status: 'done', outcome: 'done', probeVerdict: 'pass', delivery: 'input-cleaned' } })
              .catch(() => undefined);
            summary.cleaned += 1;
          }
        } catch (e) {
          logger.warn('P0-3：对账认领失败（记录保持指 .ts）', {
            taskId: task.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        // 那份 .mp4 没有任何记录引用，删掉它不损失内容；`.ts` 仍是成品
        await deps.remove(mp4Path).catch(() => undefined);
        summary.discarded += 1;
        await deps
          .update(task.id, {
            remux: {
              status: 'failed',
              outcome: 'verify-failed',
              reason: `verify-failed:${verdict.probeVerdict}`,
              probeVerdict: verdict.probeVerdict,
            },
          })
          .catch(() => undefined);
        logger.warn('P0-3：孤儿 MP4 复检不过，删除并保留 .ts', { taskId: task.id, mp4Path, verdict: verdict.probeVerdict });
      }
      continue;
    }

    // 情形 2：记录指 .mp4
    const mp4Size = await deps.sizeOf(mp4Path as string);
    const tsSize = tsPath ? await deps.sizeOf(tsPath) : null;

    if (mp4Size === null || mp4Size <= 0) {
      if (tsPath && tsSize !== null && tsSize > 0) {
        await deps
          .update(task.id, {
            filePath: tsPath,
            format: 'ts',
            container: 'ts',
            downloadedBytes: tsSize,
            totalBytes: tsSize,
            remux: { status: 'failed', outcome: 'failed', reason: 'artifact-missing' },
            updatedAt: Date.now(),
          })
          .catch(() => undefined);
        summary.repaired += 1;
        logger.warn('P0-3：MP4 产物丢失，记录退回 .ts', { taskId: task.id, tsPath });
      } else {
        summary.noted += 1;
        logger.warn('P0-3：MP4 产物丢失且无 .ts 原件（不删不判，交给文件自检）', { taskId: task.id, mp4Path });
      }
      continue;
    }

    const verdict = await verify(mp4Path as string);
    if (verdict === null) continue;
    if (verdict.ok) {
      if (tsPath && tsSize !== null && tsSize > 0) {
        // 交付已完成，只是上次没删掉输入
        await deps.remove(tsPath).catch(() => undefined);
        summary.cleaned += 1;
        logger.info('P0-3：补删已交付任务的 .ts 残件', { taskId: task.id, tsPath });
      }
      await deps
        .update(task.id, { remux: { ...task.remux, status: 'done', outcome: 'done', probeVerdict: 'pass', delivery: 'input-cleaned' } })
        .catch(() => undefined);
      continue;
    }
    if (tsPath && tsSize !== null && tsSize > 0) {
      await deps.remove(mp4Path as string).catch(() => undefined);
      await deps
        .update(task.id, {
          filePath: tsPath,
          format: 'ts',
          container: 'ts',
          downloadedBytes: tsSize,
          totalBytes: tsSize,
          remux: { status: 'failed', outcome: 'verify-failed', reason: `verify-failed:${verdict.probeVerdict}`, probeVerdict: verdict.probeVerdict },
          updatedAt: Date.now(),
        })
        .catch(() => undefined);
      summary.repaired += 1;
      logger.warn('P0-3：MP4 复检不过，记录退回 .ts 并删除坏件', { taskId: task.id, verdict: verdict.probeVerdict });
    } else {
      // 只剩这一份产物：只记结论，不删文件、不把任务判成需要重下
      await deps
        .update(task.id, {
          remux: { ...task.remux, status: 'failed', outcome: 'verify-failed', reason: `verify-failed:${verdict.probeVerdict}`, probeVerdict: verdict.probeVerdict },
        })
        .catch(() => undefined);
      summary.noted += 1;
      logger.warn('P0-3：MP4 复检不过且无原件可退：只记结论，产物保留', { taskId: task.id, verdict: verdict.probeVerdict });
    }
  }

  if (summary.checked > 0) {
    logger.info('P0-3：交付对账结束', { ...summary, limit: REMUX_RECONCILE_LIMIT });
  }
  return summary;
}

/** 供下载侧与迁移侧共用的能力判定 */
export function canRemuxLocally(native: boolean): boolean {
  return native && isMediaToolAvailable();
}
