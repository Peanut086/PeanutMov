/**
 * P0-4：任务阶段登记处（传输 / 后处理）。
 *
 * 下载看门狗原来只按 `task.updatedAt` 判停滞（`WATCHDOG_STALE_MS = 90_000`），可它在
 * 这件事上根本分不清两种"没有进度"：
 * - 传输停滞：分片确实不来了，该 abort 触发重试；
 * - 后处理进行中：转封装跑在原生单线程 executor 上，大片的 `remuxMp4` 实测要跑满
 *   几百秒，而这期间 runner 仍占着队列槽位（`queue.isActive()` 为真），于是看门狗
 *   走的是 `abortTask` 那一支——一份即将交付的转封装被当成死任务打断，重跑一遍，
 *   用户看到的就是"下载停滞（watchdog 检测）"和重复下载。
 *
 * runner 在后处理开始时把任务登记到这里，看门狗据此知道"这段时间没有字节进度是预期的"，
 * 并改用自己的截止时刻判定：登记时给出 `deadlineMs`，超过它照样按停滞处理——
 * 不能让一个卡死的原生转封装把停滞检测整条网关掉。
 *
 * 单进程内存态即可：崩溃后本来就没有在飞的后处理，重启时队列会重新登记。
 */

export type DownloadPhase = 'transfer' | 'postprocess';

interface PhaseRecord {
  phase: DownloadPhase;
  /** 进入当前阶段的时刻 */
  since: number;
  /** 本阶段允许的最长时长；超过即回到停滞判定 */
  deadlineMs: number;
  /** 人话标签（日志与「转封装中」文案） */
  label: string;
}

const records = new Map<string, PhaseRecord>();

/** 进入某个阶段；`deadlineMs` 是该阶段的硬上限（超时后看门狗照旧判停滞） */
export function beginPhase(taskId: string, phase: DownloadPhase, label: string, deadlineMs: number): void {
  records.set(taskId, { phase, since: Date.now(), deadlineMs, label });
}

/** 阶段结束（转封装返回、抛错、被取消都算结束） */
export function endPhase(taskId: string): void {
  records.delete(taskId);
}

export function getPhase(taskId: string): PhaseRecord | null {
  return records.get(taskId) ?? null;
}

/**
 * 该任务此刻是否正处在一个"有理由没有字节进度"的阶段。
 *
 * 超过登记的 `deadlineMs` 就不再免检：原生侧卡死、进度回调丢失这些真故障
 * 仍然要由看门狗收口，否则一份坏文件能永远躲过停滞检测。
 */
export function isInTrackedPostProcess(taskId: string, now: number): boolean {
  const record = records.get(taskId);
  if (!record || record.phase !== 'postprocess') return false;
  return now - record.since <= record.deadlineMs;
}

/** 测试辅助：清空登记 */
export function __resetDownloadPhases(): void {
  records.clear();
}
