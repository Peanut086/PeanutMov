/**
 * `MediaTool` 插件 JS 桥（API-17 / API-18）
 *
 * 后端（Android）实现 `MediaToolPlugin`（转封装 + 存储查询 + 原生限速）。
 * 前端只做**能力探测 + 调用 + 降级**：
 * - 插件未注册（Web / 旧 APK）→ `isAvailable()` 为 false，所有调用返回 `null`/直接跳过；
 * - 任何异常都不向 UI 抛出，交由调用方按"能力不可用"处理（§6.3 降级矩阵）。
 *
 * 注意：本文件不得推断落地 URL、不得记录路径以外的敏感信息（§6.4）。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';

export interface MediaToolPlugin {
  /** 查询可用剩余空间（相对 `Directory.Data` 的路径，缺省 `downloads`） */
  getStorageInfo(options?: { path?: string }): Promise<{ freeBytes: number; totalBytes: number; appBytes: number }>;
  /** 设置原生进程内令牌桶额度（0 = 不限速，负数非法） */
  setSpeedLimit(options: { bytesPerSec: number }): Promise<{ bytesPerSec: number; appliedAt: number }>;
  /** TS/fMP4 → MP4 无损转封装（FR-60，后端执行） */
  remuxMp4(options: {
    inputPath: string;
    outputPath: string;
    taskId?: string;
    container?: 'ts' | 'fmp4';
    deleteInput?: boolean;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    success?: boolean; // 向后兼容，已废弃
    skipped: boolean;
    outputPath?: string;
    inputPath?: string;
    taskId?: string;
    durationMs?: number;
    durationUs?: number;
    container?: string;
    inputBytes?: number;
    outputBytes?: number;
    code?: string;
    reason?: string;
    tracks?: Array<{ type: string; mime: string; width?: number; height?: number; channels?: number; sampleRate?: number }>;
  }>;
  /** 取消进行中的转封装并清理 `.mp4.part` */
  cancelRemux(options: { taskId?: string; inputPath?: string }): Promise<{ canceled: boolean }>;
  /** 转封装进度（≤2 次/秒，按 `inputPath` 归属） */
  addListener(
    eventName: 'remuxProgress',
    listenerFunc: (info: { taskId?: string; inputPath?: string; outputPath?: string; processedUs: number; durationUs: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const MediaTool = registerPlugin<MediaToolPlugin>('MediaTool');

/** 插件是否已注册（Web / 旧 APK 为 false） */
export function isMediaToolAvailable(): boolean {
  if (!isNative()) return false;
  try {
    return Capacitor.isPluginAvailable('MediaTool');
  } catch {
    return false;
  }
}

export interface StorageInfo {
  freeBytes: number;
  totalBytes: number;
  appBytes: number;
}

/**
 * 查询可用空间：原生优先，Web 用 `navigator.storage.estimate()` 兜底。
 * 完全取不到时返回 `null`（预检按"无法判定"放行，不误阻断）。
 */
export async function getStorageInfo(path = 'downloads'): Promise<StorageInfo | null> {
  if (isMediaToolAvailable()) {
    try {
      const info = await MediaTool.getStorageInfo({ path });
      if (Number.isFinite(info.freeBytes) && info.freeBytes >= 0) {
        return {
          freeBytes: info.freeBytes,
          totalBytes: Math.max(0, info.totalBytes ?? 0),
          appBytes: Math.max(0, info.appBytes ?? 0),
        };
      }
    } catch (e) {
      logger.debug('MediaTool.getStorageInfo 失败，回退平台估算', {
        error: (e as Error)?.message ?? String(e),
      });
    }
  }
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const quota = Number(estimate.quota ?? 0);
      const usage = Number(estimate.usage ?? 0);
      const free = Math.max(0, quota - usage);
      return { freeBytes: free, totalBytes: quota, appBytes: usage };
    } catch (e) {
      logger.debug('storage.estimate 不可用', { error: (e as Error)?.message ?? String(e) });
    }
  }
  return null;
}

/** 下发原生限速额度（Android）；不可用/失败时静默跳过，JS 侧桶仍生效 */
export async function applyNativeSpeedLimit(bytesPerSec: number): Promise<boolean> {
  if (!isMediaToolAvailable()) return false;
  try {
    await MediaTool.setSpeedLimit({ bytesPerSec: Number.isFinite(bytesPerSec) ? Math.max(0, bytesPerSec) : 0 });
    return true;
  } catch (e) {
    logger.debug('MediaTool.setSpeedLimit 不可用（忽略）', { error: (e as Error)?.message ?? String(e) });
    return false;
  }
}
