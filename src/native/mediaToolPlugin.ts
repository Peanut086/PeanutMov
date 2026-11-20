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
    /**
     * 清单/判定给出的输入容器。原生只对 `fmp4` 做分流（回 `skipped: fmp4-passthrough`，
     * 不动文件），其余值一律按盘上实况探测，所以照实报判定结果，不把 `other` 说成 `ts`。
     */
    container?: 'ts' | 'fmp4' | 'mp4' | 'other';
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
    /** P0-3：交付件复检结论。`pass` 才能删输入；其余值形如 `duration-drift-72`、`tail-seek-miss` */
    probeVerdict?: string;
    /** P0-3：输入（TS）此刻是否还在盘上。只有 `probeVerdict === 'pass'` 时才可能被删 */
    inputRetained?: boolean;
    tracks?: Array<{ type: string; mime: string; width?: number; height?: number; channels?: number; sampleRate?: number }>;
  }>;
  /** 取消进行中的转封装并清理 `.mp4.part` */
  cancelRemux(options: { taskId?: string; inputPath?: string }): Promise<{ canceled: boolean }>;
  /** P0-3：独立复检盘上产物（开机对账 / 采纳孤儿 MP4 前），`path` 同上口径 */
  verifyMedia(options: { path: string }): Promise<MediaVerifyResult>;
  /**
   * A-03：从本地文件抽进度条预览帧。
   * `path` 是相对 `Directory.Data` 的路径（与 `remuxMp4` 同一口径，不接受绝对路径）。
   */
  extractFrames(options: {
    path: string;
    timesMs: number[];
    maxEdge?: number;
    quality?: number;
  }): Promise<{ frames: Array<{ index: number; timeMs: number; dataUrl: string }> }>;
  /** FIX-PLAY-C3：离线 TS 文件对齐自检（`path` 同上口径） */
  scanTs(options: { path: string }): Promise<TsScanResult>;
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

/**
 * A-03：抽一批进度条预览帧。
 *
 * 返回 `null` 表示"这条源没有预览帧"（Web / 旧 APK / 插件报错 / 一帧都没取到），
 * 调用方据此退回纯时间气泡；返回数组时下标与 `timesMs` 对齐，缺帧为 `null`。
 *
 * 这里不排队：同一时刻只允许一路抽帧在跑，由调用方（`useSeekThumbnails`）负责合并请求。
 */
export async function extractSeekFrames(
  path: string,
  timesMs: number[],
  maxEdge = 128,
  quality = 60,
): Promise<(string | null)[] | null> {
  if (!isMediaToolAvailable() || timesMs.length === 0) return null;
  try {
    const result = await MediaTool.extractFrames({ path, timesMs, maxEdge, quality });
    const slots: (string | null)[] = new Array(timesMs.length).fill(null);
    let hit = 0;
    for (const frame of result.frames ?? []) {
      if (!frame || typeof frame.dataUrl !== 'string') continue;
      if (frame.index < 0 || frame.index >= slots.length) continue;
      slots[frame.index] = frame.dataUrl;
      hit += 1;
    }
    return hit === 0 ? null : slots;
  } catch (e) {
    logger.debug('MediaTool.extractFrames 不可用（忽略）', { error: (e as Error)?.message ?? String(e) });
    return null;
  }
}

/* ---------- P0-3：交付件复检 ---------- */

export interface MediaVerifyResult {
  ok: boolean;
  /** `pass` / `missing` / `no-tracks` / `no-video-track` / `no-duration` / `duration-drift-NN` / `head-seek-miss` / `middle-seek-miss` / `tail-seek-miss` / `probe-error-Xxx` */
  probeVerdict: string;
  outputBytes: number;
}

/**
 * 对盘上产物做一次独立复检：容器、有效轨道、时长、首/中/尾定位。
 *
 * 与 `scanTsFile` 同一口径——只有"能力缺席"（Web / 旧 APK 未注册 `verifyMedia`）才返回 `null`，
 * 文件缺失或结构不合格是有效结论（`ok: false`），调用方必须据此放弃采纳该文件。
 */
export async function verifyRemuxedMedia(path: string): Promise<MediaVerifyResult | null> {
  if (!isMediaToolAvailable()) return null;
  try {
    const result = await MediaTool.verifyMedia({ path });
    if (typeof result?.probeVerdict !== 'string') return null;
    return {
      ok: result.ok === true && result.probeVerdict === 'pass',
      probeVerdict: result.probeVerdict,
      outputBytes: Number.isFinite(result.outputBytes) ? result.outputBytes : 0,
    };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (/not implemented|unimplemented|method/i.test(message)) {
      logger.debug('MediaTool.verifyMedia 不可用（旧 APK）', { error: message });
      return null;
    }
    throw e;
  }
}

/**
 * 转封装结果里读复检结论；旧 APK 没这个字段时返回 `null`，
 * 调用方按"未经校验的产物"处理——宁可留着 TS，也不删掉唯一可播的原件。
 */
export function probeVerdictOf(result: { probeVerdict?: string } | null | undefined): string | null {
  return typeof result?.probeVerdict === 'string' && result.probeVerdict ? result.probeVerdict : null;
}

/* ---------- FIX-PLAY-C3：离线 TS 文件自检 ---------- */

export interface TsScanResult {
  ok: boolean;
  /** ok=健康；not-ts=找不到 TS 同步结构；corrupt=存在错位/污染包；truncated=尾部残包；prefix=头部混入非 TS 前缀 */
  verdict: 'ok' | 'not-ts' | 'corrupt' | 'truncated' | 'prefix';
  fileSize: number;
  packetSize: number;
  /** 扫描采用的对齐起点字节（正常应为 0） */
  alignedStart: number;
  totalPackets: number;
  badPackets: number;
  /** 第一个同步失败包的绝对偏移（-1 表示没有） */
  firstBadOffset: number;
  /** 最后一个完整包之后剩余的字节数 */
  tailBytes: number;
}

/**
 * 对已完成下载的 .ts 产物做包级对齐扫描。
 *
 * 与 `extractSeekFrames` 不同：这里插件的显式失败（文件缺失/读错误）会向上抛，
 * 入口是用户主动点「文件自检」，静默吞错只会让人以为文件没问题。
 * 返回 `null` 仅表示能力不可用（Web / 旧 APK 未注册 `scanTs`）。
 */
export async function scanTsFile(path: string): Promise<TsScanResult | null> {
  if (!isMediaToolAvailable()) return null;
  try {
    return await MediaTool.scanTs({ path });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    // 旧 APK 上方法未实现：按能力缺席处理，不冒充文件损坏
    if (/not implemented|unimplemented|method/i.test(message)) {
      logger.debug('MediaTool.scanTs 不可用（旧 APK）', { error: message });
      return null;
    }
    throw e;
  }
}

/** 自检结论 → 一句人话（数字口径与 `TsScanResult` 字段一致，供 UI 直接展示） */
export function describeTsScan(r: TsScanResult): string {
  const size = `${(r.fileSize / 1048576).toFixed(1)} MB`;
  if (r.verdict === 'ok') {
    const packet = r.packetSize === 188 ? '' : `，包长 ${r.packetSize} 字节`;
    return `文件结构健康：${size}，共 ${r.totalPackets} 个 TS 包${packet}`;
  }
  if (r.verdict === 'not-ts') {
    return `没找到 MPEG-TS 同步结构（${size}）——这个文件不是标准 TS 分片数据`;
  }
  if (r.verdict === 'corrupt') {
    return `发现 ${r.badPackets}/${r.totalPackets} 个包同步异常，首处坏包在偏移 ${r.firstBadOffset} 字节（${size}）`;
  }
  if (r.verdict === 'truncated') {
    return `文件被截断：最后一个完整包之后只剩 ${r.tailBytes} 字节（${size}）`;
  }
  return `文件头部混入 ${r.alignedStart} 字节非 TS 数据，其余按 TS 对齐正常（${size}）`;
}

/**
 * P0-4：复检结论 → 一句人话（与 `describeTsScan` 并列的另一件工具）。
 *
 * fMP4 线路的下载产物按约定仍叫 `.ts`（见 `extensionOf`），拿包级 TS 扫描去查它只会得到
 * 一句错的结论——「这个文件不是标准 TS 分片数据」。这类文件要说的是容器与定位，走 `verifyMedia`。
 */
export function describeMediaVerify(r: MediaVerifyResult): string {
  const size = `${(r.outputBytes / 1048576).toFixed(1)} MB`;
  if (r.ok) return `容器、轨道与首中尾定位都正常（${size}）`;
  const v = r.probeVerdict;
  if (v === 'missing') return `文件读不到了（记账 ${size}）——产物已不在盘上`;
  if (v === 'no-tracks' || v === 'no-video-track') return `解不出可用的视频轨道（${size}）——这份产物播不了`;
  if (v === 'no-duration') return `读不到时长（${size}）——时间轴信息缺失`;
  if (v.startsWith('duration-drift-')) return `时长与记账偏差 ${v.slice('duration-drift-'.length)}，可能缺了尾部内容（${size}）`;
  if (v.endsWith('-seek-miss')) {
    const phase = v.slice(0, v.indexOf('-'));
    const where = phase === 'head' ? '开头' : phase === 'middle' ? '中间' : phase === 'tail' ? '结尾' : phase;
    return `定位不到${where}的采样点（${size}）——时间轴大概率损坏`;
  }
  if (v.startsWith('probe-error-')) return `解封装探测报错 ${v.slice('probe-error-'.length)}（${size}）`;
  return `复检未通过：${v}（${size}）`;
}
