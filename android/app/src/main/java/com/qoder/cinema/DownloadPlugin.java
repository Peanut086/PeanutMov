package com.qoder.cinema;

import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.qoder.cinema.download.NativeDownloadManager;
import com.qoder.cinema.download.DownloadService;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * 下载插件（Phase 1：Native Android 下载器）
 *
 * 职责：
 * - 暴露 start/pause/resume/cancel/getStatus 方法给 JS
 * - 通过 NativeDownloadManager 管理多任务并发下载
 * - 下载进度通过 notifyListeners 推送给 JS
 *
 * 与 JS 侧集成：
 * - downloadEngine 检测 isAvailable()，优先走 Native
 * - 不可用时回退到 JS 下载（IdbBlobSink / NativeFsSink）
 */
@CapacitorPlugin(name = "Download")
public class DownloadPlugin extends Plugin {

    private static final String TAG = "DownloadPlugin";
    private NativeDownloadManager downloadManager;

    @Override
    public void load() {
        super.load();
        downloadManager = NativeDownloadManager.getInstance(getContext());
        downloadManager.setPlugin(this);
        Log.d(TAG, "DownloadPlugin loaded");
    }

    @Override
    public void handleOnDestroy() {
        super.handleOnDestroy();
        if (downloadManager != null) {
            downloadManager.setPlugin(null);
        }
    }

    /**
     * 检查插件是否可用（始终返回 true，因为 Native 下载器是 Android 专属）
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("platform", "android");
        call.resolve(result);
    }

    /**
     * 启动下载任务
     *
     * @param call.data.taskId      任务 ID
     * @param call.data.url         下载地址
     * @param call.data.filePath    保存路径（相对应用私有目录）
     * @param call.data.headers     请求头（可选）
     * @param call.data.startBytes  续传起点（可选，默认 0）
     * @param call.data.totalBytes  总大小（可选，用于进度计算）
     */
    @PluginMethod
    public void start(PluginCall call) {
        String taskId = call.getString("taskId");
        String url = call.getString("url");
        String filePath = call.getString("filePath");

        if (taskId == null || url == null || filePath == null) {
            call.reject("Missing required parameters: taskId, url, filePath");
            return;
        }

        Map<String, String> headers = new HashMap<>();
        JSObject headersObj = call.getObject("headers");
        if (headersObj != null) {
            java.util.Iterator<String> keys = headersObj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headersObj.getString(key);
                if (value != null) {
                    headers.put(key, value);
                }
            }
        }

        long startBytes = call.getLong("startBytes", 0L);
        long totalBytes = call.getLong("totalBytes", -1L);

        try {
            downloadManager.start(taskId, url, filePath, headers, startBytes, totalBytes);
            call.resolve();
        } catch (UnsupportedOperationException e) {
            // D-01 / AND-14：原生 HLS 分支已移除，m3u8 一律回落 JS 下载器。
            // 这里不产生任何输出文件，避免"看似成功、实际坏文件"。
            Log.w(TAG, "Reject HLS download in native layer: " + taskId);
            call.reject("E_UNSUPPORTED_FORMAT: " + e.getMessage());
        } catch (Exception e) {
            Log.e(TAG, "Failed to start download: " + taskId, e);
            call.reject("Failed to start download: " + e.getMessage());
        }
    }

    /**
     * 暂停下载任务
     */
    @PluginMethod
    public void pause(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("Missing taskId");
            return;
        }
        downloadManager.pause(taskId);
        call.resolve();
    }

    /**
     * 恢复下载任务
     */
    @PluginMethod
    public void resume(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("Missing taskId");
            return;
        }
        downloadManager.resume(taskId);
        call.resolve();
    }

    /**
     * 取消下载任务
     */
    @PluginMethod
    public void cancel(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("Missing taskId");
            return;
        }
        downloadManager.cancel(taskId);
        call.resolve();
    }

    /**
     * 获取所有任务状态
     */
    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        JSArray tasks = new JSArray();

        for (NativeDownloadManager.DownloadStatus status : downloadManager.getAllStatus()) {
            JSObject taskObj = new JSObject();
            taskObj.put("taskId", status.taskId);
            taskObj.put("state", status.state);
            taskObj.put("downloadedBytes", status.downloadedBytes);
            taskObj.put("totalBytes", status.totalBytes);
            taskObj.put("speedBps", status.speedBps);
            taskObj.put("errorCode", status.errorCode != null ? status.errorCode : "");
            taskObj.put("errorMessage", status.errorMessage != null ? status.errorMessage : "");
            tasks.put(taskObj);
        }

        result.put("tasks", tasks);
        call.resolve(result);
    }

    /**
     * 下发并发闸门（EXT-04 / FR-62）。
     *
     * JS 侧 `downloadService.setConcurrency` / 启动恢复时调用，
     * 让设置页的并发档位对原生直链下载同样成立——此前原生恒为 2。
     */
    @PluginMethod
    public void setConcurrency(PluginCall call) {
        Integer value = call.getInt("maxConcurrent");
        if (value == null) {
            call.reject("maxConcurrent required");
            return;
        }
        downloadManager.setMaxConcurrent(value);
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("maxConcurrent", value);
        call.resolve(result);
    }

    /**
     * 启动前台服务（用于保持下载进程存活）
     */
    @PluginMethod
    public void startForegroundService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), DownloadService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to start foreground service", e);
            call.reject("Failed to start service: " + e.getMessage());
        }
    }

    /**
     * 停止前台服务
     */
    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), DownloadService.class);
            getContext().stopService(intent);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop foreground service", e);
            call.reject("Failed to stop service: " + e.getMessage());
        }
    }

    // ========== 供 NativeDownloadManager 回调 ==========

    /**
     * 发送进度事件给 JS
     */
    public void emitProgress(String taskId, long downloadedBytes, long totalBytes, long speedBps) {
        JSObject data = new JSObject();
        data.put("taskId", taskId);
        data.put("downloadedBytes", downloadedBytes);
        data.put("totalBytes", totalBytes);
        data.put("speedBps", speedBps);
        notifyListeners("progress", data);
    }

    /**
     * 发送状态变更事件给 JS
     */
    public void emitStateChanged(String taskId, String state, String errorCode, String errorMessage) {
        JSObject data = new JSObject();
        data.put("taskId", taskId);
        data.put("state", state);
        data.put("errorCode", errorCode != null ? errorCode : "");
        data.put("errorMessage", errorMessage != null ? errorMessage : "");
        notifyListeners("stateChanged", data);
    }

    /**
     * 发送完成事件给 JS
     */
    public void emitCompleted(String taskId, String filePath, long totalBytes) {
        JSObject data = new JSObject();
        data.put("taskId", taskId);
        data.put("filePath", filePath);
        data.put("totalBytes", totalBytes);
        notifyListeners("completed", data);
    }

    /**
     * 发送错误事件给 JS
     */
    public void emitError(String taskId, String errorCode, String errorMessage) {
        JSObject data = new JSObject();
        data.put("taskId", taskId);
        data.put("errorCode", errorCode);
        data.put("errorMessage", errorMessage);
        notifyListeners("error", data);
    }
}
