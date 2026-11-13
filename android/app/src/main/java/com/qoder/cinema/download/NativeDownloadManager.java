package com.qoder.cinema.download;

import android.content.Context;
import android.util.Log;

import com.qoder.cinema.DownloadPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生下载管理器（Phase 1 核心）
 *
 * 职责：
 * - 管理多个下载任务（并发控制）
 * - 每个任务用 RangeDownloader 执行实际下载
 * - 通过 DownloadPlugin 回调 JS 进度/状态
 * - 单例模式，全局唯一
 *
 * 并发策略：
 * - 默认 2 个并发（与 JS 侧 DOWNLOAD_DEFAULT_CONCURRENCY 一致）
 * - 超过并发限制的任务进入等待队列
 *
 * DEV-04 / D-01 / AND-14：原生 HLS 分支已移除。
 * 原 `HlsDownloader` 不处理 EXT-X-KEY（TODO: AES-128），会把加密流写成
 * 无法播放的文件后仍回调 completed，属于"看起来可用但产出坏文件"的路径。
 * 现在所有 m3u8 在 `start()` 入口直接拒绝（抛 UnsupportedOperationException，
 * 由 DownloadPlugin 转成 reject），由 JS 侧 HlsDownloader 全量接手；
 * 原生层不再产生任何 HLS 输出文件。
 *
 * DEV-04 / AND-16：所有下载任务（含排队/暂停）统一登记在 pendingTasks /
 * activeDownloads / pausedTasks 三张表里，统一受 `maxConcurrent` 闸门约束（可由
 * JS 侧 `download.concurrency` 下发，见 {@link #setMaxConcurrent}），
 * 暂停、恢复、取消对排队任务与执行中任务语义一致。
 *
 * EXT-04 / FR-60（HLS→MP4 转封装）**不在本类实现**，原因有两条硬约束：
 * 1. §8.1 禁止改动 `DownloadPlugin.start` 签名，本类拿不到"是否转封装"的入参，
 *    原生侧也没有 `settings.download.remuxToMp4` 的读取通道（设置只存在于 JS/IndexedDB）；
 * 2. 本类只处理直链（m3u8 已在 `start()` 入口硬拒，AND-14），产物不可能是 `.ts`。
 * 因此转封装统一由 JS 编排层在 HLS 完成后调用 `MediaTool.remuxMp4`（D-06），
 * 本类只承担一件事：转封装进行中不被 `stopServiceIfIdle()` 停掉前台服务。
 */
public class NativeDownloadManager {

    private static final String TAG = "NativeDownloadMgr";
    /** 与 JS 侧 DOWNLOAD_DEFAULT_CONCURRENCY 一致 */
    private static final int DEFAULT_MAX_CONCURRENT = 2;
    /**
     * 并发上限：设置页只给 1/2/3 三档（且受 §原生线程池硬限制约束），
     * 留出 4 作为天花板，池子按它预建，闸门按 `maxConcurrent` 动态收紧。
     */
    private static final int MAX_CONCURRENT_CEILING = 4;

    private static NativeDownloadManager instance;
    private final Context context;
    private final ExecutorService executor;
    /**
     * 实际并发闸门。此前是 `MAX_CONCURRENT` 常量，导致设置页的
     * `download.concurrency` 在原生直链上完全不起作用（JS 队列认、原生不认）。
     */
    private volatile int maxConcurrent = DEFAULT_MAX_CONCURRENT;
    private final Map<String, RangeDownloader> activeDownloads;
    private final Map<String, DownloadTask> pendingTasks;
    /** DEV-04 / AND-16：排队中被暂停的任务（既不在 active 也不再参与调度） */
    private final Map<String, DownloadTask> pausedTasks;
    /** DEV-04 / AND-16：已登记任务（用于暂停时取回原始 url/headers，终态时清理） */
    private final Map<String, DownloadTask> taskRegistry;
    private final List<DownloadStatus> completedStatuses;
    private DownloadPlugin plugin;

    private NativeDownloadManager(Context context) {
        this.context = context.getApplicationContext();
        this.executor = Executors.newFixedThreadPool(MAX_CONCURRENT_CEILING);
        this.activeDownloads = new ConcurrentHashMap<>();
        this.pendingTasks = new ConcurrentHashMap<>();
        this.pausedTasks = new ConcurrentHashMap<>();
        this.taskRegistry = new ConcurrentHashMap<>();
        this.completedStatuses = new ArrayList<>();
    }

    public static synchronized NativeDownloadManager getInstance(Context context) {
        if (instance == null) {
            instance = new NativeDownloadManager(context);
        }
        return instance;
    }

    public void setPlugin(DownloadPlugin plugin) {
        this.plugin = plugin;
    }

    /**
     * 下发并发闸门（EXT-04 / FR-62）：`download.concurrency` 此前只驱动 JS 队列，
     * 原生直链恒为 2，用户调档没有任何可见效果。
     *
     * 调高时立刻把等待队列填到新闸门；调高不需要停任务，调低只影响后续调度
     * （进行中的任务不中断，避免半截 .part 反复续传）。
     */
    public void setMaxConcurrent(int value) {
        int next = Math.max(1, Math.min(MAX_CONCURRENT_CEILING, value));
        if (next == maxConcurrent) {
            return;
        }
        maxConcurrent = next;
        Log.d(TAG, "Native concurrency gate -> " + next);
        for (int i = activeDownloads.size(); i < next; i++) {
            scheduleNextTask();
        }
    }

    // ========== 公开 API ==========

    /**
     * 启动下载任务
     *
     * @throws UnsupportedOperationException URL 为 m3u8（HLS）时抛出：
     *         原生 HLS 分支已按 D-01 / AND-14 移除，必须由 JS 下载器接手。
     */
    public void start(String taskId, String url, String filePath, Map<String, String> headers,
                      long startBytes, long totalBytes) {
        // D-01 / AND-14：入口硬封禁 HLS。旧 HlsDownloader 不处理 EXT-X-KEY，
        // 会把加密流写成坏文件后仍回调 completed；这里直接拒绝，原生层零输出。
        if (isHlsUrl(url)) {
            com.qoder.cinema.AppLog.w(TAG, "Reject HLS task in native downloader: " + taskId);
            throw new UnsupportedOperationException(
                    "HLS_MUST_USE_JS_DOWNLOADER: native HLS download is disabled");
        }

        RangeDownloader running = activeDownloads.get(taskId);
        if (running != null) {
            DownloadTask paused = pausedTasks.remove(taskId);
            if (paused == null) {
                com.qoder.cinema.AppLog.w(TAG, "Task already exists: " + taskId);
                return;
            }
            // 暂停中的任务收到 start（JS 侧续传）：登记一份新任务，旧线程退出后由调度接手
            DownloadTask restarted = new DownloadTask(taskId, url, filePath, headers, startBytes, totalBytes);
            taskRegistry.put(taskId, restarted);
            pendingTasks.put(taskId, restarted);
            Log.d(TAG, "Resuming paused task via start: " + taskId);
            if (activeDownloads.get(taskId) != running && activeDownloads.size() < maxConcurrent) {
                // 旧实例已在检查与登记之间退出，直接调度
                executeTask(restarted);
            }
            DownloadService.start(context);
            return;
        }

        // REV-42 修复：排队中被暂停的任务（同时在 pendingTasks 和 pausedTasks），
        // 收到 start() 时不应直接 return，而应走下方正常路径清除 pausedTasks 并重新调度。
        if (pendingTasks.containsKey(taskId) && !pausedTasks.containsKey(taskId)) {
            com.qoder.cinema.AppLog.w(TAG, "Task already exists: " + taskId);
            return;
        }

        DownloadTask task = new DownloadTask(taskId, url, filePath, headers, startBytes, totalBytes);
        taskRegistry.put(taskId, task);
        pausedTasks.remove(taskId);
        pendingTasks.put(taskId, task);

        // 检查是否可以立即执行
        if (activeDownloads.size() < maxConcurrent) {
            executeTask(task);
        } else {
            Log.d(TAG, "Task queued (concurrent limit reached): " + taskId);
        }

        // 确保前台服务运行
        DownloadService.start(context);
    }

    /**
     * 暂停下载任务
     */
    public void pause(String taskId) {
        DownloadTask task = taskRegistry.get(taskId);
        RangeDownloader downloader = activeDownloads.get(taskId);
        if (downloader != null) {
            downloader.pause();
            if (task != null) {
                pausedTasks.put(taskId, task);
            }
        } else if (pendingTasks.containsKey(taskId) && task != null) {
            // 排队任务暂停：任务记录保留，调度时跳过（resume 后重新参与调度）
            pausedTasks.put(taskId, task);
        }
        stopServiceIfIdle();
    }

    /**
     * 恢复下载任务
     */
    public void resume(String taskId) {
        DownloadTask pausedTask = pausedTasks.remove(taskId);
        RangeDownloader downloader = activeDownloads.get(taskId);

        if (downloader != null) {
            // 执行中任务：清除暂停标记，并登记续传任务；
            // 旧线程退出后由 scheduleNextTask 统一重新调度，避免两个实例同时写 .part。
            downloader.resume();
            if (pausedTask != null) {
                pendingTasks.put(taskId, pausedTask);
            }
        } else if (pausedTask != null) {
            // 排队中暂停 / 已退出执行的任务：重新参与调度
            pendingTasks.put(taskId, pausedTask);
            if (activeDownloads.size() < maxConcurrent) {
                executeTask(pausedTask);
            }
        }

        DownloadService.start(context);
    }

    /**
     * 取消下载任务
     */
    public void cancel(String taskId) {
        RangeDownloader downloader = activeDownloads.get(taskId);
        if (downloader != null) {
            downloader.cancel();
        }
        pendingTasks.remove(taskId);
        pausedTasks.remove(taskId);
        taskRegistry.remove(taskId);

        // 检查是否还有活跃任务
        stopServiceIfIdle();
    }

    /**
     * 获取所有任务状态
     */
    public List<DownloadStatus> getAllStatus() {
        List<DownloadStatus> result = new ArrayList<>();

        // 活跃任务
        for (RangeDownloader downloader : activeDownloads.values()) {
            result.add(downloader.getStatus());
        }

        // 等待中的任务
        for (DownloadTask task : pendingTasks.values()) {
            if (!activeDownloads.containsKey(task.taskId)) {
                DownloadStatus status = new DownloadStatus();
                status.taskId = task.taskId;
                status.state = pausedTasks.containsKey(task.taskId) ? "paused" : "queued";
                status.downloadedBytes = task.startBytes;
                status.totalBytes = task.totalBytes;
                status.speedBps = 0;
                result.add(status);
            }
        }

        // 已完成的任务（最近 50 条）
        int start = Math.max(0, completedStatuses.size() - 50);
        result.addAll(completedStatuses.subList(start, completedStatuses.size()));

        return result;
    }

    // ========== 内部方法 ==========

    private void executeTask(DownloadTask task) {
        pendingTasks.remove(task.taskId);

        RangeDownloader downloader = new RangeDownloader(
                context, task, this::onProgress, this::onCompleted, this::onError
        );
        activeDownloads.put(task.taskId, downloader);

        executor.submit(() -> {
            try {
                downloader.execute();
            } catch (Exception e) {
                com.qoder.cinema.AppLog.e(TAG, "Task execution failed: " + task.taskId, e);
                onError(task.taskId, "E_UNKNOWN", e.getMessage());
            } finally {
                // 两参 remove：只清理自己，避免覆盖暂停恢复后登记的新实例
                activeDownloads.remove(task.taskId, downloader);
                // 尝试执行下一个等待中的任务
                scheduleNextTask();
            }
        });
    }

    /**
     * 检测是否为 HLS URL（原生不支持，仅用于入口拒绝）
     */
    private boolean isHlsUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.contains(".m3u8") || lower.contains(".m3u");
    }

    private void scheduleNextTask() {
        if (activeDownloads.size() < maxConcurrent) {
            for (DownloadTask next : pendingTasks.values()) {
                if (pausedTasks.containsKey(next.taskId)) continue;
                if (activeDownloads.containsKey(next.taskId)) continue;
                executeTask(next);
                return;
            }
        }
        stopServiceIfIdle();
    }

    /**
     * 无活跃任务且无待执行任务时停止前台服务。
     *
     * EXT-04 / FR-60：转封装期间**不停服务**。原生下载器的产物永远是直链文件
     * （`start()` 已硬拒 m3u8，见 AND-14），`.ts` 只可能由 JS 侧 HlsDownloader 产生，
     * 转封装由 JS 编排（技术方案 D-06 / §8.3.4）调用 `MediaTool.remuxMp4`。
     * 该调用会先 `DownloadService.beginPostprocess()`，这里据此让服务存活到
     * `MediaRemuxer` 完成，避免进程被回收留下 `.mp4.part` 残留。
     */
    public void stopServiceIfIdle() {
        if (DownloadService.isPostprocessing()) {
            com.qoder.cinema.AppLog.d(TAG, "Keep foreground service: remux in progress");
            return;
        }
        boolean hasRunnablePending = false;
        for (DownloadTask task : pendingTasks.values()) {
            if (!pausedTasks.containsKey(task.taskId)) {
                hasRunnablePending = true;
                break;
            }
        }
        if (activeDownloads.isEmpty() && !hasRunnablePending) {
            DownloadService.stop(context);
        }
    }

    private void onProgress(String taskId, long downloadedBytes, long totalBytes, long speedBps) {
        if (plugin != null) {
            plugin.emitProgress(taskId, downloadedBytes, totalBytes, speedBps);
        }
    }

    private void onCompleted(String taskId, String filePath, long totalBytes) {
        taskRegistry.remove(taskId);
        pausedTasks.remove(taskId);
        pendingTasks.remove(taskId);

        if (plugin != null) {
            plugin.emitCompleted(taskId, filePath, totalBytes);
        }

        // 记录完成状态
        DownloadStatus status = new DownloadStatus();
        status.taskId = taskId;
        status.state = "completed";
        status.downloadedBytes = totalBytes;
        status.totalBytes = totalBytes;
        status.speedBps = 0;
        synchronized (completedStatuses) {
            completedStatuses.add(status);
            // 只保留最近 100 条
            if (completedStatuses.size() > 100) {
                completedStatuses.remove(0);
            }
        }
    }

    private void onError(String taskId, String errorCode, String errorMessage) {
        taskRegistry.remove(taskId);
        pausedTasks.remove(taskId);
        pendingTasks.remove(taskId);

        if (plugin != null) {
            plugin.emitError(taskId, errorCode, errorMessage);
        }

        // 记录错误状态
        DownloadStatus status = new DownloadStatus();
        status.taskId = taskId;
        status.state = "failed";
        status.errorCode = errorCode;
        status.errorMessage = errorMessage;
        synchronized (completedStatuses) {
            completedStatuses.add(status);
        }
    }

    // ========== 数据结构 ==========

    static class DownloadTask {
        final String taskId;
        final String url;
        final String filePath;
        final Map<String, String> headers;
        final long startBytes;
        final long totalBytes;

        DownloadTask(String taskId, String url, String filePath, Map<String, String> headers,
                     long startBytes, long totalBytes) {
            this.taskId = taskId;
            this.url = url;
            this.filePath = filePath;
            this.headers = headers;
            this.startBytes = startBytes;
            this.totalBytes = totalBytes;
        }
    }

    public static class DownloadStatus {
        public String taskId;
        public String state; // queued, downloading, paused, completed, failed, canceled
        public long downloadedBytes;
        public long totalBytes;
        public long speedBps;
        public String errorCode;
        public String errorMessage;
    }
}
