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

let plugin: any = null;
let initialized = false;
let available: boolean | null = null;

const progressListeners = new Set<ProgressListener>();
const stateChangedListeners = new Set<StateChangedListener>();
const completedListeners = new Set<CompletedListener>();
const errorListeners = new Set<ErrorListener>();

/**
 * 初始化插件（懒加载）
 */
async function initPlugin(): Promise<any> {
  if (plugin) return plugin;
  if (!isNative()) return null;

  try {
    const { registerPlugin } = await import('@capacitor/core');
    plugin = registerPlugin<any>('Download');
    return plugin;
  } catch (e) {
    logger.warn('Native Download plugin not available', e);
    return null;
  }
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

  try {
    const p = await initPlugin();
    if (!p) {
      available = false;
      return false;
    }

    const result = await p.isAvailable();
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
 * 确保事件监听已注册
 */
async function ensureListeners() {
  if (initialized) return;
  const p = await initPlugin();
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

  initialized = true;
}

/**
 * 启动下载
 */
export async function nativeDownloadStart(task: NativeDownloadTask): Promise<void> {
  const p = await initPlugin();
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
 * 暂停下载
 */
export async function nativeDownloadPause(taskId: string): Promise<void> {
  const p = await initPlugin();
  if (!p) return;
  await p.pause({ taskId });
  logger.debug('Native download paused', { taskId });
}

/**
 * 恢复下载
 */
export async function nativeDownloadResume(taskId: string): Promise<void> {
  const p = await initPlugin();
  if (!p) return;
  await p.resume({ taskId });
  logger.debug('Native download resumed', { taskId });
}

/**
 * 取消下载
 */
export async function nativeDownloadCancel(taskId: string): Promise<void> {
  const p = await initPlugin();
  if (!p) return;
  await p.cancel({ taskId });
  logger.debug('Native download canceled', { taskId });
}

/**
 * 获取所有任务状态
 */
export async function nativeDownloadGetStatus(): Promise<NativeDownloadStatus[]> {
  const p = await initPlugin();
  if (!p) return [];

  const result = await p.getStatus();
  return result?.tasks ?? [];
}

/**
 * 启动前台服务
 */
export async function nativeDownloadStartForegroundService(): Promise<void> {
  const p = await initPlugin();
  if (!p) return;
  await p.startForegroundService();
  logger.debug('Native download foreground service started');
}

/**
 * 停止前台服务
 */
export async function nativeDownloadStopForegroundService(): Promise<void> {
  const p = await initPlugin();
  if (!p) return;
  await p.stopForegroundService();
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
