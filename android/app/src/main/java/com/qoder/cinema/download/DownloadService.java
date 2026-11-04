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
 */
public class DownloadService extends Service {

    private static final String TAG = "DownloadService";
    private static final String CHANNEL_ID = "download_channel";
    private static final String CHANNEL_NAME = "下载";
    private static final int NOTIFICATION_ID = 1001;

    private NotificationManager notificationManager;
    private boolean isForeground = false;

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        Log.d(TAG, "DownloadService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "DownloadService started");
        startForegroundNotification();
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
        Intent intent = new Intent(context, DownloadService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /**
     * 停止服务
     */
    public static void stop(Context context) {
        Intent intent = new Intent(context, DownloadService.class);
        context.stopService(intent);
    }
}
