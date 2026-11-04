package com.qoder.cinema.download;

import android.content.Context;
import android.util.Log;

import com.qoder.cinema.DownloadPlugin;

import java.io.File;
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
 */
public class NativeDownloadManager {

    private static final String TAG = "NativeDownloadMgr";
    private static final int MAX_CONCURRENT = 2;

    private static NativeDownloadManager instance;
    private final Context context;
    private final ExecutorService executor;
    private final Map<String, RangeDownloader> activeDownloads;
    private final Map<String, DownloadTask> pendingTasks;
    private final List<DownloadStatus> completedStatuses;
    private DownloadPlugin plugin;

    private NativeDownloadManager(Context context) {
        this.context = context.getApplicationContext();
        this.executor = Executors.newFixedThreadPool(MAX_CONCURRENT);
        this.activeDownloads = new ConcurrentHashMap<>();
        this.pendingTasks = new ConcurrentHashMap<>();
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
     */
    public void start(String taskId, String url, String filePath, Map<String, String> headers,
                      long startBytes, long totalBytes) {
        if (activeDownloads.containsKey(taskId) || pendingTasks.containsKey(taskId)) {
            Log.w(TAG, "Task already exists: " + taskId);
            return;
        }

        DownloadTask task = new DownloadTask(taskId, url, filePath, headers, startBytes, totalBytes);
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
        RangeDownloader downloader = activeDownloads.get(taskId);
        if (downloader != null) {
            downloader.pause();
        }
        pendingTasks.remove(taskId);
    }

    /**
     * 恢复下载任务
     */
    public void resume(String taskId) {
        DownloadTask task = pendingTasks.get(taskId);
        if (task != null && !activeDownloads.containsKey(taskId)) {
            if (activeDownloads.size() < MAX_CONCURRENT) {
                executeTask(task);
            }
        } else {
            // 任务不在队列中，重新创建
            RangeDownloader downloader = activeDownloads.get(taskId);
            if (downloader != null) {
                downloader.resume();
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

        // 检查是否还有活跃任务
        if (activeDownloads.isEmpty() && pendingTasks.isEmpty()) {
            DownloadService.stop(context);
        }
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
                status.state = "queued";
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

        // 检测 HLS URL
        if (isHlsUrl(task.url)) {
            executeHlsTask(task);
            return;
        }

        RangeDownloader downloader = new RangeDownloader(
                context, task, this::onProgress, this::onCompleted, this::onError
        );
        activeDownloads.put(task.taskId, downloader);

        executor.submit(() -> {
            try {
                downloader.execute();
            } catch (Exception e) {
                Log.e(TAG, "Task execution failed: " + task.taskId, e);
                onError(task.taskId, "E_UNKNOWN", e.getMessage());
            } finally {
                activeDownloads.remove(task.taskId);
                // 尝试执行下一个等待中的任务
                scheduleNextTask();
            }
        });
    }

    /**
     * 检测是否为 HLS URL
     */
    private boolean isHlsUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.contains(".m3u8") || lower.contains(".m3u");
    }

    /**
     * 执行 HLS 下载任务
     */
    private void executeHlsTask(DownloadTask task) {
        HlsDownloader hlsDownloader = new HlsDownloader(context);

        executor.submit(() -> {
            try {
                hlsDownloader.download(
                        task.taskId,
                        task.url,
                        buildFilePath(task.filePath),
                        task.headers,
                        (taskId, downloadedBytes, totalBytes, speedBps) ->
                                onProgress(taskId, downloadedBytes, totalBytes, speedBps),
                        (taskId, filePath, totalBytes) ->
                                onCompleted(taskId, filePath, totalBytes),
                        (taskId, errorCode, errorMessage) ->
                                onError(taskId, errorCode, errorMessage)
                );
            } catch (Exception e) {
                Log.e(TAG, "HLS task execution failed: " + task.taskId, e);
                onError(task.taskId, "E_UNKNOWN", e.getMessage());
            } finally {
                scheduleNextTask();
            }
        });
    }

    /**
     * 构建文件路径
     */
    private String buildFilePath(String relativePath) {
        File filesDir = context.getFilesDir();
        return new File(filesDir, relativePath).getAbsolutePath();
    }

    private void scheduleNextTask() {
        if (activeDownloads.size() < MAX_CONCURRENT && !pendingTasks.isEmpty()) {
            // 取第一个等待中的任务
            DownloadTask next = pendingTasks.values().iterator().next();
            executeTask(next);
        } else if (activeDownloads.isEmpty() && pendingTasks.isEmpty()) {
            // 所有任务完成，停止前台服务
            DownloadService.stop(context);
        }
    }

    private void onProgress(String taskId, long downloadedBytes, long totalBytes, long speedBps) {
        if (plugin != null) {
            plugin.emitProgress(taskId, downloadedBytes, totalBytes, speedBps);
        }
    }

    private void onCompleted(String taskId, String filePath, long totalBytes) {
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
