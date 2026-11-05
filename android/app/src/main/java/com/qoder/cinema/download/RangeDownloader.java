package com.qoder.cinema.download;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * 单文件下载器（Range 续传）
 *
 * 职责：
 * - 用 OkHttp 下载单个文件
 * - 支持 Range 请求（断点续传）
 * - 写入 .part 临时文件，完成后原子 rename
 * - 通过回调上报进度/完成/错误
 *
 * 线程安全：
 * - pause()/cancel() 可在任意线程调用
 * - execute() 在工作线程执行
 */
public class RangeDownloader {

    private static final String TAG = "RangeDownloader";
    private static final int BUFFER_SIZE = 64 * 1024; // 64KB 缓冲区
    private static final int PROGRESS_INTERVAL_MS = 500; // 进度上报间隔
    // P1-5: 多 Range 并发下载配置
    private static final int MULTI_RANGE_CONNECTIONS = 4;
    private static final long MIN_SIZE_FOR_MULTI_RANGE = 10 * 1024 * 1024; // 10MB 以上才用多 Range

    private final Context context;
    private final NativeDownloadManager.DownloadTask task;
    private final ProgressCallback progressCallback;
    private final CompletedCallback completedCallback;
    private final ErrorCallback errorCallback;

    private final OkHttpClient client;
    private final AtomicBoolean paused = new AtomicBoolean(false);
    private final AtomicBoolean canceled = new AtomicBoolean(false);
    private final AtomicLong downloadedBytes = new AtomicLong(0);

    private String partFilePath;
    private String finalFilePath;
    private long totalBytes = -1;
    private long lastProgressTime = 0;
    private long lastReportedBytes = 0;
    private long lastSpeedCalcTime = 0;

    public interface ProgressCallback {
        void onProgress(String taskId, long downloadedBytes, long totalBytes, long speedBps);
    }

    public interface CompletedCallback {
        void onCompleted(String taskId, String filePath, long totalBytes);
    }

    public interface ErrorCallback {
        void onError(String taskId, String errorCode, String errorMessage);
    }

    public RangeDownloader(Context context, NativeDownloadManager.DownloadTask task,
                           ProgressCallback progressCallback, CompletedCallback completedCallback,
                           ErrorCallback errorCallback) {
        this.context = context;
        this.task = task;
        this.progressCallback = progressCallback;
        this.completedCallback = completedCallback;
        this.errorCallback = errorCallback;

        this.client = new OkHttpClient.Builder()
                .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                .build();

        this.downloadedBytes.set(task.startBytes);
    }

    /**
     * 执行下载（在工作线程调用）
     */
    public void execute() {
        if (canceled.get()) {
            errorCallback.onError(task.taskId, "E_CANCELED", "Download canceled before start");
            return;
        }

        try {
            // 构建文件路径
            finalFilePath = buildFilePath(task.filePath);
            partFilePath = finalFilePath + ".part";

            // 确保目录存在
            File partFile = new File(partFilePath);
            File parentDir = partFile.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }

            // 检查 .part 文件实际大小（续传校正）
            long actualStartBytes = getPartFileSize();
            if (actualStartBytes != task.startBytes) {
                com.qoder.cinema.AppLog.w(TAG, "Start bytes corrected: db=" + task.startBytes + ", actual=" + actualStartBytes);
                downloadedBytes.set(actualStartBytes);
            }

            // P1-5: 检查是否支持多 Range 下载
            long totalSize = task.totalBytes;
            if (totalSize <= 0) {
                // 未知总大小，先 HEAD 请求获取
                totalSize = fetchContentLength();
            }

            if (totalSize >= MIN_SIZE_FOR_MULTI_RANGE && checkMultiRangeSupport()) {
                com.qoder.cinema.AppLog.i(TAG, "Using multi-range download: " + totalSize + " bytes, " + MULTI_RANGE_CONNECTIONS + " connections");
                executeMultiRange(totalSize);
                return;
            }

            // 单连接下载（原有逻辑）
            executeSingleConnection();

        } catch (Exception e) {
            com.qoder.cinema.AppLog.e(TAG, "Download failed: " + task.taskId, e);
            if (!canceled.get() && !paused.get()) {
                errorCallback.onError(task.taskId, "E_NETWORK", e.getMessage());
            }
        }
    }

    /**
     * 单连接下载（支持断点续传）
     */
    private void executeSingleConnection() throws IOException {
        long startBytes = downloadedBytes.get();

        // 构建请求
        Request.Builder requestBuilder = new Request.Builder()
                .url(task.url)
                .header("User-Agent", "PeanutMov/1.0");

        // 添加自定义 headers
        if (task.headers != null) {
            for (Map.Entry<String, String> entry : task.headers.entrySet()) {
                requestBuilder.header(entry.getKey(), entry.getValue());
            }
        }

        // Range 续传
        if (startBytes > 0) {
            requestBuilder.header("Range", "bytes=" + startBytes + "-");
        }

        Response response = client.newCall(requestBuilder.build()).execute();

        try {
            if (!response.isSuccessful() && response.code() != 206) {
                // 416 Range Not Satisfiable：从头重下
                if (response.code() == 416 && startBytes > 0) {
                    com.qoder.cinema.AppLog.w(TAG, "Range not satisfiable, restarting from 0");
                    response.close();
                    downloadedBytes.set(0);
                    deletePartFile();
                    executeSingleConnection(); // 递归重试
                    return;
                }
                throw new IOException("HTTP " + response.code() + ": " + response.message());
            }

            // 检查是否支持续传
            boolean resumable = response.code() == 206;
            if (startBytes > 0 && !resumable) {
                com.qoder.cinema.AppLog.w(TAG, "Server does not support Range, restarting from 0");
                downloadedBytes.set(0);
                deletePartFile();
                startBytes = 0;
            }

            // 获取总大小
            String contentLength = response.header("content-length");
            if (contentLength != null) {
                long contentLen = Long.parseLong(contentLength);
                if (resumable) {
                    totalBytes = startBytes + contentLen;
                } else {
                    totalBytes = contentLen;
                }
            } else if (task.totalBytes > 0) {
                totalBytes = task.totalBytes;
            }

            // 写入文件
            writeToFileResponse(response);

            // 检查是否被取消
            if (canceled.get()) {
                deletePartFile();
                errorCallback.onError(task.taskId, "E_CANCELED", "Download canceled");
                return;
            }

            // 检查是否暂停
            if (paused.get()) {
                // 保留 .part 文件供续传
                return;
            }

            // 原子 rename：.part → 最终路径
            File partFileObj = new File(partFilePath);
            File finalFileObj = new File(finalFilePath);
            if (!partFileObj.renameTo(finalFileObj)) {
                throw new IOException("Failed to rename .part file");
            }

            completedCallback.onCompleted(task.taskId, finalFilePath, downloadedBytes.get());
        } finally {
            response.close();
        }
    }

    /**
     * HEAD 请求获取 Content-Length
     */
    private long fetchContentLength() {
        try {
            Request.Builder requestBuilder = new Request.Builder()
                    .url(task.url)
                    .head()
                    .header("User-Agent", "PeanutMov/1.0");

            if (task.headers != null) {
                for (Map.Entry<String, String> entry : task.headers.entrySet()) {
                    requestBuilder.header(entry.getKey(), entry.getValue());
                }
            }

            Response response = client.newCall(requestBuilder.build()).execute();
            try {
                if (!response.isSuccessful()) return -1;
                String contentLength = response.header("content-length");
                return contentLength != null ? Long.parseLong(contentLength) : -1;
            } finally {
                response.close();
            }
        } catch (Exception e) {
            com.qoder.cinema.AppLog.w(TAG, "fetchContentLength failed: " + e.getMessage());
            return -1;
        }
    }

    /**
     * 检查服务器是否支持多 Range 下载
     */
    private boolean checkMultiRangeSupport() {
        try {
            Request.Builder requestBuilder = new Request.Builder()
                    .url(task.url)
                    .head()
                    .header("User-Agent", "PeanutMov/1.0");

            if (task.headers != null) {
                for (Map.Entry<String, String> entry : task.headers.entrySet()) {
                    requestBuilder.header(entry.getKey(), entry.getValue());
                }
            }

            Response response = client.newCall(requestBuilder.build()).execute();
            try {
                if (!response.isSuccessful()) return false;
                String acceptRanges = response.header("accept-ranges");
                return acceptRanges != null && acceptRanges.contains("bytes");
            } finally {
                response.close();
            }
        } catch (Exception e) {
            com.qoder.cinema.AppLog.w(TAG, "checkMultiRangeSupport failed: " + e.getMessage());
            return false;
        }
    }

    /**
     * 多 Range 并发下载
     */
    private void executeMultiRange(long totalSize) throws IOException {
        long startBytes = downloadedBytes.get();
        long remainingBytes = totalSize - startBytes;

        if (remainingBytes <= 0) {
            // 已完成
            File partFileObj = new File(partFilePath);
            File finalFileObj = new File(finalFilePath);
            if (!partFileObj.renameTo(finalFileObj)) {
                throw new IOException("Failed to rename .part file");
            }
            completedCallback.onCompleted(task.taskId, finalFilePath, totalSize);
            return;
        }

        // 计算每个 Range 的大小
        long rangeSize = remainingBytes / MULTI_RANGE_CONNECTIONS;
        ExecutorService executor = Executors.newFixedThreadPool(MULTI_RANGE_CONNECTIONS);
        Future<?>[] futures = new Future<?>[MULTI_RANGE_CONNECTIONS];

        // 预分配文件大小
        RandomAccessFile raf = new RandomAccessFile(partFilePath, "rw");
        raf.setLength(totalSize);
        raf.close();

        final long finalTotalBytes = totalSize;

        for (int i = 0; i < MULTI_RANGE_CONNECTIONS; i++) {
            final int rangeIndex = i;
            final long rangeStart = startBytes + (i * rangeSize);
            final long rangeEnd = (i == MULTI_RANGE_CONNECTIONS - 1)
                    ? totalSize - 1
                    : rangeStart + rangeSize - 1;

            futures[i] = executor.submit(() -> {
                try {
                    downloadRange(rangeIndex, rangeStart, rangeEnd, finalTotalBytes);
                } catch (Exception e) {
                    com.qoder.cinema.AppLog.e(TAG, "Range " + rangeIndex + " failed: " + e.getMessage());
                    // 标记错误，让主线程处理
                    if (!canceled.get() && !paused.get()) {
                        errorCallback.onError(task.taskId, "E_NETWORK", "Range " + rangeIndex + " failed: " + e.getMessage());
                    }
                }
            });
        }

        // 等待所有 Range 完成
        executor.shutdown();
        try {
            executor.awaitTermination(1, TimeUnit.HOURS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Multi-range download interrupted");
        }

        // 检查是否被取消或暂停
        if (canceled.get()) {
            deletePartFile();
            errorCallback.onError(task.taskId, "E_CANCELED", "Download canceled");
            return;
        }

        if (paused.get()) {
            return;
        }

        // 原子 rename：.part → 最终路径
        File partFileObj = new File(partFilePath);
        File finalFileObj = new File(finalFilePath);
        if (!partFileObj.renameTo(finalFileObj)) {
            throw new IOException("Failed to rename .part file");
        }

        completedCallback.onCompleted(task.taskId, finalFilePath, totalSize);
    }

    /**
     * 下载单个 Range
     */
    private void downloadRange(int rangeIndex, long rangeStart, long rangeEnd, long totalFileSize) throws IOException {
        Request.Builder requestBuilder = new Request.Builder()
                .url(task.url)
                .header("Range", "bytes=" + rangeStart + "-" + rangeEnd)
                .header("User-Agent", "PeanutMov/1.0");

        if (task.headers != null) {
            for (Map.Entry<String, String> entry : task.headers.entrySet()) {
                requestBuilder.header(entry.getKey(), entry.getValue());
            }
        }

        Response response = client.newCall(requestBuilder.build()).execute();
        try {
            if (!response.isSuccessful() && response.code() != 206) {
                throw new IOException("Range " + rangeIndex + " HTTP " + response.code());
            }

            InputStream inputStream = response.body().byteStream();
            RandomAccessFile outputFile = new RandomAccessFile(partFilePath, "rw");
            outputFile.seek(rangeStart);

            byte[] buffer = new byte[BUFFER_SIZE];
            int bytesRead;
            long localDownloaded = 0;

            try {
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    if (canceled.get() || paused.get()) {
                        break;
                    }

                    outputFile.write(buffer, 0, bytesRead);
                    localDownloaded += bytesRead;
                    downloadedBytes.addAndGet(bytesRead);

                    // 上报进度（节流，每个 range 独立计算）
                    long now = System.currentTimeMillis();
                    if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
                        long speedBps = 0;
                        long elapsed = now - lastSpeedCalcTime;
                        if (elapsed > 0) {
                            speedBps = ((downloadedBytes.get() - lastReportedBytes) * 1000) / elapsed;
                            lastReportedBytes = downloadedBytes.get();
                            lastSpeedCalcTime = now;
                        }
                        progressCallback.onProgress(task.taskId, downloadedBytes.get(), totalFileSize, speedBps);
                        lastProgressTime = now;
                    }
                }
            } finally {
                outputFile.close();
                inputStream.close();
            }

            com.qoder.cinema.AppLog.d(TAG, "Range " + rangeIndex + " completed: " + localDownloaded + " bytes");
        } finally {
            response.close();
        }
    }

    private void writeToFileResponse(Response response) throws IOException {
        InputStream inputStream = response.body().byteStream();
        RandomAccessFile outputFile = new RandomAccessFile(partFilePath, "rw");

        // 续传：定位到已有大小
        long startBytes = downloadedBytes.get();
        if (startBytes > 0) {
            outputFile.seek(startBytes);
        } else {
            outputFile.setLength(0); // 清空文件
        }

        byte[] buffer = new byte[BUFFER_SIZE];
        int bytesRead;
        long lastSpeedCalcTime = System.currentTimeMillis();
        long bytesSinceLastCalc = 0;

        try {
            while ((bytesRead = inputStream.read(buffer)) != -1) {
                if (canceled.get() || paused.get()) {
                    break;
                }

                outputFile.write(buffer, 0, bytesRead);
                downloadedBytes.addAndGet(bytesRead);
                bytesSinceLastCalc += bytesRead;

                // 上报进度（节流）
                long now = System.currentTimeMillis();
                if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
                    long speedBps = 0;
                    long elapsed = now - lastSpeedCalcTime;
                    if (elapsed > 0) {
                        speedBps = (bytesSinceLastCalc * 1000) / elapsed;
                        bytesSinceLastCalc = 0;
                        lastSpeedCalcTime = now;
                    }
                    progressCallback.onProgress(task.taskId, downloadedBytes.get(), totalBytes, speedBps);
                    lastProgressTime = now;
                }
            }
        } finally {
            outputFile.close();
            inputStream.close();
        }
    }

    /**
     * 暂停下载
     */
    public void pause() {
        paused.set(true);
    }

    /**
     * 恢复下载（重新执行）
     */
    public void resume() {
        paused.set(false);
        // 注意：恢复下载需要重新调用 execute()，由 NativeDownloadManager 管理
    }

    /**
     * 取消下载
     */
    public void cancel() {
        canceled.set(true);
        deletePartFile();
    }

    /**
     * 获取当前状态
     */
    public NativeDownloadManager.DownloadStatus getStatus() {
        NativeDownloadManager.DownloadStatus status = new NativeDownloadManager.DownloadStatus();
        status.taskId = task.taskId;
        status.state = paused.get() ? "paused" : canceled.get() ? "canceled" : "downloading";
        status.downloadedBytes = downloadedBytes.get();
        status.totalBytes = totalBytes;
        status.speedBps = 0; // 实时速度需要额外计算
        return status;
    }

    // ========== 辅助方法 ==========

    private String buildFilePath(String relativePath) {
        // 使用应用私有目录
        File filesDir = context.getFilesDir();
        return new File(filesDir, relativePath).getAbsolutePath();
    }

    private long getPartFileSize() {
        File partFile = new File(partFilePath != null ? partFilePath : buildFilePath(task.filePath) + ".part");
        return partFile.exists() ? partFile.length() : 0;
    }

    private void deletePartFile() {
        if (partFilePath != null) {
            File partFile = new File(partFilePath);
            if (partFile.exists()) {
                partFile.delete();
            }
        }
    }
}
