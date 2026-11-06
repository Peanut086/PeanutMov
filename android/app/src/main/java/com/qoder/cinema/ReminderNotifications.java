package com.qoder.cinema;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;

import androidx.core.app.NotificationManagerCompat;

/**
 * 节目提醒的原生基础设施（EXT-06 / FR-71，API-24 原生侧）。
 *
 * <h3>为什么这里没有插件</h3>
 * API-24 的原生适配层是 `src/native/notificationScheduler.ts`，它直接包装
 * `@capacitor/local-notifications@7`（技术方案 §3 API-24「不新增原生插件」）。
 * 因此原生侧只剩三件**不属于 JS 契约**的状态需要落地：通知渠道、精确闹钟能力快照、
 * 降级诊断日志。排期 / 持久化 / 重启恢复 / 点击回传全部由官方插件承担，若在此复制
 * 任何一条，就会产生第二份排期与存储，同一提醒可能触发两次。
 *
 * <h3>插件已经负责、此处刻意不重复的部分</h3>
 * · 排期：`AlarmManager.setExactAndAllowWhileIdle`，`canScheduleExactAlarms()` 为 false
 *   时自动退化为 `setAndAllowWhileIdle`（不抛异常），故本类不做闹钟兜底；
 * · 持久化：插件 `NotificationStorage`（SharedPreferences，键 `NOTIFICATION_STORE`）；
 * · 重启恢复：插件 `LocalNotificationRestoreReceiver`（BOOT_COMPLETED /
 *   LOCKED_BOOT_COMPLETED / QUICKBOOT_POWERON），manifest 合并后已在 APK 内；
 * · 点击：插件把整条通知（含 `extra.reminderId` / `extra.route`）塞进 PendingIntent，
 *   `localNotificationActionPerformed` 时原样回传 JS。
 *
 * <h3>渠道当前的实际落点（已在自测记录 §8 上报）</h3>
 * 前端 `notificationScheduler.ts` 的 `schedule()` 未向插件传 `channelId`，
 * 插件因此用自建的 `default` 渠道（IMPORTANCE_DEFAULT）投递。本类按 API-24 约定
 * 预先建好 {@link #CHANNEL_ID}（节目提醒 / IMPORTANCE_HIGH）；待前端在排期入参补
 * `channelId: "programme_reminders"` 后，提醒即走 HIGH 渠道（含横幅弹出）。
 *
 * 调用点：{@link MainApplication#onCreate()}，必须早于 Capacitor 插件 `load()`。
 */
public final class ReminderNotifications {

    /** API-24 约定的提醒渠道 id */
    public static final String CHANNEL_ID = "programme_reminders";

    private static final String TAG = "ReminderNotify";
    private static final String CHANNEL_NAME = "节目提醒";
    private static final String CHANNEL_DESC = "节目开播前的本地提醒";

    private ReminderNotifications() {}

    /**
     * 幂等初始化：建渠道 + 记录投递能力快照。
     *
     * 任何异常都被吞掉并记录——通知是增强能力，初始化失败不得拖垮应用启动
     * （AC-169：失败降级为「仅 App 内提醒」，不静默、不崩溃）。
     */
    public static void bootstrap(Context context) {
        if (context == null) return;
        try {
            createChannel(context);
            logCapabilities(context);
        } catch (Throwable error) {
            AppLog.w(TAG, "reminder notification bootstrap failed", error);
        }
    }

    /**
     * 建档（minSdk 29 ≥ O，无版本分支）。已存在时系统只更新名称/描述，
     * 重要性不能被程序调低后再调高，故回读实际值并按需告警。
     */
    private static void createChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            AppLog.w(TAG, "notification service unavailable");
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(CHANNEL_DESC);
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);

        NotificationChannel actual = manager.getNotificationChannel(CHANNEL_ID);
        if (actual == null) {
            AppLog.w(TAG, "channel missing after create: " + CHANNEL_ID);
        } else if (actual.getImportance() < NotificationManager.IMPORTANCE_HIGH) {
            // 用户可在系统设置里降级渠道重要性；此时提醒不再横幅弹出，需可追踪
            AppLog.w(TAG, "channel importance degraded: " + actual.getImportance()
                    + " channel=" + CHANNEL_ID);
        }
    }

    /**
     * 记录影响提醒触达的三个系统状态（字段均为枚举/布尔，无敏感信息）：
     * 通知权限、精确闹钟可用性、电池优化豁免。
     *
     * 用途：国产 ROM 后台清理导致"提醒没响"时，现场只需看应用日志
     * （filesDir/logs/spider-YYYY-MM-DD.log）就能区分是权限问题、精确闹钟未授权，
     * 还是被省电策略限制——对应技术方案 R-03。
     */
    private static void logCapabilities(Context context) {
        boolean notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled();

        boolean exactAlarmAllowed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AlarmManager alarmManager = context.getSystemService(AlarmManager.class);
            exactAlarmAllowed = alarmManager != null && alarmManager.canScheduleExactAlarms();
        }

        boolean batteryExempt = true;
        PowerManager powerManager = context.getSystemService(PowerManager.class);
        if (powerManager != null) {
            batteryExempt = powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
        }

        String snapshot = "notifications=" + notificationsEnabled
                + " exactAlarm=" + exactAlarmAllowed
                + " batteryExempt=" + batteryExempt
                + " sdk=" + Build.VERSION.SDK_INT;
        if (notificationsEnabled && exactAlarmAllowed) {
            AppLog.i(TAG, snapshot);
        } else {
            // 降级路径：AC-169 要求"不静默失败"，原生侧无 UI 可提示，至少留痕
            AppLog.w(TAG, "reminder delivery degraded: " + snapshot);
        }
    }
}
