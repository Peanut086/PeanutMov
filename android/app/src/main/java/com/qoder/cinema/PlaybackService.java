package com.qoder.cinema;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaStyleNotificationHelper;

/**
 * 播放前台服务（B1 媒体通知 / B2 后台保活）。
 *
 * 职责边界：只负责「通知 + 前台保活」。播放器与 {@link MediaSession} 仍归
 * {@link ExoPlayerPlugin} 所有——ExoPlayer 必须在创建它的主线程访问（AND-20），
 * 搬进服务会牵动整条崩溃敏感链路。通知按钮通过 {@link CommandSink} 回调给插件，
 * 由插件统一改播放状态并同步 JS，避免出现第二个播放状态源。
 *
 * 生命周期：起播时 start，release/用户点「关闭」时 stop。暂停期间**保持前台**：
 * Android 12+ 从后台重新 startForeground 会抛 ForegroundServiceStartNotAllowedException，
 * 退出前台再进前台的收益（省一点电）远小于这个风险。
 *
 * Android 14+ 必须以 mediaPlayback 类型 startForeground，类型在 manifest 声明。
 */
public class PlaybackService extends Service {

    private static final String TAG = "PlaybackService";
    private static final String CHANNEL_ID = "playback_channel";
    private static final int NOTIFICATION_ID = 1002;

    private static final String ACTION_START = "com.qoder.cinema.playback.START";
    private static final String ACTION_PLAY_PAUSE = "com.qoder.cinema.playback.PLAY_PAUSE";
    private static final String ACTION_PREVIOUS = "com.qoder.cinema.playback.PREVIOUS";
    private static final String ACTION_NEXT = "com.qoder.cinema.playback.NEXT";
    private static final String ACTION_STOP = "com.qoder.cinema.playback.STOP";

    /** 通知按钮回调（由 ExoPlayerPlugin 实现，主线程调用） */
    public interface CommandSink {
        void onPlayPause();

        void onPrevious();

        void onNext();

        /** 用户点「关闭」：停止播放并撤掉通知 */
        void onStop();
    }

    /**
     * start() → onStartCommand() 的会话交接。
     * MediaSession/CommandSink 都不是 Parcelable，塞不进 Intent；两者都只在主线程
     * 读写（插件的 executeOnMainThread 与 Service 生命周期回调同为主线程），故无竞争。
     */
    @Nullable private static MediaSession pendingSession;
    @Nullable private static CommandSink pendingSink;

    @Nullable private MediaSession session;
    @Nullable private CommandSink sink;
    private boolean foreground = false;

    /** 起播/换集时调用：确保服务在前台并挂上当前会话 */
    public static void start(Context context, MediaSession session, CommandSink sink) {
        pendingSession = session;
        pendingSink = sink;
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(ACTION_START);
        try {
            context.startForegroundService(intent);
        } catch (Exception e) {
            // 后台起前台服务被系统拒绝时不能连带播放一起失败：降级为无通知播放
            Log.w(TAG, "startForegroundService failed: " + e.getMessage());
            pendingSession = null;
            pendingSink = null;
        }
    }

    public static void stop(Context context) {
        pendingSession = null;
        pendingSink = null;
        try {
            context.stopService(new Intent(context, PlaybackService.class));
        } catch (Exception e) {
            Log.w(TAG, "stopService failed: " + e.getMessage());
        }
    }

    /** 播放状态/元数据变化后刷新通知（服务未运行时静默忽略） */
    public static void refresh() {
        PlaybackService service = instance;
        if (service != null) service.postNotification();
    }

    @Nullable private static volatile PlaybackService instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (pendingSession != null) {
            session = pendingSession;
            sink = pendingSink;
            pendingSession = null;
            pendingSink = null;
        }
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            CommandSink target = sink;
            if (target != null) target.onStop();
            stopSelf();
            return START_NOT_STICKY;
        }
        // 任何一次 onStartCommand 都要保证已进前台：startForegroundService 有 5s 硬期限
        ensureForeground();
        if (sink != null) {
            if (ACTION_PLAY_PAUSE.equals(action)) {
                sink.onPlayPause();
            } else if (ACTION_PREVIOUS.equals(action)) {
                sink.onPrevious();
            } else if (ACTION_NEXT.equals(action)) {
                sink.onNext();
            }
        }
        postNotification();
        // 进程被杀后不带会话重建（无播放可恢复），避免空会话常驻
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        instance = null;
        session = null;
        sink = null;
        if (foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
        }
        super.onDestroy();
    }

    private void createChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "播放", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("播放控制与后台播放");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void ensureForeground() {
        if (foreground) return;
        try {
            startForeground(NOTIFICATION_ID, buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            foreground = true;
        } catch (Exception e) {
            // 缺通知权限/系统限制时保住播放本身，不让起播链路整体失败
            Log.w(TAG, "startForeground failed: " + e.getMessage());
        }
    }

    private void postNotification() {
        if (!foreground || session == null) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception e) {
            Log.w(TAG, "notify failed: " + e.getMessage());
        }
    }

    @OptIn(markerClass = UnstableApi.class)
    private Notification buildNotification() {
        Player player = session != null ? session.getPlayer() : null;
        MediaMetadata metadata = player != null ? player.getMediaMetadata() : MediaMetadata.EMPTY;
        boolean playing = player != null && player.isPlaying();
        String title = metadata.title != null ? metadata.title.toString() : "正在播放";
        String artist = metadata.artist != null ? metadata.artist.toString() : "";

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_playback_notification)
                .setContentTitle(title)
                .setContentText(artist)
                .setContentIntent(pendingActivity(open))
                .setOngoing(playing)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(android.R.drawable.ic_media_previous, "上一集", pendingAction(ACTION_PREVIOUS, 1))
                .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "暂停" : "播放", pendingAction(ACTION_PLAY_PAUSE, 2))
                .addAction(android.R.drawable.ic_media_next, "下一集", pendingAction(ACTION_NEXT, 3))
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "关闭", pendingAction(ACTION_STOP, 4));

        if (session != null) {
            builder.setStyle(new MediaStyleNotificationHelper.MediaStyle(session)
                    .setShowActionsInCompactView(0, 1, 2));
        }
        return builder.build();
    }

    private PendingIntent pendingActivity(Intent intent) {
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent pendingAction(String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackService.class);
        intent.setAction(action);
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE);
    }
}