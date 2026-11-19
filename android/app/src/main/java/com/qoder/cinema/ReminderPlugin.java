package com.qoder.cinema;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 节目提醒的投递诊断与授权入口（P2-2 / AC-169）。
 *
 * <h3>为什么单独一个插件</h3>
 * 排期、持久化、重启恢复仍由 `@capacitor/local-notifications` 承担（见
 * {@link ReminderNotifications} 的说明），本类只补官方插件读不到、也说不出来的两件事：
 * 1) 当前投递能力（通知权限 / 渠道是否存在与被降级 / 精确闹钟授权 / 电池优化），
 *    前端据此把提醒分成「精确提醒 / 可能被系统延迟 / 仅 App 内提醒」三档如实展示；
 * 2) 打开对应系统设置页。ROM 的省电与闹钟限制只能在系统设置里解，App 里说再多也改不了；
 *    这里只做跳转，不申请 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`（不强制豁免）。
 *
 * <h3>失败口径</h3>
 * 所有查询都包在 try 内并保守降级（读不到=不可用），设置页打不开时 `reject`，
 * 由前端把原因显示出来——提醒是增强能力，任何一条都不能抛穿到调用方。
 */
@CapacitorPlugin(name = "Reminder")
public class ReminderPlugin extends Plugin {

    private static final String TAG = "ReminderNotify";

    /** 投递能力快照 + 渠道建档（读之前补一次 ensureChannel，启动期初始化失败也能自愈） */
    @PluginMethod
    public void getDeliveryState(PluginCall call) {
        try {
            ReminderNotifications.ensureChannel(getContext());
            ReminderNotifications.State state = ReminderNotifications.readState(getContext());
            AppLog.d(TAG, "delivery state read: " + state);
            JSObject out = new JSObject();
            out.put("channelId", ReminderNotifications.CHANNEL_ID);
            out.put("notificationsEnabled", state.notificationsEnabled);
            out.put("channelExists", state.channelExists);
            out.put("channelImportance", state.channelImportance);
            out.put("exactAlarmsAllowed", state.exactAlarmsAllowed);
            out.put("batteryOptimizationIgnored", state.batteryOptimizationIgnored);
            call.resolve(out);
        } catch (Throwable error) {
            AppLog.w(TAG, "read delivery state failed", error);
            call.reject("读取通知投递状态失败: " + error.getMessage());
        }
    }

    /**
     * 打开系统授权页。`target`：`notifications` / `exactAlarm` / `battery`。
     *
     * 跳转带 {@link MainApplication#EXTRA_OWN_SETTINGS_JUMP}：全局 settings 拦截是给
     * jar 爬虫准备的，本 App 自己的授权入口按私有 extra 放行并留痕。
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String target = call.getString("target", "notifications");
        Intent intent = settingsIntent(target);
        if (intent == null) {
            call.reject("当前系统版本不支持该设置页");
            return;
        }
        intent.putExtra(MainApplication.EXTRA_OWN_SETTINGS_JUMP, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            AppLog.i(TAG, "open reminder settings: " + target + " action=" + intent.getAction());
            call.resolve();
        } catch (Exception error) {
            // ROM 裁掉了对应设置页（部分定制系统确实没有精确闹钟页），如实告知而不是静默
            AppLog.w(TAG, "open settings failed: " + target, error);
            call.reject("系统未提供该设置页：" + error.getMessage());
        }
    }

    private Intent settingsIntent(String target) {
        String packageName = getContext().getPackageName();
        switch (target == null ? "notifications" : target) {
            case "exactAlarm":
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
                return new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                        .setData(Uri.parse("package:" + packageName));
            case "battery":
                return new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            case "notifications":
            default:
                return new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
        }
    }
}
