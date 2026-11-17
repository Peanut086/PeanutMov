/**
 * 播放黑匣子（BB-01）
 *
 * G3 会话恢复解决"回到哪个页面"，历史进度解决"看到第几秒"，但两者拼不出
 * **一次播放的完整上下文**：进程被 ROM 杀掉时，正在播的线路、集号、位置、倍速
 * 分属三个存储，任何一环错位（典型：线路条目 id 变化导致历史按 episodeId 匹配
 * 失败）都会把"接着放"降级成"从头放第 1 集"。
 *
 * 黑匣子在播放中周期性（30s）落一份原子快照到独立 kv 键，播放页重建时按
 * **集号**（而不是随线路漂移的 episodeId）锚定恢复点。
 *
 * 生命周期：
 * - 写：播放页存活期间周期写 + 卸载补写一次（位置落到退出瞬间）；
 * - 清：隐私开关（`pauseHistoryRecording`）打开、TTL 过期；
 *   正常退出播放页**不清**——用户"看完退出，下次回来直接续播这一集"正是黑匣子
 *   要覆盖的场景（history 按 episodeId 匹配，线路条目刷新换 id 就失效，黑匣子按集号锚）；
 *   "已看完"不需要专门删除入口：读侧（PlayerView）沿用 history 的首尾比例闸门，
 *   ratio ≥ 0.95 的快照不会被当作续播点；
 * - TTL 与 G3 同为 12h——跨一夜就不再是"刚才那集"。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { settingsService } from '@/services/settingsService';
import { KV_KEY_PLAYBACK_BLACKBOX } from '@/shared/constants';
import { logger } from '@/shared/logger';
import type { PlaybackRate } from '@/types';

export interface BlackboxSnapshot {
  mediaId: string;
  /** 集号锚：跨线路稳定的恢复键；电影/单集为 null（位置仍按 mediaId 恢复） */
  episodeNumber: number | null;
  lineId: string | null;
  positionSec: number;
  durationSec: number;
  rate: PlaybackRate;
  at: number;
}

/** 与 G3 会话快照同口径：一夜之内才算"接着放" */
export const BLACKBOX_TTL_MS = 12 * 60 * 60 * 1000;
/** 周期写间隔：进度已由 history 每 ~5s 落库，这里只补"集号+线路+倍速"的上下文，30s 足够 */
export const BLACKBOX_WRITE_INTERVAL_MS = 30_000;

const RATE_WHITELIST: readonly PlaybackRate[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

let lastWriteAt = 0;

/** 存储读回的内容不可信：形状不符/越界一律按"没有快照"处理 */
function normalize(raw: unknown): BlackboxSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.mediaId !== 'string' || c.mediaId.length === 0) return null;
  const at = typeof c.at === 'number' ? c.at : 0;
  if (!at || at > Date.now() || Date.now() - at > BLACKBOX_TTL_MS) return null;
  const positionSec = typeof c.positionSec === 'number' && Number.isFinite(c.positionSec) ? Math.max(0, c.positionSec) : 0;
  const durationSec = typeof c.durationSec === 'number' && Number.isFinite(c.durationSec) ? c.durationSec : 0;
  if (durationSec <= 0) return null;
  if (positionSec > durationSec + 60) return null;
  const episodeNumber =
    typeof c.episodeNumber === 'number' && Number.isInteger(c.episodeNumber) && c.episodeNumber > 0
      ? c.episodeNumber
      : null;
  return {
    mediaId: c.mediaId,
    episodeNumber,
    lineId: typeof c.lineId === 'string' && c.lineId.length > 0 ? c.lineId : null,
    positionSec,
    durationSec,
    rate: RATE_WHITELIST.includes(c.rate as PlaybackRate) ? (c.rate as PlaybackRate) : 1,
    at,
  };
}

/**
 * 播放页周期调用：30s 节流 + 隐私开关短路；卸载时以 `force` 补写退出瞬间的位置。
 * 写失败静默（黑匣子是体验增强，绝不能反过来干扰播放）。
 */
export async function notePlayback(
  snap: Omit<BlackboxSnapshot, 'at'>,
  opts?: { force?: boolean; now?: number },
): Promise<boolean> {
  const now = opts?.now ?? Date.now();
  if (!opts?.force && now - lastWriteAt < BLACKBOX_WRITE_INTERVAL_MS) return false;
  try {
    const settings = await settingsService.get();
    if (settings.pauseHistoryRecording) return false;
    lastWriteAt = now;
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap, at: now });
    return true;
  } catch (e) {
    logger.debug('黑匣子快照写入失败', { error: (e as Error)?.message });
    return false;
  }
}

/** 起播前读取（不删除：同一集内多次重建加载都可能要用）；不匹配/过期/隐私开启返回 null */
export async function peekBlackbox(mediaId: string): Promise<BlackboxSnapshot | null> {
  try {
    const settings = await settingsService.get();
    if (settings.pauseHistoryRecording) {
      await clearBlackbox();
      return null;
    }
    const stored = await kvRepo.get<unknown>(KV_KEY_PLAYBACK_BLACKBOX);
    const snapshot = normalize(stored);
    if (!snapshot || snapshot.mediaId !== mediaId) return null;
    return snapshot;
  } catch (e) {
    logger.debug('黑匣子快照读取失败', { error: (e as Error)?.message });
    return null;
  }
}

/** 播完/隐私开关触发清除（TTL 兜底所有漏删场景） */
export async function clearBlackbox(): Promise<void> {
  lastWriteAt = 0;
  try {
    await kvRepo.delete(KV_KEY_PLAYBACK_BLACKBOX);
  } catch {
    /* 删除失败等下次 peek 的 TTL/形状判定兜底 */
  }
}

/** 测试辅助：重置模块级节流状态 */
export function __resetBlackbox(): void {
  lastWriteAt = 0;
}
