package com.qoder.cinema.download;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.Map;
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

            // 构建请求
            Request.Builder requestBuilder = new Request.Builder().url(task.url);
            for (Map.Entry<String, String> entry : task.headers.entrySet()) {
                requestBuilder.addHeader(entry.getKey(), entry.getValue());
            }

            // 添加 Range 头（续传）
            long startBytes = downloadedBytes.get();
            if (startBytes > 0 && task.totalBytes < 0) {
                // 未知总大小时尝试续传
                requestBuilder.addHeader("Range", "bytes=" + startBytes + "-");
            } else if (startBytes > 0) {
                requestBuilder.addHeader("Range", "bytes=" + startBytes + "-");
            }

            // 执行请求
            Response response = client.newCall(requestBuilder.build()).execute();

            if (!response.isSuccessful() && response.code() != 206) {
                // 416 Range Not Satisfiable：从头重下
                if (response.code() == 416 && startBytes > 0) {
                    com.qoder.cinema.AppLog.w(TAG, "Range not satisfiable, restarting from 0");
                    response.close();
                    downloadedBytes.set(0);
                    deletePartFile();
                    execute(); // 递归重试
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
            writeToFile(response);

            response.close();

            // 检查是否被取消
            if (canceled.get()) {
                deletePartFile();
                errorCallback.onError(task.taskId, "E_CANCELED", "Download canceled");
                return;
            }

            // 检查是否暂停
            if (paused.get()) {
                // 保留 .part 文件供续传
                NativeDownloadManager.DownloadStatus status = new NativeDownloadManager.DownloadStatus();
                status.taskId = task.taskId;
                status.state = "paused";
                status.downloadedBytes = downloadedBytes.get();
                status.totalBytes = totalBytes;
                return;
            }

            // 原子 rename：.part → 最终路径
            File partFileObj = new File(partFilePath);
            File finalFileObj = new File(finalFilePath);
            if (!partFileObj.renameTo(finalFileObj)) {
                throw new IOException("Failed to rename .part file");
            }

            completedCallback.onCompleted(task.taskId, finalFilePath, downloadedBytes.get());

        } catch (Exception e) {
            com.qoder.cinema.AppLog.e(TAG, "Download failed: " + task.taskId, e);
            if (!canceled.get() && !paused.get()) {
                errorCallback.onError(task.taskId, "E_NETWORK", e.getMessage());
            }
        }
    }

    private void writeToFile(Response response) throws IOException {
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
