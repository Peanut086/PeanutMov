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
 * <h3>渠道落点（P2-2 起已接上）</h3>
 * 本类按 API-24 约定预先建好 {@link #CHANNEL_ID}（节目提醒 / IMPORTANCE_HIGH），
 * 前端 `notificationScheduler.schedule()` 排期时显式带 `channelId: CHANNEL_ID`，
 * 提醒因此走 HIGH 渠道（横幅弹出）；渠道被用户降级时 `readState()` 会如实报出来，
 * 界面按「可能被系统延迟」披露而不是继续声称会准时提醒。
 *
 * 调用点：{@link MainApplication#onCreate()}，必须早于 Capacitor 插件 `load()`。
 * 读取与设置页入口见 {@link ReminderPlugin}。
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
            ensureChannel(context);
            logCapabilities(context);
        } catch (Throwable error) {
            AppLog.w(TAG, "reminder notification bootstrap failed", error);
        }
    }

    /**
     * 投递能力快照（P2-2）。
     *
     * 前端据此把提醒分成三档：`精确提醒` / `可能被系统延迟` / `仅 App 内提醒`，
     * 字段本身也进日志，"提醒没响"时不用复现就能定位是哪一环。
     */
    public static final class State {
        /** 系统总开关：通知权限是否授予 */
        public final boolean notificationsEnabled;
        /** `programme_reminders` 渠道是否存在（不存在则投递会落到插件自建的 default 渠道） */
        public final boolean channelExists;
        /** 渠道当前重要性；渠道缺失为 -1 */
        public final int channelImportance;
        /** Android 12+ 的精确闹钟授权（12 以下恒为 true：没有这道闸门） */
        public final boolean exactAlarmsAllowed;
        /** 电池优化豁免；仅用于诊断展示，不作为降级判据（默认不豁免是正常状态） */
        public final boolean batteryOptimizationIgnored;

        State(boolean notificationsEnabled, boolean channelExists, int channelImportance,
              boolean exactAlarmsAllowed, boolean batteryOptimizationIgnored) {
            this.notificationsEnabled = notificationsEnabled;
            this.channelExists = channelExists;
            this.channelImportance = channelImportance;
            this.exactAlarmsAllowed = exactAlarmsAllowed;
            this.batteryOptimizationIgnored = batteryOptimizationIgnored;
        }

        /** 渠道是否还能横幅弹出（用户可在系统设置里降级，降级后不再算"精确"） */
        public boolean channelHeadsUp() {
            return channelExists && channelImportance >= 4;
        }

        @Override
        public String toString() {
            return "notifications=" + notificationsEnabled
                    + " channel=" + CHANNEL_ID + (channelExists ? "" : "(missing)")
                    + " importance=" + channelImportance
                    + " exactAlarm=" + exactAlarmsAllowed
                    + " batteryExempt=" + batteryOptimizationIgnored;
        }
    }

    /**
     * 读取当前投递能力（只读，不建渠道、不改任何系统状态）。
     *
     * 任一查询异常都按"不可用"收敛（保守降级），调用方据此显示「仅 App 内提醒」而不是崩溃。
     */
    public static State readState(Context context) {
        if (context == null) return new State(false, false, -1, false, false);
        boolean notifications;
        try {
            notifications = NotificationManagerCompat.from(context).areNotificationsEnabled();
        } catch (Throwable error) {
            AppLog.w(TAG, "areNotificationsEnabled failed", error);
            notifications = false;
        }

        boolean exists = false;
        int importance = -1;
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            NotificationChannel channel =
                    manager == null ? null : manager.getNotificationChannel(CHANNEL_ID);
            if (channel != null) {
                exists = true;
                importance = channel.getImportance();
            }
        } catch (Throwable error) {
            AppLog.w(TAG, "read channel failed", error);
        }

        boolean exact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                AlarmManager alarmManager = context.getSystemService(AlarmManager.class);
                exact = alarmManager != null && alarmManager.canScheduleExactAlarms();
            } catch (Throwable error) {
                AppLog.w(TAG, "canScheduleExactAlarms failed", error);
                exact = false;
            }
        }

        boolean batteryExempt = true;
        try {
            PowerManager powerManager = context.getSystemService(PowerManager.class);
            if (powerManager != null) {
                batteryExempt = powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
            }
        } catch (Throwable error) {
            AppLog.w(TAG, "isIgnoringBatteryOptimizations failed", error);
        }

        return new State(notifications, exists, importance, exact, batteryExempt);
    }

    /**
     * 建档（minSdk 29 ≥ O，无版本分支）。已存在时系统只更新名称/描述，
     * 重要性不能被程序调低后再调高，故回读实际值并按需告警。
     *
     * 幂等且可重复调用：前端每次读取投递状态前也会补一次，
     * 这样即使启动期初始化失败，第一次进提醒页就能把渠道建回来。
     */
    public static void ensureChannel(Context context) {
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
     * 记录影响提醒触达的系统状态（字段均为枚举/布尔，无敏感信息）。
     *
     * 用途：国产 ROM 后台清理导致"提醒没响"时，现场只需看应用日志
     * （filesDir/logs/spider-YYYY-MM-DD.log）就能区分是权限问题、精确闹钟未授权、
     * 渠道被降级，还是被省电策略限制——对应技术方案 R-03。快照口径与 {@link #readState}
     * 同源（P2-2：界面显示的就是这几个字段，日志与界面不会各说一套）。
     */
    private static void logCapabilities(Context context) {
        State state = readState(context);
        if (state.notificationsEnabled && state.exactAlarmsAllowed && state.channelHeadsUp()) {
            AppLog.i(TAG, "reminder delivery ready: " + state);
        } else {
            // 降级路径：AC-169 要求"不静默失败"，原生侧无 UI 可提示，至少留痕
            AppLog.w(TAG, "reminder delivery degraded: " + state);
        }
    }
}
