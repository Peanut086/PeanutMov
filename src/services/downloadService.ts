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
import { isDownloadPhaseSettled, nativeFilePathOf, nativePartPathOf, readBlob } from '@/services/downloadSink';
import { deleteFile, stat, toPlayableUrl } from '@/native/fs';
import { currentNetworkType, isOnline, onNetworkChange, primeNetworkStatus } from '@/native/network';
import { onAppStateChange, type AppLifecycleState } from '@/native/appLifecycle';
import { applyNativeSpeedLimit } from '@/native/mediaToolPlugin';
import { nativeDownloadSetConcurrency } from '@/native/downloadPlugin';
import {
  DOWNLOAD_CELLULAR_WARN_BYTES,
  DOWNLOAD_DEFAULT_CONCURRENCY,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_WEB_SIZE_WARN_BYTES,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';
import {
  downloadRateLimiter,
  isValidSpeedLimit,
  type RateStats,
  type SpeedLimitApplied,
} from '@/services/downloadRateLimiter';
import {
  assertBatchSize,
  countOccupied,
  createBatchId,
  existingKeyOf,
  resolveQueueCapacity,
  selectCompleted,
  selectRetryable,
  tasksOfBatch,
} from '@/services/downloadBatch';
import { downloadPreflight, type PreflightOptions, type PreflightResult } from '@/services/downloadPreflight';
import { markOfflineFileInUse } from '@/services/offlineRemuxMigration';
import { isLocalArtifactUrl, LOCAL_ARTIFACT_MESSAGE } from '@/player/sourceGuard';
import type {
  CreateDownloadInput,
  DownloadPausedBy,
  DownloadSpeedLimit,
  DownloadStatus,
  DownloadSubtitlePolicy,
  DownloadSummary,
  DownloadTask,
  ErrorCode,
  HlsQuality,
  MediaFormat,
  PlaybackSource,
  SubtitleTrack,
} from '@/types';

export type DownloadEvent = {
  type: 'progress';
  task: DownloadTask;
} | {
  type: 'status';
  task: DownloadTask;
  previous: DownloadStatus;
} | {
  type: 'queue';
  summary: DownloadSummary;
} | {
  /** EXT-04/FR-60/FR-64：后处理阶段（转封装 / 字幕）——UI 只读展示，不改变任务状态 */
  type: 'postprocess';
  task: DownloadTask;
  stage: 'remux' | 'subtitles';
  state: 'start' | 'progress' | 'done' | 'skipped' | 'failed';
  /** 0~1，节流 ≤2 次/秒 */
  progress?: number;
  reason?: string;
};

export interface LocalPlayResult {
  url: string;
  /** 'capacitor' = convertFileSrc 结果；'blob' = createObjectURL */
  kind: 'capacitor' | 'blob';
  revoke(): void;
}

/** 存储占用（AC-79 / P2-3）：只算落盘字节，`partialBytes` 是其中未完成的残片 */
export interface StorageUsage {
  /** 成品 + 残片的真实占用 */
  totalBytes: number;
  /** 成品文件数（残片不计） */
  fileCount: number;
  partialBytes: number;
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
/** REV-24：僵尸任务检测标志，确保只在首次启动时执行 */
let zombieChecked = false;
/** 前后台监听解绑函数（REV-22：切后台暂停、回前台按设置自动恢复） */
let lifecycleUnbind: (() => void) | null = null;
let networkUnbind: (() => void) | null = null;
let lastLifecycleState: AppLifecycleState = 'active';
/** FIX-D3：运行时卡死 watchdog 定时器 */
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/** FIX-D3：watchdog 判定停滞的阈值（90s 无进度更新） */
const WATCHDOG_STALE_MS = 90_000;
/** FIX-D3：watchdog 检查周期 */
const WATCHDOG_INTERVAL_MS = 30_000;
/** P0-3：存量「地址指向本地文件」任务清洗后的失败文案（告诉用户下一步动作） */
const LOCAL_TASK_REPAIRED_MESSAGE = '任务链接已失效，请从详情页重新下载';
/**
 * P1-4：本地文件解析超时。
 * `stat` / `convertFileSrc` / IndexedDB 读都是异步桥调用，一旦挂住，播放页会一直
 * 停在"加载中"——下载列表点进来的本地视频因此"卡住无法播放"。给一个上限，
 * 超时报明确错误让用户重试，而不是无限等。
 */
const LOCAL_RESOLVE_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('E_TIMEOUT', message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  // P0-1：本地产物地址（Capacitor 文件桥）通过了上一条的 http(s) 校验，却永远下载
  // 不到字节——必须在创建口拦掉，否则任务一进队列就开始"进度 0 的重试循环"。
  if (isLocalArtifactUrl(input.url)) {
    throw new AppError('E_INVALID_INPUT', LOCAL_ARTIFACT_MESSAGE, { detail: input.url });
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
  // OPT-09：队列在后台跑空/全暂停后要把保活收回来（前台时直接短路，不查库）
  await syncKeepAliveIfBackground();
}

/**
 * FIX-D9：直链失效类错误码。源站直链带时效签名，过期后返回的是
 * 「缺少 xxx 头」之类的错误页而不是清单/分片——拿同一个死链再 retry
 * 只会再撞一次墙，用户看到的就是"无法继续下载"。
 */
const STALE_LINK_CODES = new Set<string>([
  'E_SOURCE_UNAVAILABLE',
  'E_PARSE',
  'E_HTTP_403',
  'E_HTTP_404',
  'E_AUTH',
  // 密钥过期同样表现为"解不开"：AES 密钥是按签名直链拉回来的，直链一过期，
  // 拿到的就是错误页而不是密钥，于是每片都解密失败。先换新链再重试才有救。
  'E_DRM_PROTECTED',
]);

/** 去掉签名查询串：同一资源换了 token 仍算同一资源，已下载的字节可以继续用 */
function resourcePathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

/** 源站把同一条死链原样回吐时给用户的可行动文案（DL-P0-4） */
const STALE_UNCHANGED_MESSAGE = '该线路的直链已过期，源站没有给出新地址，请更换线路或源';

/**
 * 失败重试前重新解析直链与请求头（解析失败则沿用原地址，不阻断重试）。
 *
 * 资源路径变了就是换了一份清单：旧的 `.part` 与分片序号不能再拼上去，
 * 否则得到的是能"完成"却播不动的损坏文件（FIX-D8 同类）。
 *
 * 返回换链结果，调用方据此决定要不要拿原来那条链再撞一次：
 * - `'refreshed'`：拿到了新地址（换了签名，或整份清单都换了）
 * - `'unchanged'`：地址与请求头逐字未变——重试必然再吃一次同样的 402/403
 * - `'failed'`：解析本身没成或结果不可用，沿用原地址
 */
async function refreshStaleLink(task: DownloadTask): Promise<'refreshed' | 'unchanged' | 'failed'> {
  try {
    // 动态引入：libraryService 静态依赖 downloadService，顶层 import 会成环
    const { libraryService } = await import('@/services/libraryService');
    /**
     * DL-P0-4：先打掉解析缓存，"刷新直链"才真的是一次刷新。
     *
     * `resolvePlay` 的第一道命中是 30 分钟内存缓存，而爬虫源交回的 `expiresAt` 恒为
     * null（SpiderAdapter 里写死），P0-3 那道「直链过期优先于内存 TTL」的闸门对它们
     * 完全空转。真机实测：13:45:47~13:56:19 连着 9 次刷新全是 `resourceChanged: false`，
     * 每条都配着一句「播放地址缓存命中」，库里那条 `auth_key=1794979747…` 自 13:29:07
     * 起一个字没变；每一轮都是「缓存命中→已刷新直链→用同一个签名起跑→清单 402」。
     */
    libraryService.invalidatePlayCache(task.mediaId);
    const play = await libraryService.resolvePlay({
      mediaId: task.mediaId,
      episodeId: task.episodeId,
      lineId: task.lineId ?? null,
      prefer: 'network',
    });
    if (!play.url || isLocalArtifactUrl(play.url)) return 'failed';

    const resourceChanged = resourcePathOf(play.url) !== resourcePathOf(task.url);
    /**
     * 「没换」要连请求头一起看：签名放在头里的源，换了头就是换了链。
     * 按字面序列化比对，键序不同只会误成「换了」——那是放行重试的方向，不会把死链放跑。
     */
    const unchanged =
      play.url === task.url &&
      JSON.stringify(play.headers ?? {}) === JSON.stringify(task.headers ?? {});
    // 以库里的当前行为底本回写：拿派发前那份快照会把刚被暂停/取消的任务复活成 downloading
    const current = (await downloadRepo.get(task.id)) ?? task;
    const next: DownloadTask = {
      ...current,
      url: play.url,
      headers: play.headers ?? task.headers,
      format: play.format,
      /**
       * 原样回吐时顺手把结论写进这一行：卡片上的文案要和 toast 是同一句。
       * 继续挂着上一次「源返回了网页而不是视频清单」那种描述，用户只会照着它再点一次重试。
       */
      ...(unchanged
        ? { errorCode: 'E_SOURCE_UNAVAILABLE' as ErrorCode, errorMessage: STALE_UNCHANGED_MESSAGE }
        : {}),
      ...(resourceChanged
        ? {
            downloadedBytes: 0,
            totalBytes: null,
            completedSegments: [],
            hlsTotalSegments: 0,
            resumable: false,
            filePath: null,
            blobKey: null,
          }
        : {}),
      updatedAt: Date.now(),
    };
    // 扩展名随地址变化时 .part 路径也变了，sink 清不到旧文件，这里显式删
    if (resourceChanged && task.sink === 'filesystem') {
      const oldPart = nativePartPathOf(task);
      if (oldPart !== nativePartPathOf(next)) await deleteFile(oldPart).catch(() => undefined);
    }
    await persist(next);
    logger.info('失败任务已刷新直链', {
      taskId: task.id,
      errorCode: task.errorCode,
      resourceChanged,
      unchanged,
    });
    return unchanged ? 'unchanged' : 'refreshed';
  } catch (e) {
    logger.warn('刷新直链失败，沿用原地址重试', { taskId: task.id, error: toAppError(e).message });
    return 'failed';
  }
}

/**
 * 起跑前的换链闸门（队列 `beforeStart` 钩子，DL-P0-4）。
 *
 * 此前换链只挂在 `retry()` / `resume()` / `requeuePending()` 三个入队口上，而长下载最常
 * 见的死法恰好不从这三个口进来：跑到中途签名过期 → 队列退避自动重试、watchdog 把无人
 * 负责的孤儿交回队列，两条路都拿着同一个过期 `auth_key` 原地再撞一次。收口到派发前这个
 * 口子，四条入口共用一段逻辑，也不会出现「入队前刷一次、派发时又刷一次」的重复解析——
 * 爬虫源单次解析 1~3 秒，且原生侧同实例串行，第二次只会被挡回「仍在原生侧执行」。
 *
 * 换不到新地址就不起跑：直接判失败给一句可行动文案，比让它把退避表里的两轮机会烧光、
 * 最后回一句「源不可用」有用。`fail` 迁移只接受 downloading，这里是派发前的 queued，
 * 所以按行落库并补发状态事件，走不了 `transition`。
 */
async function refreshBeforeStart(task: DownloadTask): Promise<void> {
  if (!task.errorCode || !STALE_LINK_CODES.has(task.errorCode)) return;
  if ((await refreshStaleLink(task)) !== 'unchanged') return;
  const current = await downloadRepo.get(task.id);
  if (!current) return;
  // 文案已由 `refreshStaleLink` 在原样回吐时写好，这里只负责把 queued 收成 failed
  const failed: DownloadTask = { ...current, status: 'failed', speedBps: 0, updatedAt: Date.now() };
  logger.warn('直链已过期且源站未给出新地址，本次不起跑', { taskId: task.id });
  await persist(failed);
  emitDownload({ type: 'status', task: failed, previous: 'queued' });
  await emitQueueSummary();
}

/**
 * 并发档位同步给原生直链下载器（EXT-04 / FR-62）。
 * 原生侧此前硬编码 2 路，设置页的 1/2/3 只驱动 JS 队列，走原生时用户调档完全无感。
 */
async function syncNativeConcurrency(n: number): Promise<void> {
  try {
    await nativeDownloadSetConcurrency(n);
  } catch (e) {
    logger.debug('原生并发闸门下发失败（忽略，JS 队列仍按档位执行）', toAppError(e).message);
  }
}

/**
 * 「仅 Wi-Fi 下载」对在飞任务的兜底。
 *
 * preflight 只拦新任务：Wi-Fi 切到移动网络时正在下的任务仍然跑完，
 * 所以设置页那句「移动网络下载将二次确认」此前对运行中任务并不成立。
 * 只暂停并标 `pausedBy:'network'`——回前台/启动的自动恢复（`requeuePending('auto')`）
 * 不复活 `network`/`user` 来源，切回 Wi-Fi 或用户手动前不会偷跑移动流量（OPT-01）。
 */
async function enforceWifiOnlyOnCellular(): Promise<void> {
  if (currentNetworkType() !== 'cellular') return;
  try {
    const settings = await settingsService.get();
    if (!settings.download.wifiOnly) return;
  } catch {
    return;
  }
  const inFlight = await downloadRepo.listByStatus(['downloading', 'queued']);
  if (inFlight.length === 0) return;
  await downloadService.pauseAll('network');
  appEvents.emit('toast', {
    text: `已切到移动网络，${inFlight.length} 个下载按「仅 Wi-Fi」暂停`,
    type: 'info',
  });
  logger.info('wifiOnly 触发在飞任务暂停', { tasks: inFlight.length });
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
  await syncNativeConcurrency(concurrency);

  const saveProgress = async (id: string, patch: Partial<DownloadTask>): Promise<void> => {
    const current = await downloadRepo.get(id);
    if (!current) return;
    /**
     * 进度回写不许复活状态：`hlsDownloader`（第 741 行）与 `downloadEngine`（native 启动回执）
     * 都带着 `status: 'downloading'` 写字节数，而这些写入可能晚于队列把任务改成 failed/paused
     * （停滞中断、用户暂停、后台回收）。库里于是留下一条「downloading 却没人跑」的任务，
     * 30s 后被 watchdog 当成孤儿判成「下载停滞」，用户点继续再撞回原来的 402/403。
     * 状态迁移归队列，进度回写只允许 queued → downloading（引擎的异步启动回执）。
     */
    let guarded = patch;
    if (patch.status && patch.status !== current.status && current.status !== 'queued') {
      guarded = { ...patch };
      delete guarded.status;
    }
    const next: DownloadTask = { ...current, ...guarded, updatedAt: guarded.updatedAt ?? Date.now() };
    await downloadRepo.save(next);
    emitDownload({ type: 'progress', task: next });
  };

  const engine = createDownloadEngine({
    load: (id) => downloadRepo.get(id),
    saveProgress,
    // EXT-04/FR-60：转封装/字幕阶段的进度出口（HLS 收尾在下载器内部完成，走不到 status 迁移）
    onPostProcess: (task, stage, state, extra) =>
      emitDownload({ type: 'postprocess', task, stage, state, progress: extra?.progress, reason: extra?.reason }),
    /**
     * DL-P0-2：跨集产物指纹查重。同一 `mediaId` 下**另一集**的成品若与本集逐字节相同，
     * 只可能是占位素材（真机实测：6 条不同集都是同一个 881,720 字节）。
     * 同集排除是必需的——同一集从两条线路重复下载本来就内容相同，那不是占位。
     * 老任务没有 `contentDigest`（undefined），永远匹配不上，天然不参与。
     */
    findTwinArtifact: async (mediaId, taskId, digest) => {
      if (!digest) return null;
      const self = await downloadRepo.get(taskId);
      const siblings = await downloadRepo.listByMedia(mediaId);
      const twin = siblings.find(
        (t) => t.id !== taskId && t.status === 'completed' && t.episodeId !== self?.episodeId && t.contentDigest === digest,
      );
      return twin?.episodeTitle || twin?.title || null;
    },
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
    beforeStart: refreshBeforeStart,
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

/**
 * 启动/回前台把可恢复的任务重新入队（AC-72）。
 *
 * `mode`（OPT-01）：
 * - `'none'`：只入队 queued——`autoResume` 关闭时的启动/回前台，不动任何 paused。
 * - `'auto'`：入队 queued + 后台冻结暂停，但**跳过**用户手动/网络策略暂停——回前台自动恢复。
 * - `'all'`：入队 queued + 全部 paused，不论来源——用户主动「继续全部」。
 */
async function requeuePending(mode: 'none' | 'auto' | 'all' = 'none'): Promise<void> {
  const q = await ensureQueue();
  const resumableStatuses: DownloadStatus[] = mode === 'none' ? ['queued'] : ['queued', 'paused'];

  const tasks = await downloadRepo.listByStatus(resumableStatuses);
  for (const task of tasks) {
    if (task.status === 'paused') {
      // 自动恢复不复活用户主动暂停/仅WiFi强制暂停；旧记录无 pausedBy 视为后台冻结照常恢复。
      if (mode === 'auto' && (task.pausedBy === 'user' || task.pausedBy === 'network')) continue;
      // 直链过期不在这里刷：交给派发前的 `refreshBeforeStart` 统一处理（DL-P0-4）。
      // 留在这里的话同一次下载要解析两遍，而原生侧同实例串行，第二遍必被闸门挡回。
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

/* ---------------- EXT-04：设置快照与质量归一化 ---------------- */

interface DownloadPolicySnapshot {
  hlsQuality: HlsQuality;
  attachSubtitles: DownloadSubtitlePolicy;
}

/** 读取下载策略（设置读失败时用默认值，不阻断下载） */
async function policySnapshot(): Promise<DownloadPolicySnapshot> {
  try {
    const settings = await settingsService.get();
    return {
      hlsQuality: normalizeQuality(settings.download.hlsQuality),
      attachSubtitles: normalizeSubtitlePolicy(settings.download.attachSubtitles),
    };
  } catch (e) {
    logger.debug('读取下载策略失败，使用默认值', toAppError(e).message);
    return { hlsQuality: 'max', attachSubtitles: 'preferred' };
  }
}

export function normalizeQuality(value: unknown): HlsQuality {
  return value === '1080p' || value === '720p' ? value : 'max';
}

export function normalizeSubtitlePolicy(value: unknown): DownloadSubtitlePolicy {
  return value === 'all' || value === 'none' ? value : 'preferred';
}

/** 限速档位归一化（非法/缺失回落不限速） */
export function normalizeSpeedLimit(value: unknown): DownloadSpeedLimit {
  return isValidSpeedLimit(value) ? value : 'unlimited';
}

/** HLS 判定：格式为 hls，或地址后缀是 .m3u8（与引擎兜底口径一致） */
export function isHlsDownload(input: { format: MediaFormat; url: string }): boolean {
  return input.format === 'hls' || /\.m3u8(\?|$)/i.test(input.url);
}

/* ---------------- EXT-04 / FR-64：已下载字幕挂载 ---------------- */

/** Web 端字幕 ObjectURL 缓存（taskId → urls），避免每次进播放页都新建并泄漏 */
const subtitleUrlCache = new Map<string, string[]>();

const LANG_LABELS: Record<string, string> = {
  zh: '中文',
  'zh-cn': '中文',
  'zh-hans': '简体中文',
  'zh-hant': '繁体中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
};

function subtitleLabelOf(lang: string): string {
  const label = LANG_LABELS[lang.toLowerCase()] ?? lang.toUpperCase();
  return `${label}（已下载）`;
}

/** 回收某任务（或全部）已生成的字幕 ObjectURL（Web） */
export function revokeLocalSubtitleUrls(taskId?: string): void {
  const keys = taskId ? [taskId] : [...subtitleUrlCache.keys()];
  for (const key of keys) {
    const urls = subtitleUrlCache.get(key);
    if (!urls) continue;
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 忽略
      }
    }
    subtitleUrlCache.delete(key);
  }
}

/** 把 `task.subtitlePaths` 映射为 `SubtitleTrack[]`（source='downloaded'，FR-64） */
async function localSubtitlesOf(task: DownloadTask): Promise<SubtitleTrack[]> {
  const entries = task.subtitlePaths ?? [];
  if (entries.length === 0) return [];

  revokeLocalSubtitleUrls(task.id);
  const objectUrls: string[] = [];
  const tracks: SubtitleTrack[] = [];

  for (const entry of entries) {
    try {
      let url: string;
      if (task.sink === 'filesystem') {
        url = await toPlayableUrl(entry.path);
      } else {
        const blob = await readBlob(entry.path);
        if (!blob || blob.size === 0) continue;
        url = URL.createObjectURL(blob);
        objectUrls.push(url);
      }
      tracks.push({
        id: `downloaded:${entry.lang}`,
        label: subtitleLabelOf(entry.lang),
        lang: entry.lang,
        url,
        format: entry.format,
        source: 'downloaded',
      });
    } catch (e) {
      // 单条字幕挂载失败不影响视频播放（AC-151 失败隔离）
      logger.warn('已下载字幕挂载失败（忽略）', { taskId: task.id, lang: entry.lang, error: toAppError(e).message });
    }
  }

  if (objectUrls.length > 0) subtitleUrlCache.set(task.id, objectUrls);
  return tracks;
}

/** 任务最终产物路径（优先实际 filePath，转封装后 basename 才是 .mp4） */
function finalFilePathOf(task: DownloadTask): string {
  return task.filePath ?? nativeFilePathOf(task);
}

/**
 * 从已完成任务里挑出「就是这一集」的那条（P0-2）。
 *
 * 顺序：episodeId 精确 → episodeNumber 同集号（跨线路同集）→ 唯一 completed 兜底。
 * 兜底**只在调用方两个身份都没给时**生效：旧版无条件兜底会让"只下过第 1 集"的剧集
 * 在第 5 集上命中——播放页播出第 1 集的画面，下载入口更会把
 * `https://localhost/_capacitor_file_/…` 的本地地址当成下载源写进新任务。
 */
export function selectCompletedTask(
  completed: DownloadTask[],
  opts: { episodeId?: string | null; episodeNumber?: number | null },
): DownloadTask | null {
  if (completed.length === 0) return null;

  if (opts.episodeId) {
    const exact = completed.find((t) => t.episodeId === opts.episodeId);
    if (exact) return exact;
  }
  if (opts.episodeNumber != null) {
    const byNumber = completed.find((t) => t.episodeNumber === opts.episodeNumber);
    if (byNumber) return byNumber;
  }
  if (!opts.episodeId && opts.episodeNumber == null && completed.length === 1) {
    logger.warn('本地命中未提供剧集身份，回退唯一已完成任务', {
      episodeId: completed[0]!.episodeId,
      taskId: completed[0]!.id,
    });
    return completed[0]!;
  }
  return null;
}

/**
 * 同一集「创建中」的在飞请求。
 *
 * IDB 没有跨事务的唯一约束，而 `create` 的「查已有 → 落库」中间隔着两次 await：
 * 双击下载、或详情/播放两个入口同时下单，两边都会读到「还没有」，于是同一集
 * 落库两个任务（各自排队、各占一份队列容量）。按 `${mediaId}::${episodeId}`
 * 复用同一次创建即可。
 */
const createInFlight = new Map<string, Promise<{ task: DownloadTask; existed: boolean }>>();

/**
 * 创建单个下载任务的真实实现，只允许经 `create` 调用（否则绕过在飞去重）。
 *
 * EXT-04 增量（全部为可选字段，老调用方行为不变）：
 * - `input.hlsQuality` 单次覆盖设置，仅 HLS 任务落库（直链 `hlsQuality=null`，AC-147）；
 * - `input.batchId` 由 `createBatch` 注入；
 * - `extra` 为服务内部使用的附加字段（预检摘要等），不对外承诺。
 */
async function runCreate(
  input: CreateDownloadInput,
  extra?: Partial<DownloadTask>,
): Promise<{ task: DownloadTask; existed: boolean }> {
  const existing = await downloadService.findActiveByEpisode(input.mediaId, input.episodeId);
  if (existing) {
    return { task: existing, existed: true };
  }

  // 默认假设支持续传，让下载引擎在实际下载时验证（见 downloadEngine.ts 124-130 行）
  // 如果服务器不支持 Range，引擎会自动降级并更新 task.resumable
  const resumable = true;
  const policy = await policySnapshot();
  const hlsQuality = isHlsDownload(input) ? normalizeQuality(input.hlsQuality ?? policy.hlsQuality) : null;

  const now = Date.now();
  const task: DownloadTask = {
    id: cryptoRandomId(),
    sourceId: input.sourceId,
    mediaId: input.mediaId,
    episodeId: input.episodeId,
    episodeNumber: input.episodeNumber,
    lineId: input.lineId ?? null,
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
    batchId: input.batchId ?? null,
    hlsQuality,
    selectedHeight: null,
    container: null,
    remux: null,
    estimatedBytes: null,
    preflight: null,
    subtitleSelection: policy.attachSubtitles,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...(extra ?? {}),
  };
  await persist(task);
  const q = await ensureQueue();
  q.enqueue(task);
  emitDownload({ type: 'status', task, previous: 'queued' });
  await emitQueueSummary();
  return { task, existed: false };
}

export const downloadService = {
  /** 创建单个下载任务（AC-70：重复创建返回 `existed: true`；在飞期间重复调用复用同一次创建） */
  async create(input: CreateDownloadInput, extra?: Partial<DownloadTask>): Promise<{ task: DownloadTask; existed: boolean }> {
    validateInput(input);
    // OPT-18：在用户发起下载（手势上下文）时一次性请求通知权限，之后复用缓存；不在每次完成回调里弹框
    void ensureNotificationPermission();
    const key = existingKeyOf(input.mediaId, input.episodeId);
    const pending = createInFlight.get(key);
    if (pending) return pending;

    const settled = runCreate(input, extra).finally(() => {
      if (createInFlight.get(key) === settled) createInFlight.delete(key);
    });
    createInFlight.set(key, settled);
    return settled;
  },

  /** 批量创建（AC-70：50 集不卡顿 —— 分批入队并让出事件循环） */
  async createMany(inputs: CreateDownloadInput[]): Promise<{ created: DownloadTask[]; skipped: DownloadTask[] }> {
    /*
     * DL-P1-3：整批共用一个 batchId。此前经这条路创建的任务 batchId 全是 null，
     * 「下载」页按批分组时它们落进 batchId='' 的「单独下载」组，而那两个批操作按钮
     * 对空 batchId 直接 return——详情页批量下载这条真实入口上，「重试本批失败项」
     * 「删除本批已完成」点了没有任何反应。已有 batchId 的调用方（createBatch）不动。
     */
    const batchId = createBatchId();
    const scoped = inputs.map((input) => (input.batchId ? input : { ...input, batchId }));

    const created: DownloadTask[] = [];
    const skipped: DownloadTask[] = [];
    for (const [index, input] of scoped.entries()) {
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

  /**
   * EXT-04 / FR-61：批量创建（带 `batchId` 与队列容量裁决）。
   *
   * 语义（AC-144）：
   * - 单次 ≤50 集，超出 `E_INVALID_INPUT`；
   * - 已存在任务计入 `skipped`（不计入本次容量消耗）；
   * - 超出容量的集进入 `rejected`（`E_INVALID_STATE` + "队列已满(n)"），**整批不失败**；
   * - `allowOverCapacity=true` 时即使一条都没创建成功也返回结构化结果，不抛错；
   * - 每 10 条让出事件循环，保证主线程单帧 ≤50ms。
   */
  async createBatch(
    inputs: CreateDownloadInput[],
    options: { hlsQuality?: HlsQuality; batchId?: string; allowOverCapacity?: boolean; preflight?: PreflightResult } = {},
  ): Promise<{
    batchId: string;
    created: DownloadTask[];
    skipped: DownloadTask[];
    rejected: Array<{ episodeId: string; code: string; message: string }>;
    queue: { before: number; after: number; capacity: number; full: boolean };
  }> {
    assertBatchSize(inputs.length);
    // OPT-18：批量发起下载时一次性请求通知权限（与 create() 同一缓存，仅首次弹框）
    void ensureNotificationPermission();

    let capacity = resolveQueueCapacity(null);
    try {
      const settings = await settingsService.get();
      capacity = resolveQueueCapacity(settings.download);
    } catch (e) {
      logger.debug('读取队列上限失败，使用默认值', toAppError(e).message);
    }

    const all = await downloadRepo.listAll();
    const activeByKey = new Map<string, DownloadTask>();
    for (const task of all) {
      if (task.status === 'canceled') continue;
      activeByKey.set(existingKeyOf(task.mediaId, task.episodeId), task);
    }

    const before = await countOccupied(all);
    const batchId = options.batchId ?? createBatchId();
    const qualityOverride = options.hlsQuality ? normalizeQuality(options.hlsQuality) : undefined;
    const digests = new Map<string, Partial<DownloadTask>>();
    for (const item of options.preflight?.items ?? []) {
      digests.set(item.episodeId, downloadPreflight.digestOf(item));
    }

    const created: DownloadTask[] = [];
    const skipped: DownloadTask[] = [];
    const rejected: Array<{ episodeId: string; code: string; message: string }> = [];
    let occupied = before;

    for (const [index, input] of inputs.entries()) {
      const key = existingKeyOf(input.mediaId, input.episodeId);
      const existing = activeByKey.get(key);
      if (existing) {
        skipped.push(existing);
        continue;
      }
      if (occupied >= capacity) {
        rejected.push({
          episodeId: input.episodeId,
          code: 'E_INVALID_STATE',
          message: `队列已满(${capacity})，请先清理`,
        });
        continue;
      }
      const result = await this.create(
        {
          ...input,
          batchId,
          ...(qualityOverride ? { hlsQuality: qualityOverride } : {}),
        },
        digests.get(input.episodeId),
      );
      if (result.existed) {
        skipped.push(result.task);
      } else {
        created.push(result.task);
        activeByKey.set(key, result.task);
        occupied += 1;
      }
      if (index > 0 && index % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const queue = { before, after: occupied, capacity, full: occupied >= capacity };

    if (!options.allowOverCapacity && created.length === 0 && rejected.length > 0) {
      throw new AppError('E_INVALID_STATE', `队列已满(${capacity})，请先清理`);
    }

    if (created.length > 0 || skipped.length > 0 || rejected.length > 0) {
      const parts: string[] = [];
      if (created.length > 0) parts.push(`已加入 ${created.length} 集`);
      if (skipped.length > 0) parts.push(`${skipped.length} 集已存在`);
      if (rejected.length > 0) parts.push(`${rejected.length} 集因队列已满未加入`);
      appEvents.emit('toast', { text: parts.join('，'), type: rejected.length > 0 ? 'info' : 'success' });
    }

    logger.info('批量创建完成', {
      batchId,
      created: created.length,
      skipped: skipped.length,
      rejected: rejected.length,
      capacity,
    });

    return { batchId, created, skipped, rejected, queue };
  },

  /** EXT-04 / FR-61：重试批内失败项（按集号升序，canceled 不参与） */
  async retryBatch(batchId: string): Promise<{ batchId: string; retried: number; skipped: number; failedIds: string[] }> {
    const tasks = await tasksOfBatch(batchId);
    if (tasks.length === 0) throw new AppError('E_NOT_FOUND', '未找到该批次任务');
    const retryable = selectRetryable(tasks);
    if (retryable.length === 0) throw new AppError('E_INVALID_STATE', '本批没有失败项');

    const failedIds: string[] = [];
    for (const task of retryable) {
      try {
        await this.retry(task.id);
        failedIds.push(task.id);
      } catch (e) {
        logger.warn('批内重试失败（继续其余项）', {
          taskId: task.id,
          error: toAppError(e).message,
        });
      }
    }
    await emitQueueSummary();
    return {
      batchId,
      retried: failedIds.length,
      skipped: tasks.length - failedIds.length,
      failedIds,
    };
  },

  /** EXT-04 / FR-61：删除批内已完成项（含本地文件） */
  async deleteBatch(batchId: string): Promise<{ batchId: string; deleted: number }> {
    const tasks = await tasksOfBatch(batchId);
    if (tasks.length === 0) throw new AppError('E_NOT_FOUND', '未找到该批次任务');
    const completed = selectCompleted(tasks);
    let deleted = 0;
    for (const task of completed) {
      try {
        await this.remove(task.id, { deleteFile: true });
        deleted += 1;
      } catch (e) {
        logger.warn('删除批内已完成项失败（继续其余项）', {
          taskId: task.id,
          error: toAppError(e).message,
        });
      }
    }
    return { batchId, deleted };
  },

  /** EXT-04 / FR-65：下载前预检（1~50 条，不创建任务、不写库） */
  async preflight(inputs: CreateDownloadInput[], options: PreflightOptions = {}): Promise<PreflightResult> {
    assertBatchSize(inputs.length);
    return downloadPreflight.preflight(inputs, options);
  },

  /** EXT-04 / FR-65：批量预检（同 master 复用 60s 清单缓存，见 `downloadPreflight`） */
  async preflightBatch(inputs: CreateDownloadInput[], options: PreflightOptions = {}): Promise<PreflightResult> {
    assertBatchSize(inputs.length);
    return downloadPreflight.preflight(inputs, options);
  },

  /** EXT-04 / FR-63：切换全局限速档位（≤3s 生效，Android 同步下发原生桶） */
  async setSpeedLimit(limit: DownloadSpeedLimit | { limit: DownloadSpeedLimit }): Promise<SpeedLimitApplied> {
    const value = typeof limit === 'string' ? limit : limit?.limit;
    if (!isValidSpeedLimit(value)) throw new AppError('E_INVALID_INPUT', '不支持的限速档位');
    const applied = downloadRateLimiter.setLimit(value);
    try {
      await settingsService.update({ download: { speedLimit: value } });
    } catch (e) {
      logger.warn('限速档位持久化失败', toAppError(e).message);
    }
    await applyNativeSpeedLimit(applied.bytesPerSec);
    logger.info('下载限速已切换', { limit: value, bytesPerSec: applied.bytesPerSec });
    return applied;
  },

  /** 当前限速档位 */
  getSpeedLimit(): { limit: DownloadSpeedLimit; bytesPerSec: number } {
    return {
      limit: downloadRateLimiter.getLimit(),
      bytesPerSec: downloadRateLimiter.getBytesPerSec(),
    };
  },

  /** 3s 滑窗速率统计（AC-148/AC-149；UI「当前合计速率」） */
  rateStats(): RateStats {
    return downloadRateLimiter.stats();
  },

  /** 兼容命名：当前合计速率 */
  getCurrentSpeed(): RateStats {
    return downloadRateLimiter.stats();
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
    const task = await q.pause(id, 'user');
    await emitQueueSummary();
    return task;
  },

  async resume(id: string): Promise<DownloadTask> {
    const q = await ensureQueue();
    // FIX-D9：「继续」也要换掉过期直链，否则只会在同一条死链上再撞一次 402/403。
    // 这件事现在由派发前的 `refreshBeforeStart` 统一做——`resume` 迁移不清 errorCode，
    // 所以那一处一定还看得见上一次是怎么死的（DL-P0-4）。
    const task = await q.resume(id);
    await emitQueueSummary();
    return task;
  },

  /**
   * P3-1：把等待中的任务提到队列最前（下载页「置顶」）。
   *
   * 队列按 `priority` 升序、`createdAt` 升序派发，而创建时写的是 `priority = now`——
   * 也就是纯 FIFO，用户想让第 7 集先下没有任何入口。这里只改 `priority`：取所有等待中
   * 任务的最小值再减 1，保证它排在其余 queued 之前（含同批一起创建、`createdAt` 相同的兄弟集）。
   *
   * 只认 `queued`：正在跑的任务改优先级也不会更快——槽位是并发上限决定的，不是抢出来的；
   * 暂停/失败的任务则要先「继续」/「重试」回到 queued，那时会带着这个新值入队。
   */
  async bringToFront(id: string): Promise<DownloadTask> {
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    if (task.status !== 'queued') {
      throw new AppError('E_INVALID_STATE', '只有等待中的任务可以置顶', { retryable: false });
    }
    const waiting = await downloadRepo.listByStatus(['queued']);
    const lowest = waiting.reduce((min, row) => Math.min(min, row.priority), task.priority);
    const next: DownloadTask = { ...task, priority: lowest - 1, updatedAt: Date.now() };
    await persist(next);
    const q = await ensureQueue();
    q.setPriority(next.id, next.priority);
    emitDownload({ type: 'status', task: next, previous: 'queued' });
    await emitQueueSummary();
    return next;
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
    // FIX-D9：直链过期类失败先换新地址/请求头，再入队（必须在 q.retry 之前落库，
    // 队列会从库里重新读任务）。
    // 这一处不能挪到派发前：`retry` 迁移会把 errorCode 抹成 null，等 `beforeStart`
    // 再去看已经不知道上一次是怎么死的了（DL-P0-4）。抹不掉的那两条路——退避自动重试、
    // watchdog 交回——由 `refreshBeforeStart` 负责。
    if (task.status === 'failed' && task.errorCode && STALE_LINK_CODES.has(task.errorCode)) {
      // 原样回吐就不必再烧两轮退避：这一条是用户主动点的，直接把结论还给他
      if ((await refreshStaleLink(task)) === 'unchanged') {
        throw new AppError('E_SOURCE_UNAVAILABLE', STALE_UNCHANGED_MESSAGE, { retryable: false });
      }
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
    // P1-6：老数据的 `url` 可能指向本地文件桥（P0-1 之前的缺陷产物）。复用它会再得到
    // 一个 0 字节任务，这里明确拒绝——请从详情页重新发起下载。
    if (isLocalArtifactUrl(task.url)) {
      throw new AppError('E_INVALID_INPUT', LOCAL_TASK_REPAIRED_MESSAGE);
    }
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
      // EXT-04：换源重下保持批次归属、清晰度档位与附件（字幕/封面）不变
      ...(task.batchId ? { batchId: task.batchId } : {}),
      ...(task.hlsQuality ? { hlsQuality: task.hlsQuality } : {}),
      ...(task.pendingSubtitleUrls ? { subtitleUrls: task.pendingSubtitleUrls } : {}),
      ...(task.pendingCoverUrl ? { coverUrl: task.pendingCoverUrl } : {}),
    });

    logger.debug('备选 URL 任务已创建', {
      oldTaskId: id,
      newTaskId: newTask.task.id,
      newUrl: alternativeUrl,
    });

    return newTask.task;
  },

  /**
   * 删除任务（可选连带删文件）。
   *
   * `fileLeftBehind`：记录一定会消失，但文件/分块可能删不掉（只读目录、被占用、权限被撤）。
   * 这种情况下磁盘上留下的是一个看不见的孤儿文件——必须把结果交给调用方去说话，
   * 不能在这里 `.catch(() => undefined)` 假装删干净了。
   */
  async remove(id: string, opts?: { deleteFile?: boolean }): Promise<{ fileLeftBehind: boolean }> {
    const task = await downloadRepo.get(id);
    if (!task) return { fileLeftBehind: false };
    const q = await ensureQueue();

    // 下载中先取消再删除（AC-80）
    if (task.status === 'downloading' || task.status === 'queued') {
      await q.cancel(id).catch(() => undefined);
    }
    q.dequeue(id);

    let fileLeftBehind = false;
    if (opts?.deleteFile !== false) {
      if (task.blobKey) {
        fileLeftBehind = !(await blobRepo.delete(task.blobKey).then(() => true).catch(() => false));
      }
      if (task.filePath && isNative()) {
        const ok = await deleteFile(task.filePath).then(() => true).catch(() => false);
        fileLeftBehind = fileLeftBehind || !ok;
      }
      // OPT-12：未完成分块（*.part）不在 filePath 里，删除任务时一并清理，避免磁盘残片
      if (isNative()) {
        await deleteFile(nativePartPathOf(task)).catch(() => undefined);
      }
    }
    await downloadRepo.remove(id);
    await emitQueueSummary();
    return { fileLeftBehind };
  },

  async clearCompleted(): Promise<{ removed: number; filesLeftBehind: number }> {
    const completed = await downloadRepo.listByStatus(['completed']);
    let filesLeftBehind = 0;
    for (const task of completed) {
      const result = await this.remove(task.id, { deleteFile: true });
      if (result.fileLeftBehind) filesLeftBehind += 1;
    }
    return { removed: completed.length, filesLeftBehind };
  },

  /** 功能扩展-10：批量删除（AC-80） */
  async removeMany(
    ids: string[],
    opts?: { deleteFile?: boolean },
  ): Promise<{ removed: number; filesLeftBehind: number; failed: number }> {
    let count = 0;
    let filesLeftBehind = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const result = await this.remove(id, opts);
        count++;
        if (result.fileLeftBehind) filesLeftBehind += 1;
      } catch {
        // 单条失败不中断批量
        failed += 1;
      }
    }
    return { removed: count, filesLeftBehind, failed };
  },

  /** 功能扩展-10：清理失败任务 */
  async clearFailed(): Promise<{ removed: number; filesLeftBehind: number }> {
    const failedTasks = await downloadRepo.listByStatus(['failed']);
    let filesLeftBehind = 0;
    for (const task of failedTasks) {
      const result = await this.remove(task.id, { deleteFile: true });
      if (result.fileLeftBehind) filesLeftBehind += 1;
    }
    return { removed: failedTasks.length, filesLeftBehind };
  },

  /**
   * 功能扩展-10：计算存储占用（AC-79）
   *
   * 口径只认**已经落盘的字节**。旧实现把每条任务的 `totalBytes`（源站预估的成品大小）
   * 全加起来，于是「排队中/失败/取消」也算钱：预检一次 12 集、一集没下完，
   * 页面就报「本地存储 78 GB（12 个文件）」，删完文件数字还不回到 0。
   *
   * - `completed`：成品大小（`totalBytes` 缺失时回退已写字节）；
   * - `canceled`：取消走 abort，`.part` 当场删掉（`downloadQueue.cancel` → 引擎 abort 分支），
   *   落盘为 0，不计；
   * - 其余状态：只加 `downloadedBytes`，这是断点续传留着的那截残片，确实占着盘。
   */
  async calculateStorageUsage(): Promise<StorageUsage> {
    const all = await downloadRepo.listAll();
    let totalBytes = 0;
    let partialBytes = 0;
    let fileCount = 0;
    for (const task of all) {
      if (task.status === 'completed') {
        const bytes = task.totalBytes && task.totalBytes > 0 ? task.totalBytes : task.downloadedBytes;
        totalBytes += bytes;
        fileCount += 1;
        continue;
      }
      if (task.status === 'canceled') continue;
      const cap = task.totalBytes && task.totalBytes > 0 ? task.totalBytes : Number.MAX_SAFE_INTEGER;
      const leftover = Math.max(0, Math.min(task.downloadedBytes, cap));
      if (leftover === 0) continue;
      totalBytes += leftover;
      partialBytes += leftover;
    }
    return { totalBytes, fileCount, partialBytes };
  },

  /** 本地播放地址（文件缺失 → E_FILE_MISSING，AC-78；桥调用挂死 → E_TIMEOUT，P1-4） */
  async getLocalPlayUrl(id: string): Promise<LocalPlayResult> {
    const task = await downloadRepo.get(id);
    if (!task) throw new AppError('E_NOT_FOUND');
    if (task.status !== 'completed') throw new AppError('E_FILE_MISSING', '任务尚未下载完成');

    if (task.sink === 'filesystem') {
      const path = task.filePath ?? nativeFilePathOf(task);
      const info = await withTimeout(stat(path), LOCAL_RESOLVE_TIMEOUT_MS, '本地文件读取超时，请重试');
      if (!info.exists || info.size === 0) {
        throw new AppError('E_FILE_MISSING');
      }
      const url = await withTimeout(
        toPlayableUrl(path),
        LOCAL_RESOLVE_TIMEOUT_MS,
        '本地文件读取超时，请重试',
      );
      return { url, kind: 'capacitor', revoke: () => undefined };
    }

    const key = task.blobKey ?? task.id;
    const blob = await withTimeout(readBlob(key), LOCAL_RESOLVE_TIMEOUT_MS, '本地文件读取超时，请重试');
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
      const subtitles = await localSubtitlesOf(task);
      markOfflineFileInUse(task.id);
      // A-03：抽帧只认相对 Directory.Data 的路径，blob 兜底没有文件可抽
      const localPath = task.sink === 'filesystem' ? finalFilePathOf(task) : undefined;
      return {
        url: local.url,
        localPath,
        // HLS 下载已把分片合并为单一 MPEG-TS 文件，按渐进式 ts 播放即可；
        // 若仍报 'hls' 会被播放器当成清单去做 m3u8 预检而失败。
        // 转封装成功后由后端把 task.format 回写为 'mp4'，此处自然呈现 mp4。
        format: task.format === 'hls' ? 'ts' : task.format,
        headers: {},
        subtitles,
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
   * 跨线路本地查找：按 mediaId 搜索所有已完成任务，再用 episodeId / episodeNumber 匹配。
   *
   * 离线场景核心：用户从线路 A 下载了第 3 集，播放页可能落在线路 B（episodeId 不同），
   * 精确匹配 `findLocalPlay` 会 miss。匹配口径见 `selectCompletedTask`（P0-2 收紧：
   * 不再无条件用"唯一 completed 任务"兜底，避免多集影片跨集错播）。
   */
  async findLocalForMedia(
    mediaId: string,
    opts: { episodeId?: string | null; episodeNumber?: number | null },
  ): Promise<PlaybackSource | null> {
    const allTasks = await downloadRepo.listByMedia(mediaId);
    const completed = allTasks.filter((t) => t.status === 'completed');
    const task = selectCompletedTask(completed, opts);
    if (!task) {
      // 请求集与已下载集不一致时留一行线索：这类 miss 会静默转网络源，离线时表现为"加载失败"
      if (completed.length > 0 && (opts.episodeId || opts.episodeNumber != null)) {
        logger.debug('本地已完成任务不覆盖该集，回退网络源', {
          mediaId,
          episodeId: opts.episodeId ?? null,
          episodeNumber: opts.episodeNumber ?? null,
          downloaded: completed.map((t) => t.episodeNumber ?? t.episodeId),
        });
      }
      return null;
    }
    return this.taskToPlayback(task);
  },

  /** 把已完成任务转为本地 PlaybackSource（内部复用） */
  async taskToPlayback(task: DownloadTask): Promise<PlaybackSource | null> {
    try {
      const local = await this.getLocalPlayUrl(task.id);
      const subtitles = await localSubtitlesOf(task);
      markOfflineFileInUse(task.id);
      // A-03：抽帧只认相对 Directory.Data 的路径，blob 兜底没有文件可抽
      const localPath = task.sink === 'filesystem' ? finalFilePathOf(task) : undefined;
      return {
        url: local.url,
        localPath,
        format: task.format === 'hls' ? 'ts' : task.format,
        headers: {},
        subtitles,
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

  /**
   * 跨线路版本：查找 mediaId 下"已完成但本地文件丢失"的任务。
   * 匹配口径与 `findLocalForMedia` 完全一致（同一个 `selectCompletedTask`），
   * 播放页的「本地文件不可用 → 重新下载」提示条直接复用本方法（P0-2）。
   */
  async localMissingForMedia(
    mediaId: string,
    opts: { episodeId?: string | null; episodeNumber?: number | null },
  ): Promise<DownloadTask | null> {
    const allTasks = await downloadRepo.listByMedia(mediaId);
    const completed = allTasks.filter((t) => t.status === 'completed');
    const candidate = selectCompletedTask(completed, opts);
    if (!candidate) return null;

    try {
      await this.getLocalPlayUrl(candidate.id);
      return null;
    } catch {
      return candidate;
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
    await syncNativeConcurrency(n);
  },

  /** 启动/回前台恢复队列；同时接线应用生命周期（AC-72 / REV-22） */
  async bootstrap(): Promise<void> {
    downloadService.bindLifecycle();
    // OPT-07：冷启动播种真实网络类型，避免移动网络下载确认/暂停因 currentNetworkType()='unknown' 漏触发
    void primeNetworkStatus();
    // FIX-D3：启动运行时卡死 watchdog
    startWatchdog();
    // EXT-04/FR-63（AC-149）：开机把持久化档位下发给限速器（JS 桶 + 原生桶）
    try {
      const settings = await settingsService.get();
      const applied = downloadRateLimiter.setLimit(normalizeSpeedLimit(settings.download.speedLimit));
      await applyNativeSpeedLimit(applied.bytesPerSec);
    } catch (e) {
      logger.debug('启动下发限速档位失败（忽略）', toAppError(e).message);
    }
    if (!isOnline()) return;
    bootstrapped = true;
    const resumeMode: 'auto' | 'none' = (await settingsService.get()).download.autoResume ? 'auto' : 'none';
    await requeuePending(resumeMode);
  },

  /** EXT-04/FR-64：释放已下载字幕的 ObjectURL（Web；离开播放页/卸载时调用） */
  releaseLocalSubtitles(taskId?: string): void {
    revokeLocalSubtitleUrls(taskId);
  },

  /**
   * P0-3：清洗存量「地址指向本地文件」的下载任务。
   *
   * 旧版 `resolvePlay` 的唯一 completed 兜底会把播放用的
   * `https://localhost/_capacitor_file_/…` 写进新建任务的 `url`：原生与 JS 都取不到
   * 字节，于是自动重试 + 重启僵尸恢复反复入队，用户看到的就是"下载启动慢、进度一直 0"。
   * P0-1 的创建口/引擎口只管新任务，这里负责把库里已有的判成失败——必须早于
   * `checkZombieTasks()` 与 `bootstrap()` 跑，否则会被自动恢复再次入队。
   *
   * 直接写库（completed 之外的 queued/paused 都没有到 failed 的合法转移）：
   * 这属于坏数据修复，不是用户操作。
   */
  async repairLocalArtifactTasks(): Promise<number> {
    const all = await downloadRepo.listAll();
    const bad = all.filter(
      (t) =>
        (t.status === 'queued' || t.status === 'paused' || t.status === 'downloading') &&
        isLocalArtifactUrl(t.url),
    );
    if (bad.length === 0) return 0;

    const now = Date.now();
    for (const task of bad) {
      try {
        const fresh = await downloadRepo.get(task.id);
        if (!fresh || fresh.status !== task.status) continue;
        const next: DownloadTask = {
          ...fresh,
          status: 'failed',
          speedBps: 0,
          errorCode: 'E_INVALID_INPUT',
          errorMessage: LOCAL_TASK_REPAIRED_MESSAGE,
          updatedAt: now,
        };
        await persist(next);
        queue?.dequeue(next.id);
        emitDownload({ type: 'status', task: next, previous: task.status });
        logger.warn('存量本地地址任务已判失败', { taskId: next.id, url: next.url });
      } catch (e) {
        logger.warn('存量本地地址任务清洗跳过', { taskId: task.id, error: toAppError(e).message });
      }
    }
    await emitQueueSummary();
    return bad.length;
  },

  /**
   * FIX-STALL：停滞巡检入口（watchdog 定时器每 30s 调它，单测直接调同一份逻辑）。
   * 孤儿任务交回队列续传，而不是判成「下载停滞」让用户手动重试。
   */
  async checkStalledTasks(): Promise<void> {
    await runWatchdogCheck();
  },

  /**
   * REV-24：僵尸任务检测——app 重启后 "downloading" 状态的任务必然是僵尸（进程已死），
   * 标记为 failed 让用户可以重试，避免永远卡在 downloading 状态。
   * 只在真正的 app 启动时执行（由 bootstrap store 的 initDownloads 调用），
   * 不在测试中的 bootstrap() 调用时执行。
   */
  async checkZombieTasks(): Promise<void> {
    if (zombieChecked) return;
    zombieChecked = true;
    const downloadingTasks = await downloadRepo.listByStatus(['downloading']);
    const failedIds: string[] = [];
    let settledCount = 0;
    for (const task of downloadingTasks) {
      /*
       * DL-R0：`finish()` 是把 `.part` 原子改名成成品的，所以「分片索引已齐却还挂在
       * downloading」只可能是下载阶段走完、结算或转封装途中进程被强杀。判成 failed
       * 有两个后果：一句并不成立的「应用重启，下载中断」，以及 autoResume 关着时用户
       * 必须手动重试才能拿到已经下完的这一集。改判 paused 后走的就是既有的恢复通道
       * ——紧随其后的 `bootstrap()` → `requeuePending` 按 autoResume 偏好决定是否自动
       * 继续，离线时也不会提前起跑；文件真不在盘上时 sink 的采纳门槛会落空，仍旧回落
       * 到重下，不会被糊弄成「已完成」。
       */
      if (isDownloadPhaseSettled(task)) {
        try {
          const paused = transition(task, 'pause');
          paused.pausedBy = 'background';
          await persist(paused);
          emitDownload({ type: 'status', task: paused, previous: 'downloading' });
          settledCount += 1;
          logger.info('僵尸任务下载阶段已走完，按暂停交回恢复通道', {
            taskId: task.id,
            downloadedBytes: task.downloadedBytes,
            segments: `${(task.completedSegments ?? []).filter((i) => i >= 0).length}/${task.hlsTotalSegments ?? 0}`,
          });
          continue;
        } catch (e) {
          logger.warn('僵尸任务改判暂停失败，按原路径判失败', { taskId: task.id, error: toAppError(e).message });
        }
      }
      const next = transition(task, 'fail');
      next.errorMessage = '应用重启，下载中断';
      await persist(next);
      emitDownload({ type: 'status', task: next, previous: 'downloading' });
      failedIds.push(next.id);
      logger.info(`僵尸任务已标记失败: ${task.id}`);
    }
    if (settledCount > 0) await emitQueueSummary();
    // FIX-D6：autoResume 开启时，自动恢复因重启而失败的任务
    if (failedIds.length > 0) {
      try {
        const settings = await settingsService.get();
        if (settings.download.autoResume) {
          const q = await ensureQueue();
          for (const id of failedIds) {
            const task = await downloadRepo.get(id);
            if (!task || task.status !== 'failed') continue;
            const next = transition(task, 'retry');
            await persist(next);
            emitDownload({ type: 'status', task: next, previous: 'failed' });
            q.enqueue(next);
          }
          await emitQueueSummary();
          logger.info(`自动恢复 ${failedIds.length} 个僵尸任务`);
        }
      } catch (e) {
        logger.warn('自动恢复僵尸任务失败', toAppError(e).message);
      }
    }
  },

  /**
   * FIX-D8：检测被旧版 bug 标记为「已完成」但分片不完整的 HLS 任务。
   *
   * 旧版滑动窗口会静默丢弃分片结果，导致文件只有前几十个分片却标记为 completed。
   * 这里扫描 format='hls' && status='completed' 且 hlsTotalSegments 已记录的任务，
   * 索引数量不足时以磁盘产物为准分流处理：
   * - 产物体积对得上记录字节 → 只是进度写入的 1s 节流没把最后一段索引落库
   *   （D8 的完成前硬校验已保证全部写入），补全索引即可，任务保持 completed；
   * - 产物缺失或短于记录字节 → 才是真正的假完成，降级为 paused 让续传补齐。
   * 对于没有 hlsTotalSegments 的旧记录（本次修复前已完成的），无法自动检测，需用户手动重下。
   *
   * 逐任务 try/catch：这条自检跑在 `initDownloads()` 里，任何一条记录抛错都会
   * 连带跳过后续启动步骤（队列 bootstrap、离线文件优化），所以坏数据只能跳过。
   */
  async checkCorruptedHlsTasks(): Promise<void> {
    const completedHls = (await downloadRepo.listByStatus(['completed'])).filter(
      (t) => t.format === 'hls' && t.hlsTotalSegments != null,
    );
    let repaired = 0;
    for (const task of completedHls) {
      try {
        const total = task.hlsTotalSegments!;
        const doneCount = (task.completedSegments ?? []).filter((i) => i >= 0).length;
        if (doneCount >= total) continue;

        // 产物是权威：文件存在且不小于已记录字节，说明分片其实齐了，索引只是落后
        const recordedBytes = task.downloadedBytes ?? 0;
        const info = task.filePath ? await stat(task.filePath) : null;
        const artifactOk = Boolean(info?.exists) && recordedBytes > 0 && info!.size >= recordedBytes;
        if (artifactOk) {
          const fresh = await downloadRepo.get(task.id);
          if (!fresh) continue;
          await persist({
            ...fresh,
            completedSegments: Array.from({ length: total }, (_, i) => i),
            updatedAt: Date.now(),
          });
          logger.debug(`HLS 索引补齐: ${task.id}（${doneCount}/${total}，产物完整）`);
          continue;
        }

        // 产物确实缺斤短两 → 降级续传。completed 是终态，transition 表按设计
        // 拒绝 paused，这里属于数据修复而非用户操作，直接写库。
        const fresh = await downloadRepo.get(task.id);
        if (!fresh) continue;
        const next: DownloadTask = {
          ...fresh,
          status: 'paused',
          speedBps: 0,
          errorCode: null,
          errorMessage: `分片不完整（${doneCount}/${total}），请重新继续下载`,
          updatedAt: Date.now(),
        };
        await persist(next);
        emitDownload({ type: 'status', task: next, previous: 'completed' });
        repaired += 1;
        logger.warn(`修复假完成 HLS 任务: ${task.id}（${doneCount}/${total}）`);
      } catch (e) {
        logger.warn(`HLS 完整性自检跳过任务 ${task.id}`, toAppError(e).message);
      }
    }
    if (repaired > 0) {
      logger.info(`共修复 ${repaired} 个假完成 HLS 任务`);
    }
  },

  /**
   * 订阅前后台切换（AC-72 / REV-22）：
   * - Android（原生）：进后台不暂停，继续下载（前台 Service 保活，OPT-09 按队列状态起停）
   * - Web：进后台时暂停下载（WebView 可能被冻结）
   * - 回前台：`settings.download.autoResume` 为 true 时自动恢复，否则等用户手动继续。
   * 重复调用幂等（`bootstrap()` 可能被多次触发）。
   */
  bindLifecycle(): void {
    if (lifecycleUnbind) return;
    if (!networkUnbind) {
      networkUnbind = onNetworkChange(() => {
        void enforceWifiOnlyOnCellular().catch(() => undefined);
      });
    }
    lifecycleUnbind = onAppStateChange((state) => {
      if (state === lastLifecycleState) return;
      lastLifecycleState = state;
      if (state === 'background') {
        if (isNative()) {
          // FIX-D4 / OPT-09：Android 后台不暂停下载，但前台 Service 只在真有在飞任务时起
          void syncKeepAliveIfBackground().then(() => {
            logger.debug('进入后台，Android 按队列状态同步前台 Service');
          });
        } else {
          // Web：暂停下载（WebView 可能被冻结）
          void downloadService.pauseAll('background').catch((e: unknown) => {
            logger.warn('切后台暂停下载失败', toAppError(e));
          });
          appEvents.emit('toast', {
            text: '下载已暂停，切回前台可继续',
            type: 'info',
          });
        }
        return;
      }
      // 回前台：停止前台 Service（Web 后台已整体暂停，无需额外释放）
      if (isNative()) {
        void stopForegroundServiceSafe().catch(() => undefined);
      }
      void downloadService.autoResumeFromBackground().catch((e: unknown) => {
        logger.warn('回前台恢复下载失败', toAppError(e));
      });
    });
  },

  async pauseAll(reason: DownloadPausedBy): Promise<void> {
    const q = await ensureQueue();
    await q.pauseAll(reason);
    // 队列里没有的"下载中"任务（如后台被系统冻结后队列已清空）也要落成"已暂停"，
    // 保证 AC-72「所有下载中 → 已暂停且进度保留」不留漏网任务。同样落 pausedBy 来源。
    const leftover = await downloadRepo.listByStatus(['downloading']);
    for (const task of leftover) {
      try {
        const next = transition(task, 'pause');
        next.pausedBy = reason;
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

  /** 用户主动「继续全部」：复活全部暂停任务，不论来源，也不受 autoResume 设置约束 */
  async resumeAll(): Promise<void> {
    await requeuePending('all');
  },

  /**
   * 回前台自动恢复：仅当 `autoResume` 开启，且不复活用户手动/网络策略暂停的任务（OPT-01）。
   * 与 `resumeAll`（「继续全部」按钮）分开——后者表达的是用户明确的一次性恢复意图。
   */
  async autoResumeFromBackground(): Promise<void> {
    const settings = await settingsService.get();
    if (!settings.download.autoResume) return;
    await requeuePending('auto');
  },

  /**
   * 「清空全部数据」前置：停止队列并删除全部已下载文件（OPT-02）。
   *
   * 此前 `resetAllData` 只在 IndexedDB 层清 downloads/blobs 两张表：既不取消在飞下载
   * （内存队列会继续跑，甚至把已删任务写回库里），也不删原生下载目录里的真实视频，
   * 留下看不见的孤儿大文件。这里按「清空全部」语义逐条 `remove`（取消 + 删 blob + 删成品文件），
   * 再销毁内存队列（active/pending/pausedSet 全清），后续操作由 `ensureQueue` 重建空队列。
   *
   * 仅删除本 App 下载目录下的成品与未完成分块（*.part），绝不触碰 /sdcard/TVBox 等外部路径。
   */
  async stopAndDeleteAllFiles(): Promise<{ removed: number; filesLeftBehind: number }> {
    const all = await downloadRepo.listAll();
    let filesLeftBehind = 0;
    for (const task of all) {
      // remove() 现已连带删除成品文件、Blob 与未完成分块（OPT-12）
      const result = await this.remove(task.id, { deleteFile: true });
      if (result.fileLeftBehind) filesLeftBehind += 1;
    }
    // 丢弃内存队列：清空后不得再有在飞下载，也不得残留 pausedSet 让任务"复活"
    queue?.dispose();
    queue = null;
    await emitQueueSummary();
    return { removed: all.length, filesLeftBehind };
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
      // Android：写入文件系统（与最终视频文件同目录同 basename，FR-64）
      const { arrayBufferToBase64, writeBase64, ensureDir } = await import('@/native/fs');
      const subtitlePath = `${finalFilePathOf(task).replace(/\.[^.]+$/, '')}.${lang}.${format}`;
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
      const coverPath = `${finalFilePathOf(task).replace(/\.[^.]+$/, '')}.cover.jpg`;
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
    const expectedSubtitles = input.subtitleUrls?.length ?? 0;
    if (expectedSubtitles > 0) {
      emitDownload({ type: 'postprocess', task, stage: 'subtitles', state: 'start' });
    }

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

    // FR-64：字幕阶段结果上报（失败隔离——视频任务保持 completed，只标注字幕状态）
    if (expectedSubtitles > 0) {
      const failedCount = expectedSubtitles - subtitlePaths.length;
      emitDownload({
        type: 'postprocess',
        task,
        stage: 'subtitles',
        state: subtitlePaths.length === 0 ? 'failed' : failedCount > 0 ? 'progress' : 'done',
        progress: subtitlePaths.length / expectedSubtitles,
        reason: failedCount > 0 ? `missing-${failedCount}` : undefined,
      });
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
    networkUnbind?.();
    networkUnbind = null;
    lastLifecycleState = 'active';
    foregroundServiceActive = false;
    stopWatchdog();
    queue?.dispose();
    queue = null;
    listeners.clear();
    orphanRequeueStreak.clear();
    bootstrapped = false;
    // 启动一次性闸门放回未触发：与 `bootstrapped` 同一语义，否则用例里第二次
    // `checkZombieTasks()` 直接 return，分类结果永远断不到。
    zombieChecked = false;
    setDownloadEngine(null);
  },
};

/* ---------------- FIX-D3：运行时卡死 watchdog ---------------- */

/** 启动 watchdog 定时器（30s 检查一次，90s 无进度判定卡死） */
function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void runWatchdogCheck();
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * 孤儿任务被交回队列的次数（每次 app 启动重新计数）。
 * 超限才按老路判失败，避免真正跑不动的任务无限自我重入。
 */
const orphanRequeueStreak = new Map<string, number>();
const ORPHAN_REQUEUE_LIMIT = 3;

async function runWatchdogCheck(): Promise<void> {
  try {
    if (!queue) return;
    const tasks = await downloadRepo.listByStatus(['downloading']);
    const now = Date.now();
    const requeuedIds = new Set<string>();
    for (const task of tasks) {
      if (now - task.updatedAt < WATCHDOG_STALE_MS) continue;
      if (queue.isActive(task.id)) {
        // runner 还在但没进度 → 强制 abort 触发重试
        queue.abortTask(task.id, `停滞 ${Math.round((now - task.updatedAt) / 1000)}s`);
        logger.warn('watchdog: 强制中断停滞任务', { taskId: task.id, staleSec: Math.round((now - task.updatedAt) / 1000) });
        continue;
      }

      /**
       * 「downloading 但队列里没有 runner」不等于停滞，它意味着没人对这个任务负责：
       * 上次会话被系统回收、退避期间被迟到的进度回写复活……直接判失败就是用户看到的
       * 「下载停滞（watchdog 检测）」，再接一句毫无意义的「重试」。交回队列按断点续传。
       * 直链过期不在这里管：`pause`/`resume` 两个迁移都不清 errorCode，交回后派发前的
       * `refreshBeforeStart` 一定看得见死因（DL-P0-4；此前这句注释是错的，所以孤儿
       * 交回每次都拿着同一个过期签名再撞一次 402）。
       */
      if (!isOnline()) continue; // 离线时不动它，网络策略那条路负责暂停与归还

      const streak = (orphanRequeueStreak.get(task.id) ?? 0) + 1;
      orphanRequeueStreak.set(task.id, streak);

      if (streak <= ORPHAN_REQUEUE_LIMIT) {
        const stopped = transition(task, 'pause');
        stopped.pausedBy = 'background';
        await downloadRepo.save(stopped);
        emitDownload({ type: 'status', task: stopped, previous: 'downloading' });
        const requeued = transition(stopped, 'resume');
        await downloadRepo.save(requeued);
        emitDownload({ type: 'status', task: requeued, previous: 'paused' });
        queue.enqueue(requeued);
        requeuedIds.add(task.id);
        void emitQueueSummary();
        logger.warn('watchdog: 无人负责的 downloading 已交回队列续传', { taskId: task.id, streak });
        continue;
      }

      // 反复交回仍无人跑 → 判失败，保留原有可见文案供上报
      const next = transition(task, 'fail');
      next.errorMessage = '下载停滞（watchdog 检测）';
      await downloadRepo.save(next);
      emitDownload({ type: 'status', task: next, previous: 'downloading' });
      void emitQueueSummary();
      logger.warn('watchdog: 孤儿任务已标记失败', { taskId: task.id, streak });
    }
    // 计数只在"还可能继续被巡检"期间保留：这一轮里仍是 downloading、或刚被交回队列的，
    // 保留计数（否则交回后短暂处于 queued 会让次数被抹平，判失败的兜底就永远走不到）；
    // 已经跑起来/完成/失败/取消的任务清零，避免历史计数带到下一轮。
    const touched = new Set([...tasks.map((t) => t.id), ...requeuedIds]);
    for (const id of [...orphanRequeueStreak.keys()]) {
      if (!touched.has(id)) orphanRequeueStreak.delete(id);
    }
  } catch (e) {
    logger.warn('watchdog 检查异常', toAppError(e).message);
  }
}

/* ---------------- FIX-D4：Android 前台 Service 保活（OPT-09：按需持有） ---------------- */

let foregroundServiceActive = false;

/** 真正会搬字节的状态——排队中/下载中；暂停与终态不需要任何后台保活 */
const KEEP_ALIVE_STATUSES: DownloadStatus[] = ['queued', 'downloading'];

async function hasKeepAliveWork(): Promise<boolean> {
  const busy = await downloadRepo.listByStatus(KEEP_ALIVE_STATUSES);
  return busy.length > 0;
}

async function startForegroundServiceIfNeeded(): Promise<void> {
  if (!isNative() || foregroundServiceActive) return;
  // OPT-09：只在真有在飞任务时起前台服务。此前进后台无条件启动，队列全暂停/全完成时
  // 也会挂一条"下载中"的常驻通知，并把进程白保活整个后台期。
  if (!(await hasKeepAliveWork())) return;
  try {
    const { nativeDownloadStartForegroundService } = await import('@/native/downloadPlugin');
    await nativeDownloadStartForegroundService();
    foregroundServiceActive = true;
    logger.debug('前台 Service 已启动');
  } catch (e) {
    logger.warn('启动前台 Service 失败', toAppError(e).message);
  }
  // P0-2：原生侧现在不会因前台资格被拒而抛（那条路会把进程带走），所以 bridge 即使 resolve
  // 也可能只代表「申请已发出」。真被拒时这一轮后台窗口没有保活，下载仍在跑但可能被系统回收；
  // 回前台 `stopForegroundServiceSafe()` 会把标记清掉，下次转后台重新申请——不需要额外重试环。
}

async function stopForegroundServiceSafe(): Promise<void> {
  if (!isNative() || !foregroundServiceActive) return;
  try {
    const { nativeDownloadStopForegroundService } = await import('@/native/downloadPlugin');
    await nativeDownloadStopForegroundService();
    foregroundServiceActive = false;
    logger.debug('前台 Service 已停止');
  } catch (e) {
    logger.warn('停止前台 Service 失败', toAppError(e).message);
  }
}

/**
 * OPT-09：后台保活跟着队列实际状态收敛。
 *
 * 前台服务只在「后台 + 有在飞任务」时持有，任务跑空/被暂停就收回。
 * Web 端不参与：切后台一律 `pauseAll('background')`，没有在飞的量就没有值得撑住屏幕的东西
 * （此前那里无条件申请 Wake Lock，纯属耗电）。回前台由 `bindLifecycle` 显式停止。
 */
async function syncKeepAlive(): Promise<void> {
  if (!(await hasKeepAliveWork())) {
    await stopForegroundServiceSafe();
    return;
  }
  await startForegroundServiceIfNeeded();
}

function syncKeepAliveIfBackground(): Promise<void> {
  if (!isNative() || lastLifecycleState !== 'background') return Promise.resolve();
  return syncKeepAlive().catch((e: unknown) => {
    logger.debug('后台保活同步失败（忽略）', toAppError(e).message);
  });
}

/* ---------------- 下载完成通知（OPT-18：权限一次性请求、完成回调只静默检查） ---------------- */
/** 通知权限决议缓存：每会话只在首次「发起下载」时弹框一次，之后复用结果。 */
let notifPermission: 'unknown' | 'granted' | 'denied' = 'unknown';

/**
 * 确保通知权限：应在用户发起下载（手势上下文）时调用一次，而非每次下载完成时反复请求。
 * 已拒绝时只静默 `checkPermissions` 复查（用户在系统设置里开启后能恢复），不再弹框。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (notifPermission === 'granted') return true;
  try {
    if (isNative()) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      if (notifPermission === 'denied') {
        const check = await LocalNotifications.checkPermissions();
        notifPermission = check.display === 'granted' ? 'granted' : 'denied';
      } else {
        const permission = await LocalNotifications.requestPermissions();
        notifPermission = permission.display === 'granted' ? 'granted' : 'denied';
      }
    } else {
      if (typeof Notification === 'undefined') {
        notifPermission = 'denied';
        return false;
      }
      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        notifPermission = permission === 'granted' ? 'granted' : 'denied';
      } else {
        notifPermission = Notification.permission === 'granted' ? 'granted' : 'denied';
      }
    }
  } catch (e) {
    logger.debug('请求通知权限失败', e);
    notifPermission = 'denied';
  }
  return notifPermission === 'granted';
}

async function sendDownloadCompleteNotification(task: DownloadTask): Promise<void> {
  const title = task.episodeTitle ? `${task.title} - ${task.episodeTitle}` : task.title;
  const body = '下载完成';

  // 完成回调里绝不弹框请求权限：仅静默检查已授予状态（OPT-18）
  if (isNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const check = await LocalNotifications.checkPermissions();
      if (check.display !== 'granted') {
        logger.debug('通知权限未授予，跳过完成通知');
        return;
      }
      await LocalNotifications.schedule({
        notifications: [
          {
            id: hashStringToInt(task.id),
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
    if (typeof Notification === 'undefined') {
      logger.debug('Notification API 不可用');
      return;
    }
    try {
      if (Notification.permission !== 'granted') {
        logger.debug('通知权限未授予，跳过完成通知');
        return;
      }
      new Notification(title, { body, silent: false });
      logger.debug('Web 通知已发送', { taskId: task.id });
    } catch (e) {
      logger.warn('发送 Web 通知失败', e);
    }
  }
}

/**
 * 字符串 → 非负 int32 哈希（OPT-18：替换旧的 `String.prototype.hashCode` 原型污染）。
 *
 * 旧实现 `Math.abs(hash)` 对 `INT_MIN` 仍返回负数，会让 Android 通知 id 变负而调度异常；
 * 这里先 `>>> 0` 取无符号再对 Integer.MAX_VALUE 取模，结果恒落在 [0, 2147483646]。
 * 纯函数、不改任何原型。
 */
function hashStringToInt(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % 2147483647;
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
