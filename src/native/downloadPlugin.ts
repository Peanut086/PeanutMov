/**
 * Native 下载器插件封装（Phase 1）
 *
 * 职责：
 * - 封装 Capacitor 插件调用（start/pause/resume/cancel/getStatus）
 * - 监听插件事件（progress/stateChanged/completed/error）
 * - 提供 isAvailable() 检测原生插件是否可用
 *
 * 与 downloadEngine 集成：
 * - 优先使用 Native 下载器（速度快、支持后台）
 * - 不可用时回退到 JS 下载（IdbBlobSink / NativeFsSink）
 */
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';

export interface NativeDownloadTask {
  taskId: string;
  url: string;
  filePath: string;
  headers?: Record<string, string>;
  startBytes?: number;
  totalBytes?: number;
}

export interface NativeDownloadStatus {
  taskId: string;
  state: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled';
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeProgressEvent {
  taskId: string;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
}

export interface NativeStateChangedEvent {
  taskId: string;
  state: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeCompletedEvent {
  taskId: string;
  filePath: string;
  totalBytes: number;
}

export interface NativeErrorEvent {
  taskId: string;
  errorCode: string;
  errorMessage: string;
}

type ProgressListener = (event: NativeProgressEvent) => void;
type StateChangedListener = (event: NativeStateChangedEvent) => void;
type CompletedListener = (event: NativeCompletedEvent) => void;
type ErrorListener = (event: NativeErrorEvent) => void;

let pluginRef: any = null;
let pluginPromise: Promise<void> | null = null;
let listenersPromise: Promise<void> | null = null;
let available: boolean | null = null;

const progressListeners = new Set<ProgressListener>();
const stateChangedListeners = new Set<StateChangedListener>();
const completedListeners = new Set<CompletedListener>();
const errorListeners = new Set<ErrorListener>();

/**
 * 初始化插件（懒加载）
 *
 * 只能把代理存进模块变量，绝不能从 async 函数 return：registerPlugin 返回的代理
 * 对任意属性名都给出一个函数，Promise 解析时会把 `.then` 当成 thenable 回调，
 * 进而向原生发起一次名为 "then" 的调用 —— 原生下载器因此被永久判定为不可用。
 */
function initPlugin(): Promise<void> {
  if (pluginPromise) return pluginPromise;
  pluginPromise = (async () => {
    if (!isNative()) return;
    try {
      const { registerPlugin } = await import('@capacitor/core');
      pluginRef = registerPlugin<any>('Download');
    } catch (e) {
      logger.warn('Native Download plugin not available', e);
    }
  })();
  return pluginPromise;
}

/**
 * 检查原生下载器是否可用
 */
export async function isNativeDownloadAvailable(): Promise<boolean> {
  if (available !== null) return available;

  if (!isNative()) {
    available = false;
    return false;
  }

  await initPlugin();
  if (!pluginRef) {
    available = false;
    return false;
  }

  try {
    const result = await pluginRef.isAvailable();
    available = result?.available === true;
    logger.debug('Native download availability checked', { available });
    return available;
  } catch (e) {
    logger.warn('Failed to check native download availability', e);
    available = false;
    return false;
  }
}

/**
 * 确保事件监听已注册（并发调用共用同一次注册，否则进度事件会成倍回放）
 */
function ensureListeners(): Promise<void> {
  if (listenersPromise) return listenersPromise;
  listenersPromise = (async () => {
    await initPlugin();
    const p = pluginRef;
    if (!p) return;

    p.addListener('progress', (event: NativeProgressEvent) => {
      progressListeners.forEach((fn) => fn(event));
    });

    p.addListener('stateChanged', (event: NativeStateChangedEvent) => {
      stateChangedListeners.forEach((fn) => fn(event));
    });

    p.addListener('completed', (event: NativeCompletedEvent) => {
      completedListeners.forEach((fn) => fn(event));
    });

    p.addListener('error', (event: NativeErrorEvent) => {
      errorListeners.forEach((fn) => fn(event));
    });
  })();
  return listenersPromise;
}

/**
 * 启动下载
 */
export async function nativeDownloadStart(task: NativeDownloadTask): Promise<void> {
  await initPlugin();
  const p = pluginRef;
  if (!p) throw new Error('Native download plugin not available');

  await ensureListeners();

  await p.start({
    taskId: task.taskId,
    url: task.url,
    filePath: task.filePath,
    headers: task.headers ?? {},
    startBytes: task.startBytes ?? 0,
    totalBytes: task.totalBytes ?? -1,
  });

  logger.debug('Native download started', { taskId: task.taskId });
}

/**
 * 控制类调用：原生不可用时静默跳过（调用方已按 available 走过 JS 回退）
 */
async function callNative(method: string, args?: Record<string, unknown>): Promise<void> {
  await initPlugin();
  const p = pluginRef;
  if (!p) return;
  await p[method](args ?? {});
}

/**
 * 暂停下载
 */
export async function nativeDownloadPause(taskId: string): Promise<void> {
  await callNative('pause', { taskId });
  logger.debug('Native download paused', { taskId });
}

/**
 * 恢复下载
 */
export async function nativeDownloadResume(taskId: string): Promise<void> {
  await callNative('resume', { taskId });
  logger.debug('Native download resumed', { taskId });
}

/**
 * 取消下载
 */
export async function nativeDownloadCancel(taskId: string): Promise<void> {
  await callNative('cancel', { taskId });
  logger.debug('Native download canceled', { taskId });
}

/**
 * 获取所有任务状态
 */
export async function nativeDownloadGetStatus(): Promise<NativeDownloadStatus[]> {
  await initPlugin();
  if (!pluginRef) return [];

  const result = await pluginRef.getStatus();
  return result?.tasks ?? [];
}

/**
 * 下发并发闸门（EXT-04 / FR-62）：原生直链此前恒为 2 路，设置页调档无效。
 * 原生不可用时静默跳过，JS 队列自己的闸门仍然生效。
 */
export async function nativeDownloadSetConcurrency(maxConcurrent: number): Promise<void> {
  await callNative('setConcurrency', { maxConcurrent });
  logger.debug('Native download concurrency applied', { maxConcurrent });
}

/**
 * 启动前台服务
 */
export async function nativeDownloadStartForegroundService(): Promise<void> {
  await callNative('startForegroundService');
  logger.debug('Native download foreground service started');
}

/**
 * 停止前台服务
 */
export async function nativeDownloadStopForegroundService(): Promise<void> {
  await callNative('stopForegroundService');
  logger.debug('Native download foreground service stopped');
}

// ========== 事件监听 ==========

export function onProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  ensureListeners();
  return () => progressListeners.delete(listener);
}

export function onStateChanged(listener: StateChangedListener): () => void {
  stateChangedListeners.add(listener);
  ensureListeners();
  return () => stateChangedListeners.delete(listener);
}

export function onCompleted(listener: CompletedListener): () => void {
  completedListeners.add(listener);
  ensureListeners();
  return () => completedListeners.delete(listener);
}

export function onError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  ensureListeners();
  return () => errorListeners.delete(listener);
}
