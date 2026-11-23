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
import android.os.SystemClock;
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
 * - 进度由 JS 队列汇总后经 `DownloadPlugin.updateProgress` 下发（N-02）：原生侧只认直链任务，
 *   HLS 任务的字节都在 JS 下载器里，只有 JS 有全量视图
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
    /**
     * N-02：完成提示单独一条渠道。「下载」渠道是 LOW（后台保活进度要静音），
     * 而 Android 8+ 的声音由渠道决定、通知侧无法覆盖——分开才能既安静跟踪进度、又响一声告知完成。
     */
    private static final String DONE_CHANNEL_ID = "download_done";
    private static final String DONE_CHANNEL_NAME = "下载完成";
    private static final int NOTIFICATION_ID = 1001;
    /** N-02：下载类通知收进同一组， shade 里可折叠 */
    private static final String GROUP_DOWNLOADS = "peanutmov.downloads";
    /** 进度通知的最小刷新间隔：JS 侧进度回调很密，这里兜住 notify 次数 */
    private static final long NOTIFY_MIN_INTERVAL_MS = 1000L;
    private static long lastNotifiedAt = 0L;
    private static int lastNotifiedPercent = -1;

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
        ensureChannel(this);
        Log.d(TAG, "DownloadService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // P0-2：START_STICKY 重建（`with null`）。AMS 这次没有下发前台资格
            // （`mAllowStartForeground false`），此处调 startForeground() 必抛
            // ForegroundServiceStartNotAllowedException，把整个进程带走
            // （真机 6 次：OPPO PJH110 / API 35，11-13 22:59 → 11-14 11:19）。
            // 而且这次重建只拉起 Service，WebView/JS 没跑，原生队列必然是空的——
            // 没有在飞下载值得保活，直接收回；用户回到 App 时 bootstrap 会重新 start()。
            Log.w(TAG, "START_STICKY rebroadcast without intent: release without FGS");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        Log.d(TAG, "DownloadService started");
        if (!startForegroundNotification()) {
            // 前台资格被拒（后台起活 / ROM 限制）：留着这个"已启动但非前台"的服务，
            // AMS 会在 10 秒窗口后判 ForegroundServiceDidNotStartInTimeException 强杀进程，
            // 比收回更糟。
            Log.w(TAG, "Foreground not granted; stopping service instead of risking FGS timeout");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
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
        // START_STICKY：系统杀死后自动重启（保持下载不中断）；null intent 分支已单独处理
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

    /**
     * 建立下载相关的两条通知渠道（minSdk 29 ≥ O，无版本分支）。
     *
     * 幂等，且必须在插件加载时就调一次：JS 侧的完成通知（Capacitor LocalNotifications）
     * 显式带 `channelId`，渠道不存在时那条通知会被系统静默丢弃——前台服务只在后台跑下载时才存在，
     * 不能指望它顺带把渠道建出来。
     */
    public static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel progress = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW // 不发出声音
        );
        progress.setDescription("视频下载进度");
        progress.setShowBadge(false);
        manager.createNotificationChannel(progress);

        NotificationChannel done = new NotificationChannel(
                DONE_CHANNEL_ID,
                DONE_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT // 完成要响一声，但不横幅打扰
        );
        done.setDescription("下载完成提示");
        manager.createNotificationChannel(done);
    }

    /**
     * 取得前台资格。
     *
     * @return true 表示已坐实前台（或未升级也无需升级）；false 表示系统拒绝，调用方必须收回服务
     */
    private boolean startForegroundNotification() {
        if (isForeground) return true;

        Notification notification = buildNotification("视频下载", "准备下载...", null, 0, true);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ 需要声明 foregroundServiceType；dataSync 还要求"应用在前台/白名单"，
                // 后台起活直接被拒（ForegroundServiceStartNotAllowedException）
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            // 该异常在 AMS 侧抛出，若不接住会以 "Unable to start service ... with null" 崩掉主进程
            Log.w(TAG, "startForeground rejected", e);
            return false;
        }
        isForeground = true;
        return true;
    }

    /**
     * 刷新下载进度通知（N-02）。
     *
     * 进度由 JS 侧汇总后下发：原生只认直链任务，HLS 任务在 JS 下载器里，
     * 只有 JS 有全量视图。百分比沿用队列 summary 的加权口径（P2-1：字节比会把
     * "13 个任务里 2 个完成"算成 100%），这里只做展示与节流。
     */
    public static void updateProgress(Context context, int doneCount, int totalCount, int percent,
                                      long remainingBytes, long speedBps) {
        DownloadService service = instanceRef.get();
        if (service == null || !service.isForeground) return;

        long now = SystemClock.elapsedRealtime();
        synchronized (DownloadService.class) {
            if (percent == lastNotifiedPercent && now - lastNotifiedAt < NOTIFY_MIN_INTERVAL_MS) return;
            lastNotifiedPercent = percent;
            lastNotifiedAt = now;
        }
        service.notifyProgress(doneCount, totalCount, percent, remainingBytes, speedBps);
    }

    private void notifyProgress(int doneCount, int totalCount, int percent, long remainingBytes, long speedBps) {
        if (notificationManager == null) return;
        String title = String.format("下载中 %d/%d", doneCount, totalCount);
        String content = percent + "% · " + formatSpeed(speedBps);
        // 未开始任务的大小未知时，剩余字节只是"已知部分"，ETA 因此偏乐观——文案用「约」承担这一点
        // 不确定进度按 percent 判：JS 侧体积未知时会把剩余字节报 0，但百分比仍是可信的
        Notification notification = buildNotification(title, content, remainingEtaText(remainingBytes, speedBps),
                percent, percent <= 0);
        notificationManager.notify(NOTIFICATION_ID, notification);
    }

    private static String remainingEtaText(long remainingBytes, long speedBps) {
        if (remainingBytes <= 0 || speedBps <= 0) return null;
        long minutes = remainingBytes / speedBps / 60;
        if (minutes < 1) return "剩余不足 1 分钟";
        if (minutes < 60) return "剩余约 " + minutes + " 分钟";
        return "剩余约 " + (minutes / 60) + " 小时 " + (minutes % 60) + " 分";
    }

    /**
     * 刷新"转封装中"通知。
     *
     * @param percent 0–100；传 -1 表示进度未知（视频轨没有时长元数据，如部分 TS）
     */
    private void notifyPostprocess(int percent) {
        if (!isForeground || notificationManager == null) return;
        String content = percent >= 0 ? ("转封装中 " + percent + "%") : "转封装中...";
        Notification notification = buildNotification("视频下载", content, null,
                percent >= 0 ? Math.max(percent, 1) : 0, percent < 0);
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

    private Notification buildNotification(String title, String content, String subText, int progress,
                                           boolean indeterminate) {
        // 点击通知打开主界面
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, intent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_peanut)
                .setContentTitle(title)
                .setContentText(content)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setContentIntent(pendingIntent)
                .setGroup(GROUP_DOWNLOADS)
                // Android 12+ 默认把前台服务通知延后最多 10s，下载一开就要看得见
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        if (subText != null) {
            builder.setSubText(subText);
        }

        if (indeterminate) {
            builder.setProgress(0, 0, true); // 不确定进度条
        } else if (progress > 0) {
            builder.setProgress(100, Math.min(progress, 100), false);
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
     *
     * P0-2：`startForegroundService()` 本身在 Android 12+ 也可能被拒（应用不在前台、
     * ROM 管家限制），调用点有三处原生下载路径 + 转封装路径，都不该因为这个异常炸线程。
     * 起活失败只意味着这一轮没有保活：下载继续跑，回前台后 JS 侧会重新要求保活。
     */
    public static void start(Context context) {
        stopWhenReady = false; // 新的保活诉求作废尚未落地的收回
        Intent intent = new Intent(context, DownloadService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            Log.w(TAG, "startForegroundService rejected", e);
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
