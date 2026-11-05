/**
 * 下载服务（API-09）
 *
 * 组合 `DownloadQueue`（状态机 + 并发）与 `DownloadEngine`（fetch 流 + Range + sink），
 * 对 UI 暴露任务 CRUD、状态操作、本地播放 URL 与事件订阅。
 *
 * 关键语义：
 * - 同一 `mediaId+episodeId` 只保留一个"有效任务"（canceled 视为历史记录，不阻止新建）；
 * - 重复创建不抛错，返回 `{ existed: true }`（AC-70）；
 * - HLS 分片下载：解析 m3u8 清单，顺序下载 .ts 分片并合并；
 * - 移动网络超过 500MB 前置提示（Q-03）由 `needsCellularConfirm` 提供。
 */
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { blobRepo } from '@/db/repositories/blobRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { settingsService } from '@/services/settingsService';
import { appEvents } from '@/services/events';
import { danmakuService } from '@/services/danmakuService';
import { DownloadQueue, transition } from '@/services/downloadQueue';
import { createDownloadEngine, setDownloadEngine } from '@/services/downloadEngine';
import { nativeFilePathOf, readBlob } from '@/services/downloadSink';
import { deleteFile, stat, toPlayableUrl } from '@/native/fs';
import { currentNetworkType, isOnline } from '@/native/network';
import { onAppStateChange, type AppLifecycleState } from '@/native/appLifecycle';
import {
  DOWNLOAD_CELLULAR_WARN_BYTES,
  DOWNLOAD_DEFAULT_CONCURRENCY,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_WEB_SIZE_WARN_BYTES,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';
import type {
  CreateDownloadInput,
  DownloadStatus,
  DownloadSummary,
  DownloadTask,
  PlaybackSource,
} from '@/types';

export type DownloadEvent =
  | { type: 'progress'; task: DownloadTask }
  | { type: 'status'; task: DownloadTask; previous: DownloadStatus }
  | { type: 'queue'; summary: DownloadSummary };

export interface LocalPlayResult {
  url: string;
  /** 'capacitor' = convertFileSrc 结果；'blob' = createObjectURL */
  kind: 'capacitor' | 'blob';
  revoke(): void;
}

type DownloadListener = (e: DownloadEvent) => void;

const listeners = new Set<DownloadListener>();

function emitDownload(event: DownloadEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (e) {
      logger.warn('下载事件监听器异常', e);
    }
  }
}

let queue: DownloadQueue | null = null;
let concurrency: 1 | 2 | 3 = DOWNLOAD_DEFAULT_CONCURRENCY;
let bootstrapped = false;
/** 前后台监听解绑函数（REV-22：切后台暂停、回前台按设置自动恢复） */
let lifecycleUnbind: (() => void) | null = null;
let lastLifecycleState: AppLifecycleState = 'active';

function sinkKindFor(): DownloadTask['sink'] {
  return isNative() ? 'filesystem' : 'idb-blob';
}

function validateInput(input: CreateDownloadInput): void {
  if (!input.mediaId || !input.episodeId) {
    throw new AppError('E_INVALID_INPUT', '缺少媒体或剧集 ID');
  }
  if (!input.url || !/^https?:\/\//i.test(input.url)) {
    throw new AppError('E_INVALID_INPUT', '下载地址必须是 http(s) 直链');
  }
}

async function persist(task: DownloadTask): Promise<void> {
  await downloadRepo.save(task);
}

async function summaryOf(): Promise<DownloadSummary> {
  return downloadRepo.summary();
}

async function emitQueueSummary(): Promise<void> {
  emitDownload({ type: 'queue', summary: await summaryOf() });
  appEvents.emit('downloads:changed', { id: null });
}

/** 惰性创建队列（并发值来自设置） */
async function ensureQueue(): Promise<DownloadQueue> {
  if (queue) return queue;
  try {
    const settings = await settingsService.get();
    concurrency = settings.download.concurrency;
  } catch {
    concurrency = DOWNLOAD_DEFAULT_CONCURRENCY;
  }

  const saveProgress = async (id: string, patch: Partial<DownloadTask>): Promise<void> => {
    const current = await downloadRepo.get(id);
    if (!current) return;
    const next: DownloadTask = { ...current, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    await downloadRepo.save(next);
    emitDownload({ type: 'progress', task: next });
  };

  const engine = createDownloadEngine({
    load: (id) => downloadRepo.get(id),
    saveProgress,
  });
  setDownloadEngine(engine);

  queue = new DownloadQueue({
    load: (id) => downloadRepo.get(id),
    save: async (task) => {
      await downloadRepo.save(task);
    },
    onStatus: (task, previous) => {
      emitDownload({ type: 'status', task, previous });
      void emitQueueSummary();
      // 下载完成后，下载关联的字幕和封面
      if (task.status === 'completed' && previous !== 'completed') {
        void downloadService.downloadAttachments(task, {
          sourceId: task.sourceId,
          mediaId: task.mediaId,
          episodeId: task.episodeId,
          episodeNumber: task.episodeNumber,
          title: task.title,
          episodeTitle: task.episodeTitle,
          posterUrl: task.posterUrl,
          url: task.url,
          headers: task.headers,
          format: task.format,
          quality: task.quality,
          subtitleUrls: task.pendingSubtitleUrls,
          coverUrl: task.pendingCoverUrl,
        }).catch((e) => {
          logger.warn('下载附件失败（忽略）', { taskId: task.id, error: toAppError(e).message });
        });
        // 发送下载完成通知
        void sendDownloadCompleteNotification(task).catch((e) => {
          logger.warn('发送下载完成通知失败（忽略）', { taskId: task.id, error: e });
        });
      }
    },
    concurrency,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new AppError('E_ABORTED'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new AppError('E_ABORTED'));
          },
          { once: true },
        );
      }),
  });

  queue.run((task, ctx) => engine.run(task, ctx.signal));

  return queue;
}

/** 启动时把可恢复的任务重新入队（AC-72 回前台自动恢复） */
async function requeuePending(): Promise<void> {
  const q = await ensureQueue();
  const settings = await settingsService.get();
  const resumableStatuses: DownloadStatus[] = ['queued'];
  if (settings.download.autoResume) resumableStatuses.push('paused');

  const tasks = await downloadRepo.listByStatus(resumableStatuses);
  for (const task of tasks) {
    if (task.status === 'paused') {
      const next = transition(task, 'resume');
      await persist(next);
      emitDownload({ type: 'status', task: next, previous: 'paused' });
      q.enqueue(next);
    } else {
      q.enqueue(task);
    }
  }
  await emitQueueSummary();
}

export const downloadService = {
  async create(input: CreateDownloadInput): Promise<{ task: DownloadTask; existed: boolean }> {
    validateInput(input);
    const existing = await this.findActiveByEpisode(input.mediaId, input.episodeId);
    if (existing) {
      return { task: existing, existed: true };
    }

    // 默认假设支持续传，让下载引擎在实际下载时验证（见 downloadEngine.ts 124-130 行）
    // 如果服务器不支持 Range，引擎会自动降级并更新 task.resumable
    const resumable = true;

    const now = Date.now();
    const task: DownloadTask = {
      id: cryptoRandomId(),
      sourceId: input.sourceId,
      mediaId: input.mediaId,
      episodeId: input.episodeId,
      episodeNumber: input.episodeNumber,
      title: input.title,
      episodeTitle: input.episodeTitle,
      posterUrl: input.posterUrl,
      url: input.url,
      headers: input.headers ?? {},
      format: input.format,
      quality: input.quality ?? null,
      status: 'queued',
      priority: now,
      totalBytes: null,
      downloadedBytes: 0,
      speedBps: 0,
      retries: 0,
      maxRetries: DOWNLOAD_MAX_RETRIES,
      resumable,
      sink: sinkKindFor(),
      filePath: null,
      blobKey: null,
      subtitlePaths: null,
      coverPath: null,
      pendingSubtitleUrls: input.subtitleUrls,
      pendingCoverUrl: input.coverUrl,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await persist(task);
    const q = await ensureQueue();
    q.enqueue(task);
    emitDownload({ type: 'status', task, previous: 'queued' });
    await emitQueueSummary();
    return { task, existed: false };
  },

  /** 批量创建（AC-70：50 集不卡顿 —— 分批入队并让出事件循环） */
  async createMany(inputs: CreateDownloadInput[]): Promise<{ created: DownloadTask[]; skipped: DownloadTask[] }> {
    const created: DownloadTask[] = [];
    const skipped: DownloadTask[] = [];
    for (const [index, input] of inputs.entries()) {
      const result = await this.create(input);
      if (result.existed) skipped.push(result.task);
      else created.push(result.task);
      if (index > 0 && index % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // 批量摘要：避免逐个 toast 轰炸
    if (created.length > 0) {
      appEvents.emit('toast', {
        text: `已加入 ${created.length} 个下载任务` + (skipped.length > 0 ? `，${skipped.length} 个已存在` : ''),
        type: 'success',
      });
    }

    return { created, skipped };
  },

  async list(filter?: { statuses?: DownloadStatus[] }): Promise<DownloadTask[]> {
    if (filter?.statuses && filter.statuses.length > 0) {
      return downloadRepo.listByStatus(filter.statuses);
    }
    return downloadRepo.listAll();
  },

  async get(id: string): Promise<DownloadTask | null> {
    return downloadRepo.get(id);
  },

  /** 当前有效任务（canceled 不算） */
  async getByEpisode(mediaId: string, episodeId: string): Promise<DownloadTask | null> {
    return this.findActiveByEpisode(mediaId, episodeId);
  },

  async findActiveByEpisode(mediaId: string, episodeId: string): Promise<DownloadTask | null> {
    const rows = await downloadRepo.listByEpisode(mediaId, episodeId);
    return rows.find((task) => task.status !== 'canceled') ?? null;
  },

  async pause(id: string): Promise<DownloadTask> {
    const q = await ensureQueue();
    const task = await q.pause(id);
    await emitQueueSummary();
    return task;
  },

  async resume(id: string): Promise<DownloadTask> {
    const q = await ensureQueue();
    const task = await q.resume(id);
    await emitQueueSummary();
    return task;
  },

  async cancel(id: string): Promise<void> {
    const q = await ensureQueue();
    await q.cancel(id);
    await emitQueueSummary();
  },

  async retry(id: string): Promise<DownloadTask> {
    const q = await ensureQueue();
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    // completed/canceled 无法 retry：先重置为 queued（内部方法，AN-78 重新下载）
    if (task.status === 'completed' || task.status === 'canceled') {
      return this.redownload(id);
    }
    const next = await q.retry(id);
    await emitQueueSummary();
    return next;
  },

  /**
   * 重新下载（扩展方法，供 AC-78"本地文件不可用 → 重新下载"使用）：
   * 复用原任务记录，清空 filePath/blobKey 与进度后重新入队。
   */
  async redownload(id: string): Promise<DownloadTask> {
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    const now = Date.now();
    const next: DownloadTask = {
      ...task,
      status: 'queued',
      downloadedBytes: 0,
      totalBytes: null,
      speedBps: 0,
      retries: 0,
      resumable: true,
      filePath: null,
      blobKey: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      priority: now,
      updatedAt: now,
    };
    // 清理旧文件/Blob（失败忽略）
    if (task.blobKey) await blobRepo.delete(task.blobKey).catch(() => undefined);
    if (task.filePath && isNative()) await deleteFile(task.filePath).catch(() => undefined);

    await persist(next);
    const q = await ensureQueue();
    q.enqueue(next);
    emitDownload({ type: 'status', task: next, previous: task.status });
    await emitQueueSummary();
    return next;
  },

  /**
   * 使用备选 URL 重试下载（多源 fallback）
   *
   * 当任务失败后，用新的 URL 创建新任务（替换旧任务）。
   * UI 负责从其他源获取备选 URL。
   */
  async retryWithAlternativeUrl(id: string, alternativeUrl: string, alternativeHeaders?: Record<string, string>): Promise<DownloadTask> {
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    if (task.status !== 'failed') {
      throw new AppError('E_INVALID_STATE', '只有失败的任务才能尝试备选 URL');
    }

    // 删除旧任务
    await this.remove(id, { deleteFile: true });

    // 创建新任务
    const newTask = await this.create({
      sourceId: task.sourceId,
      mediaId: task.mediaId,
      episodeId: task.episodeId,
      episodeNumber: task.episodeNumber,
      title: task.title,
      episodeTitle: task.episodeTitle,
      posterUrl: task.posterUrl,
      url: alternativeUrl,
      headers: alternativeHeaders ?? task.headers,
      format: task.format,
      quality: task.quality,
    });

    logger.debug('备选 URL 任务已创建', {
      oldTaskId: id,
      newTaskId: newTask.task.id,
      newUrl: alternativeUrl,
    });

    return newTask.task;
  },

  async remove(id: string, opts?: { deleteFile?: boolean }): Promise<void> {
    const task = await downloadRepo.get(id);
    if (!task) return;
    const q = await ensureQueue();

    // 下载中先取消再删除（AC-80）
    if (task.status === 'downloading' || task.status === 'queued') {
      await q.cancel(id).catch(() => undefined);
    }
    q.dequeue(id);

    if (opts?.deleteFile !== false) {
      if (task.blobKey) await blobRepo.delete(task.blobKey).catch(() => undefined);
      if (task.filePath && isNative()) await deleteFile(task.filePath).catch(() => undefined);
    }
    await downloadRepo.remove(id);
    await emitQueueSummary();
  },

  async clearCompleted(): Promise<number> {
    const completed = await downloadRepo.listByStatus(['completed']);
    for (const task of completed) {
      await this.remove(task.id, { deleteFile: true });
    }
    return completed.length;
  },

  /** 本地播放地址（文件缺失 → E_FILE_MISSING，AC-78） */
  async getLocalPlayUrl(id: string): Promise<LocalPlayResult> {
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    if (task.status !== 'completed') throw new AppError('E_FILE_MISSING', '任务尚未下载完成');

    if (task.sink === 'filesystem') {
      const path = task.filePath ?? nativeFilePathOf(task);
      const info = await stat(path);
      if (!info.exists || info.size === 0) {
        throw new AppError('E_FILE_MISSING');
      }
      const url = await toPlayableUrl(path);
      return { url, kind: 'capacitor', revoke: () => undefined };
    }

    const key = task.blobKey ?? task.id;
    const blob = await readBlob(key);
    if (!blob || blob.size === 0) throw new AppError('E_FILE_MISSING');
    const url = URL.createObjectURL(blob);
    return {
      url,
      kind: 'blob',
      revoke: () => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // 忽略
        }
      },
    };
  },

  /**
   * 导出已下载文件到公共目录（用户可访问的位置）
   * - Android：使用 Share API 分享文件
   * - Web：触发浏览器下载（showSaveFilePicker 或 a 标签）
   */
  async exportFile(id: string): Promise<void> {
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    if (task.status !== 'completed') throw new AppError('E_FILE_MISSING', '任务尚未下载完成');

    const filename = `${task.title}${task.episodeTitle ? ` - ${task.episodeTitle}` : ''}.${task.format}`;

    if (isNative()) {
      // Android：使用 Share API
      const path = task.filePath ?? nativeFilePathOf(task);
      const info = await stat(path);
      if (!info.exists || info.size === 0) {
        throw new AppError('E_FILE_MISSING');
      }
      const { Share } = await import('@capacitor/share');
      const uri = await toPlayableUrl(path);
      await Share.share({
        title: '分享视频',
        text: task.title,
        url: uri,
        dialogTitle: '导出视频',
      });
      logger.debug('Android 文件已分享', { path });
    } else {
      // Web：触发浏览器下载
      const key = task.blobKey ?? task.id;
      const blob = await readBlob(key);
      if (!blob || blob.size === 0) throw new AppError('E_FILE_MISSING');

      // 尝试使用 showSaveFilePicker（Chrome/Edge 支持）
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: filename,
            types: [
              {
                description: '视频文件',
                accept: { [blob.type || 'video/mp4']: ['.mp4', '.ts', '.webm'] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          logger.debug('Web 文件已导出（showSaveFilePicker）', { filename });
          return;
        } catch (e) {
          // 用户取消或不支持，降级到 a 标签下载
          if ((e as Error).name === 'AbortError') {
            logger.debug('用户取消导出');
            return;
          }
          logger.debug('showSaveFilePicker 失败，降级到 a 标签', e);
        }
      }

      // 降级：a 标签下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
      logger.debug('Web 文件已导出（a 标签）', { filename });
    }
  },

  /**
   * 若该集已下载完成且本地可用，返回本地 PlaybackSource；否则 null。
   * 供 `libraryService.resolvePlay` 优先本地（AC-77）。
   *
   * 注意：本地文件缺失时这里**只返回 null**，是否"任务存在但文件丢了"由
   * `isLocalFileMissing()` 单独判定（REV-23：避免静默回退网络源）。
   */
  async findLocalPlay(mediaId: string, episodeId: string): Promise<PlaybackSource | null> {
    const task = await this.findActiveByEpisode(mediaId, episodeId);
    if (!task || task.status !== 'completed') return null;
    try {
      const local = await this.getLocalPlayUrl(task.id);
      return {
        url: local.url,
        // HLS 下载已把分片合并为单一 MPEG-TS 文件，按渐进式 ts 播放即可；
        // 若仍报 'hls' 会被播放器当成清单去做 m3u8 预检而失败。
        format: task.format === 'hls' ? 'ts' : task.format,
        headers: {},
        subtitles: [],
        lineId: `local:${task.id}`,
        quality: task.quality,
        expiresAt: null,
        isLocal: true,
      };
    } catch (e) {
      logger.warn('本地文件不可用', { taskId: task.id, error: toAppError(e).message });
      return null;
    }
  },

  /**
   * 「任务已完成但本地文件/Blob 已丢失」（AC-78 / REV-23）。
   *
   * `PlaybackSource` 没有"本地不可用"字段（类型冻结，不改），因此服务层用
   * `downloadService.localMissingTaskOf()` 暴露该状态，供 `resolvePlay` 在回退网络源时
   * 发事件提示，UI 可据此展示"本地文件不可用 → 重新下载"。
   */
  async isLocalFileMissing(mediaId: string, episodeId: string): Promise<boolean> {
    return (await this.localMissingTaskOf(mediaId, episodeId)) !== null;
  },

  /** 返回"已完成但本地不可用"的任务（可用于「重新下载」按钮），无则 null */
  async localMissingTaskOf(mediaId: string, episodeId: string): Promise<DownloadTask | null> {
    const task = await this.findActiveByEpisode(mediaId, episodeId);
    if (!task || task.status !== 'completed') return null;
    try {
      await this.getLocalPlayUrl(task.id);
      return null;
    } catch {
      return task;
    }
  },

  async getSummary(): Promise<DownloadSummary> {
    return summaryOf();
  },

  async setConcurrency(n: 1 | 2 | 3): Promise<void> {
    concurrency = n;
    await settingsService.update({ download: { concurrency: n } });
    const q = await ensureQueue();
    q.setConcurrency(n);
  },

  /** 启动/回前台恢复队列；同时接线应用生命周期（AC-72 / REV-22） */
  async bootstrap(): Promise<void> {
    downloadService.bindLifecycle();
    if (!isOnline()) return;
    bootstrapped = true;
    await requeuePending();
  },

  /**
   * 订阅前后台切换（AC-72 / REV-22）：
   * - Android（原生）：进后台不暂停，继续下载（前台 Service 保活）
   * - Web：进后台时暂停下载（WebView 可能被冻结），并尝试 Wake Lock 防止屏幕休眠
   * - 回前台：`settings.download.autoResume` 为 true 时自动恢复，否则等用户手动继续。
   * 重复调用幂等（`bootstrap()` 可能被多次触发）。
   */
  bindLifecycle(): void {
    if (lifecycleUnbind) return;
    lifecycleUnbind = onAppStateChange((state) => {
      if (state === lastLifecycleState) return;
      lastLifecycleState = state;
      if (state === 'background') {
        if (isNative()) {
          // Android：不暂停，继续下载
          logger.debug('进入后台，Android 继续下载');
        } else {
          // Web：暂停下载（WebView 可能被冻结）
          void downloadService.pauseAll('background').catch((e: unknown) => {
            logger.warn('切后台暂停下载失败', toAppError(e));
          });
          // 尝试 Wake Lock 防止屏幕休眠（用户回前台时可以继续）
          void acquireWakeLock().catch((e) => {
            logger.debug('Wake Lock 获取失败（忽略）', e);
          });
          appEvents.emit('toast', {
            text: '下载已暂停，切回前台可继续',
            type: 'info',
          });
        }
        return;
      }
      // 回前台：释放 Wake Lock
      if (!isNative()) {
        releaseWakeLock();
      }
      void downloadService.resumeAll().catch((e: unknown) => {
        logger.warn('回前台恢复下载失败', toAppError(e));
      });
    });
  },

  async pauseAll(reason: 'background' | 'user'): Promise<void> {
    const q = await ensureQueue();
    await q.pauseAll();
    // 队列里没有的"下载中"任务（如后台被系统冻结后队列已清空）也要落成"已暂停"，
    // 保证 AC-72「所有下载中 → 已暂停且进度保留」不留漏网任务。
    const leftover = await downloadRepo.listByStatus(['downloading']);
    for (const task of leftover) {
      try {
        const next = transition(task, 'pause');
        await downloadRepo.save(next);
        emitDownload({ type: 'status', task: next, previous: task.status });
      } catch (e) {
        logger.warn('暂停任务失败（忽略该条）', { taskId: task.id, error: toAppError(e).message });
      }
    }
    if (reason === 'background') {
      logger.debug('进入后台，已暂停全部下载');
    }
    await emitQueueSummary();
  },

  async resumeAll(): Promise<void> {
    const settings = await settingsService.get();
    if (!settings.download.autoResume) return;
    await requeuePending();
  },

  /**
   * 下载字幕文件（辅助函数）
   */
  async downloadSubtitle(
    url: string,
    lang: string,
    format: 'vtt' | 'srt',
    task: DownloadTask,
    headers: Record<string, string>
  ): Promise<string> {
    const response = await fetch(url, { headers, cache: 'no-store' });
    if (!response.ok) throw new AppError('E_NETWORK', `下载字幕失败：${url}`);
    const data = new Uint8Array(await response.arrayBuffer());

    if (isNative()) {
      // Android：写入文件系统
      const { arrayBufferToBase64, writeBase64, ensureDir } = await import('@/native/fs');
      const subtitlePath = `${nativeFilePathOf(task).replace(/\.[^.]+$/, '')}.${lang}.${format}`;
      const dir = subtitlePath.slice(0, subtitlePath.lastIndexOf('/'));
      await ensureDir(dir);
      const base64 = arrayBufferToBase64(data.buffer);
      await writeBase64(subtitlePath, base64);
      return subtitlePath;
    } else {
      // Web：写入 IndexedDB
      const blob = new Blob([data], { type: format === 'vtt' ? 'text/vtt' : 'application/x-subrip' });
      const subtitleKey = `${task.id}.subtitle.${lang}`;
      await blobRepo.put({
        key: subtitleKey,
        blob,
        size: blob.size,
        mime: blob.type,
        createdAt: Date.now(),
      });
      return subtitleKey;
    }
  },

  /**
   * 下载封面图（辅助函数）
   */
  async downloadCover(url: string, task: DownloadTask, headers: Record<string, string>): Promise<string> {
    const response = await fetch(url, { headers, cache: 'no-store' });
    if (!response.ok) throw new AppError('E_NETWORK', `下载封面失败：${url}`);
    const data = new Uint8Array(await response.arrayBuffer());

    if (isNative()) {
      // Android：写入文件系统
      const { arrayBufferToBase64, writeBase64, ensureDir } = await import('@/native/fs');
      const coverPath = `${nativeFilePathOf(task).replace(/\.[^.]+$/, '')}.cover.jpg`;
      const dir = coverPath.slice(0, coverPath.lastIndexOf('/'));
      await ensureDir(dir);
      const base64 = arrayBufferToBase64(data.buffer);
      await writeBase64(coverPath, base64);
      return coverPath;
    } else {
      // Web：写入 IndexedDB
      const blob = new Blob([data], { type: 'image/jpeg' });
      const coverKey = `${task.id}.cover`;
      await blobRepo.put({
        key: coverKey,
        blob,
        size: blob.size,
        mime: blob.type,
        createdAt: Date.now(),
      });
      return coverKey;
    }
  },

  /**
   * 下载完视频后，下载关联的字幕和封面
   */
  async downloadAttachments(task: DownloadTask, input: CreateDownloadInput): Promise<void> {
    const subtitlePaths: Array<{ path: string; lang: string; format: 'vtt' | 'srt' }> = [];

    // 下载字幕
    if (input.subtitleUrls && input.subtitleUrls.length > 0) {
      for (const sub of input.subtitleUrls) {
        try {
          const path = await this.downloadSubtitle(sub.url, sub.lang, sub.format, task, input.headers ?? {});
          subtitlePaths.push({ path, lang: sub.lang, format: sub.format });
          logger.debug('字幕已下载', { lang: sub.lang, path });
        } catch (e) {
          logger.warn('字幕下载失败（忽略）', { lang: sub.lang, error: toAppError(e).message });
        }
      }
    }

    // 下载封面
    let coverPath: string | null = null;
    if (input.coverUrl) {
      try {
        coverPath = await this.downloadCover(input.coverUrl, task, input.headers ?? {});
        logger.debug('封面已下载', { path: coverPath });
      } catch (e) {
        logger.warn('封面下载失败（忽略）', { error: toAppError(e).message });
      }
    }

    // 功能扩展-3：预取弹幕（离线可用）
    if (input.title && input.episodeNumber) {
      try {
        const mediaItem = await mediaRepo.get(input.mediaId);
        const year = mediaItem?.year ?? null;
        await danmakuService.prefetch(input.title, year, input.episodeNumber);
        logger.debug('弹幕已预取', { title: input.title, year, episode: input.episodeNumber });
      } catch (e) {
        logger.warn('弹幕预取失败（忽略）', { error: toAppError(e).message });
      }
    }

    // 更新任务记录
    if (subtitlePaths.length > 0 || coverPath) {
      const updated = await downloadRepo.get(task.id);
      if (updated) {
        await downloadRepo.save({
          ...updated,
          subtitlePaths: subtitlePaths.length > 0 ? subtitlePaths : null,
          coverPath,
          updatedAt: Date.now(),
        });
      }
    }
  },

  on(event: 'download', handler: DownloadListener): () => void {
    if (event !== 'download') return () => undefined;
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  },

  /* ---------------- 策略提示（UI 调用） ---------------- */

  /** 移动网络且预估大小超阈值 → 需要用户确认（Q-03） */
  async needsCellularConfirm(totalBytes: number | null): Promise<boolean> {
    if (currentNetworkType() !== 'cellular') return false;
    if (totalBytes === null) return true;
    return totalBytes > DOWNLOAD_CELLULAR_WARN_BYTES;
  },

  /** Web 端单文件过大提示（AC-76） */
  needsAppForLargeFile(totalBytes: number | null): boolean {
    return !isNative() && totalBytes !== null && totalBytes > DOWNLOAD_WEB_SIZE_WARN_BYTES;
  },

  /**
   * 用 HEAD 预检单文件体积（AC-76 前置提示 / REV-07）。
   *
   * 返回 `null` 表示无法判定（离线、CORS 禁止 HEAD、服务端未给 `Content-Length`）：
   * 此时放行，由下载引擎拿到响应头后的同阈值检查兜底。
   */
  async preflightSize(url: string, headers: Record<string, string> = {}): Promise<number | null> {
    if (isNative() || !isOnline()) return null;
    try {
      const response = await fetch(url, { method: 'HEAD', headers, cache: 'no-store' });
      if (!response.ok) return null;
      const raw = response.headers.get('content-length');
      if (!raw) return null;
      const size = Number.parseInt(raw, 10);
      return Number.isFinite(size) && size >= 0 ? size : null;
    } catch (e) {
      logger.debug('下载体积预检失败（忽略）', toAppError(e).message);
      return null;
    }
  },

  /** 是否已完成 bootstrap（测试用） */
  isBootstrapped(): boolean {
    return bootstrapped;
  },

  /** 测试辅助：卸载队列（不删数据） */
  __resetQueue(): void {
    lifecycleUnbind?.();
    lifecycleUnbind = null;
    lastLifecycleState = 'active';
    releaseWakeLock();
    queue?.dispose();
    queue = null;
    listeners.clear();
    bootstrapped = false;
    setDownloadEngine(null);
  },
};

/* ---------------- Wake Lock（Web 端防止屏幕休眠） ---------------- */

let wakeLockSentinel: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    logger.debug('Wake Lock API 不可用');
    return;
  }
  if (wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    logger.debug('Wake Lock 已获取');
    wakeLockSentinel.addEventListener('release', () => {
      logger.debug('Wake Lock 已释放');
      wakeLockSentinel = null;
    });
  } catch (e) {
    logger.warn('获取 Wake Lock 失败', e);
    wakeLockSentinel = null;
  }
}

function releaseWakeLock(): void {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => undefined);
    wakeLockSentinel = null;
  }
}

interface WakeLockSentinel extends EventTarget {
  release(): Promise<void>;
}

/* ---------------- 下载完成通知 ---------------- */

async function sendDownloadCompleteNotification(task: DownloadTask): Promise<void> {
  const title = task.episodeTitle ? `${task.title} - ${task.episodeTitle}` : task.title;
  const body = '下载完成';

  if (isNative()) {
    // Android：使用 Local Notifications 插件
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      // 请求权限
      const permission = await LocalNotifications.requestPermissions();
      if (permission.display !== 'granted') {
        logger.debug('通知权限未授予');
        return;
      }
      // 发送通知
      await LocalNotifications.schedule({
        notifications: [
          {
            id: task.id.hashCode(),
            title,
            body,
            sound: 'default',
            smallIcon: 'ic_stat_icon_config_sample',
            iconColor: '#488AFF',
          },
        ],
      });
      logger.debug('下载完成通知已发送', { taskId: task.id });
    } catch (e) {
      logger.warn('发送通知失败', e);
    }
  } else {
    // Web：使用 Notification API
    if (typeof Notification === 'undefined') {
      logger.debug('Notification API 不可用');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        logger.debug('通知权限未授予');
        return;
      }
      new Notification(title, { body, silent: false });
      logger.debug('Web 通知已发送', { taskId: task.id });
    } catch (e) {
      logger.warn('发送 Web 通知失败', e);
    }
  }
}

// 简单的字符串 hash 函数（用于生成通知 ID）
declare global {
  interface String {
    hashCode(): number;
  }
}

if (!String.prototype.hashCode) {
  String.prototype.hashCode = function (): number {
    let hash = 0;
    for (let i = 0; i < this.length; i++) {
      const char = this.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash);
  };
}

function cryptoRandomId(): string {
  const cryptoObj = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => (b + 0x100).toString(16).slice(1)).join('');
}

export type DownloadService = typeof downloadService;

/** 便于测试注入并发值（不写设置） */
export function __setConcurrencyForTest(n: 1 | 2 | 3): void {
  concurrency = n;
  queue?.setConcurrency(n);
}
