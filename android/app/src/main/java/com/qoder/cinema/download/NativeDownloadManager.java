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
 * activeDownloads / pausedTasks 三张表里，统一受 MAX_CONCURRENT 闸门约束，
 * 暂停、恢复、取消对排队任务与执行中任务语义一致。
 */
public class NativeDownloadManager {

    private static final String TAG = "NativeDownloadMgr";
    private static final int MAX_CONCURRENT = 2;

    private static NativeDownloadManager instance;
    private final Context context;
    private final ExecutorService executor;
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
        this.executor = Executors.newFixedThreadPool(MAX_CONCURRENT);
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
            if (activeDownloads.get(taskId) != running && activeDownloads.size() < MAX_CONCURRENT) {
                // 旧实例已在检查与登记之间退出，直接调度
                executeTask(restarted);
            }
            DownloadService.start(context);
            return;
        }

        if (pendingTasks.containsKey(taskId)) {
            com.qoder.cinema.AppLog.w(TAG, "Task already exists: " + taskId);
            return;
        }

        DownloadTask task = new DownloadTask(taskId, url, filePath, headers, startBytes, totalBytes);
        taskRegistry.put(taskId, task);
        pausedTasks.remove(taskId);
        pendingTasks.put(taskId, task);

        // 检查是否可以立即执行
        if (activeDownloads.size() < MAX_CONCURRENT) {
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
            if (activeDownloads.size() < MAX_CONCURRENT) {
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
        if (activeDownloads.size() < MAX_CONCURRENT) {
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
     * 无活跃任务且无待执行任务时停止前台服务
     */
    private void stopServiceIfIdle() {
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
