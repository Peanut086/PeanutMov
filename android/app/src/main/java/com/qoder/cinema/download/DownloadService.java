package com.qoder.cinema.download;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.qoder.cinema.MainActivity;
import com.qoder.cinema.R;

import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 下载前台服务（Phase 1）
 *
 * 职责：
 * - 保持下载进程在后台不被系统杀死
 * - 显示下载进度通知
 * - Android 14+ 需要声明 foregroundServiceType="dataSync"
 *
 * 生命周期：
 * - 有下载任务时启动，所有任务完成/暂停后自动停止
 * - NativeDownloadManager 通过 updateNotification() 更新进度
 *
 * EXT-04 / FR-60：转封装（`MediaToolPlugin` → `MediaRemuxer`）期间也要求服务存活，
 * 否则用户切后台后系统可能把进程回收，`.mp4.part` 变成残留半截文件。
 * 因此引入"后处理计数"：`beginPostprocess()` / `endPostprocess()` 成对调用，
 * 计数 > 0 时 {@link NativeDownloadManager#stopServiceIfIdle()} 不会停服务，
 * 通知文案显示"转封装中 x%"，与下载进度区分开。
 */
public class DownloadService extends Service {

    private static final String TAG = "DownloadService";
    private static final String CHANNEL_ID = "download_channel";
    private static final String CHANNEL_NAME = "下载";
    private static final int NOTIFICATION_ID = 1001;

    /** 转封装等后处理任务计数（进程内，配对调用；<0 视为失衡并复位） */
    private static final AtomicInteger postprocessCount = new AtomicInteger(0);
    /** 停服请求落在「已 startForegroundService、尚未 startForeground」窗口时的延后标记 */
    private static volatile boolean stopWhenReady = false;
    /** 当前服务实例（未启动时为 null），供静态方法刷新通知 */
    private static volatile WeakReference<DownloadService> instanceRef = new WeakReference<>(null);

    private NotificationManager notificationManager;
    private boolean isForeground = false;

    @Override
    public void onCreate() {
        super.onCreate();
        instanceRef = new WeakReference<>(this);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        Log.d(TAG, "DownloadService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "DownloadService started");
        startForegroundNotification();
        if (stopWhenReady) {
            // 收回请求曾落在 startForeground 之前（那会儿 stopService 会直接被 AMS 判超时强杀），
            // 现在前台已坐实，补做当初被延后的那次收回。
            stopWhenReady = false;
            Log.d(TAG, "Applying deferred keep-alive reclaim");
            try {
                NativeDownloadManager.getInstance(this).stopServiceIfIdle();
            } catch (Exception e) {
                Log.w(TAG, "Deferred reclaim failed", e);
            }
        }
        // START_STICKY：系统杀死后自动重启（保持下载不中断）
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "DownloadService destroyed");
        instanceRef = new WeakReference<>(null);
        stopWhenReady = false;
        if (isForeground) {
            stopForeground(true);
            isForeground = false;
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW // 不发出声音
            );
            channel.setDescription("视频下载进度");
            channel.setShowBadge(false);
            notificationManager.createNotificationChannel(channel);
        }
    }

    private void startForegroundNotification() {
        if (isForeground) return;

        Notification notification = buildNotification("下载中...", 0, 0, false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ 需要声明 foregroundServiceType
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        isForeground = true;
    }

    /**
     * 更新通知进度
     */
    public void updateNotification(int downloadedCount, int totalCount, long totalBytes, long speedBps) {
        if (!isForeground) return;

        String title = String.format("下载中 %d/%d", downloadedCount, totalCount);
        String content = formatSpeed(speedBps);
        int progress = totalCount > 0 ? (downloadedCount * 100 / totalCount) : 0;

        Notification notification = buildNotification(content, progress, totalBytes, true);
        notificationManager.notify(NOTIFICATION_ID, notification);
    }

    /**
     * 刷新"转封装中"通知。
     *
     * @param percent 0–100；传 -1 表示进度未知（视频轨没有时长元数据，如部分 TS）
     */
    private void notifyPostprocess(int percent) {
        if (!isForeground || notificationManager == null) return;
        String content = percent >= 0 ? ("转封装中 " + percent + "%") : "转封装中...";
        Notification notification = buildNotification(content, percent >= 0 ? Math.max(percent, 1) : 0, 0, percent < 0);
        notificationManager.notify(NOTIFICATION_ID, notification);
    }

    /**
     * 停止服务（所有任务完成或暂停时调用）
     */
    public void stopService() {
        Log.d(TAG, "Stopping DownloadService");
        if (isForeground) {
            stopForeground(true);
            isForeground = false;
        }
        super.stopSelf();
    }

    private Notification buildNotification(String content, int progress, long totalBytes, boolean indeterminate) {
        // 点击通知打开主界面
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, intent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("视频下载")
                .setContentText(content)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        if (indeterminate && progress == 0) {
            builder.setProgress(0, 0, true); // 不确定进度条
        } else if (progress > 0) {
            builder.setProgress(100, progress, false);
        }

        return builder.build();
    }

    private String formatSpeed(long bytesPerSecond) {
        if (bytesPerSecond <= 0) return "准备中...";
        if (bytesPerSecond < 1024) return bytesPerSecond + " B/s";
        if (bytesPerSecond < 1024 * 1024) return String.format("%.1f KB/s", bytesPerSecond / 1024.0);
        return String.format("%.1f MB/s", bytesPerSecond / (1024.0 * 1024));
    }

    // ========== 静态方法供外部调用 ==========

    /**
     * 启动服务
     */
    public static void start(Context context) {
        stopWhenReady = false; // 新的保活诉求作废尚未落地的收回
        Intent intent = new Intent(context, DownloadService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /**
     * 停止服务
     *
     * FGS-GUARD：`startForegroundService()` 之后、`startForeground()` 之前把服务停掉，AMS 会当场
     * 判定 `ForegroundServiceDidNotStartInTimeException` 并杀掉整个进程（真机实测：撤回落在起活后
     * 18ms）。所以前台还没坐实时只能延后，由 onStartCommand 落地后补做。
     */
    public static void stop(Context context) {
        if (!isForegroundReady()) {
            stopWhenReady = true;
            Log.d(TAG, "stop deferred: startForeground not landed yet");
            return;
        }
        stopWhenReady = false;
        Intent intent = new Intent(context, DownloadService.class);
        context.stopService(intent);
    }

    /** 前台资格是否已真正生效（服务实例存在且 startForeground 已执行） */
    public static boolean isForegroundReady() {
        DownloadService instance = instanceRef.get();
        return instance != null && instance.isForeground;
    }

    // ========== EXT-04 / FR-60：转封装等后处理的前台保活 ==========

    /** 是否有后处理（转封装）在进行中 */
    public static boolean isPostprocessing() {
        return postprocessCount.get() > 0;
    }

    /**
     * 标记一个后处理开始：计数 +1 并确保前台服务运行。
     * 必须与 {@link #endPostprocess(Context)} 成对调用（异常路径放在 finally 里）。
     */
    public static void beginPostprocess(Context context) {
        postprocessCount.incrementAndGet();
        try {
            start(context);
        } catch (Exception e) {
            Log.w(TAG, "start foreground service for postprocess failed", e);
        }
    }

    /**
     * 标记一个后处理结束：计数 -1；归零后让管理器判断是否可以停服务
     * （仍有下载任务时不会停，见 {@link NativeDownloadManager#stopServiceIfIdle()}）。
     */
    public static void endPostprocess(Context context) {
        int remaining = postprocessCount.decrementAndGet();
        if (remaining > 0) return;
        if (remaining < 0) {
            // 配对失衡（重复 end 或多线程竞争）时复位，避免服务永远不停
            postprocessCount.set(0);
        }
        try {
            NativeDownloadManager.getInstance(context).stopServiceIfIdle();
        } catch (Exception e) {
            Log.w(TAG, "stopServiceIfIdle after postprocess failed", e);
        }
    }

    /** 外部（MediaToolPlugin）刷新"转封装中 x%"；服务未运行时静默忽略 */
    public static void updatePostprocessNotification(int percent) {
        DownloadService service = instanceRef.get();
        if (service != null) {
            service.notifyPostprocess(percent);
        }
    }
}
