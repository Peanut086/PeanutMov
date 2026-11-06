package com.qoder.cinema;

import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONObject;

import java.util.List;

/**
 * 全局 startActivity 守卫：吞掉 `android.settings.*` 系统设置页跳转。
 *
 * 背景：TVBox jar 爬虫（如 ftyguard 系列）在 init 期会自行申请「所有文件访问」
 * 等特殊权限并拉起对应设置页；本应用不声明这些权限（设置页开关必然置灰），
 * 放行只会打断用户。应用自身从不打开系统设置页（全工程无此调用），因此全局
 * 过滤是安全的。SpiderPlugin.GuardedSpiderContext 只能拦住经由传入 Context 的
 * 跳转，爬虫若反射获取 Application（ActivityThread.currentApplication()）则绕过
 * 包装——所以必须在 Application 层兜底（真机实证 2026-10-25 20:30 绕过一次）。
 */
public class MainApplication extends Application {

    private static final String TAG = "SettingsJumpGuard";
    private static final String SETTINGS_ACTION_PREFIX = "android.settings.";
    /** P0: 网盘账号登录需要放行「所有文件访问」授权页 */
    private static final String ALLOWED_SETTINGS_ACTION = "android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION";

    @Override
    public void onCreate() {
        super.onCreate();
        // 初始化日志仓库（启动时恢复开关状态，清理过期日志）
        SpiderLogStore.init(this);
        // EXT-06 / FR-71（API-24）：节目提醒渠道 + 投递能力快照。
        // 必须在这里（进程启动、Capacitor 插件 load 之前）完成，渠道才以本工程的
        // 名称/重要性登记；排期、持久化、重启恢复仍由 @capacitor/local-notifications 负责。
        ReminderNotifications.bootstrap(this);
        // P3：安装全局崩溃处理器，写 FATAL 日志后交还默认处理
        installCrashHandler();
        // REV-24：初始化崩溃哨兵并检查上次异常退出
        CrashSentinel.init(this);
        checkLastExit();
    }

    /**
     * REV-24：检查上次退出原因，若发现未清除的哨兵则记录并隔离
     */
    private void checkLastExit() {
        // 1. 检查未清除的哨兵
        JSONObject sentinel = CrashSentinel.readUncleared();
        if (sentinel != null) {
            Log.w(TAG, "found uncleared sentinel: " + sentinel.toString());
            CrashSentinel.recordCrash(this, sentinel);

            // 根据哨兵内容生成隔离签名
            String signature = buildQuarantineSignature(sentinel);
            if (signature != null) {
                // 爬虫原生崩溃归因可靠（哨兵紧贴 invoke 写入/清除）：首次即隔离该 jar+api，
                // 避免同一坏源反复崩进程；7 天后自动过期，也可在健康管理手动解除。
                // 其余签名（exoplayer）沿用 24h 内 2 次阈值——播放崩溃更可能与具体内容相关。
                if (signature.startsWith("spider:") || shouldQuarantine(signature)) {
                    CrashSentinel.quarantine(this, signature);
                    Log.w(TAG, "quarantined: " + signature);
                }
            }
            // 清除哨兵（已记录）
            CrashSentinel.end();
            // P2：检查是否应进入安全模式
            checkSafeMode();
        }

        // 2. 读取 ApplicationExitInfo（API 30+）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                List<ApplicationExitInfo> exitInfos = getApplicationContext()
                        .getSystemService(android.app.ActivityManager.class)
                        .getHistoricalProcessExitReasons(null, 0, 5);
                for (ApplicationExitInfo info : exitInfos) {
                    if (info.getReason() == ApplicationExitInfo.REASON_SIGNALED
                            || info.getReason() == ApplicationExitInfo.REASON_CRASH
                            || info.getReason() == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                        Log.w(TAG, "last exit: reason=" + info.getReason()
                                + " status=" + info.getStatus()
                                + " description=" + info.getDescription());
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "failed to read ApplicationExitInfo", e);
            }
        }

        // 3. 稳定启动（无新崩溃）时自动静默退出安全模式——用户无感，爬虫源立即恢复
        if (sentinel == null && isSafeMode(this)) {
            exitSafeMode(this);
            Log.i(TAG, "stable launch: auto-exited safe mode");
        }
    }

    /**
     * 根据哨兵内容构建隔离签名
     */
    private String buildQuarantineSignature(JSONObject sentinel) {
        try {
            String action = sentinel.optString("action", "");
            if (action.startsWith("spider.")) {
                String jarMd5 = sentinel.optString("jarMd5", "");
                String api = sentinel.optString("api", "");
                if (!jarMd5.isEmpty() && !api.isEmpty()) {
                    return "spider:" + jarMd5 + ":" + api;
                }
            } else if (action.equals("exoplayer")) {
                String sourceId = sentinel.optString("sourceId", "");
                String host = sentinel.optString("host", "");
                if (!sourceId.isEmpty() && !host.isEmpty()) {
                    return "exoplayer:" + sourceId + ":" + host;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to build quarantine signature", e);
        }
        return null;
    }

    /**
     * 判断是否应该隔离（24 小时内同签名崩溃 2 次）
     */
    private boolean shouldQuarantine(String signature) {
        org.json.JSONArray history = CrashSentinel.getCrashHistory(this);
        long now = System.currentTimeMillis();
        long windowMs = 24 * 60 * 60 * 1000L;
        int count = 0;
        try {
            for (int i = 0; i < history.length(); i++) {
                JSONObject entry = history.getJSONObject(i);
                long recordedAt = entry.getLong("recordedAt");
                if (now - recordedAt > windowMs) continue;
                JSONObject s = entry.getJSONObject("sentinel");
                String sig = buildQuarantineSignature(s);
                if (signature.equals(sig)) {
                    count++;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to check quarantine threshold", e);
        }
        return count >= 2;
    }

    // ========== REV-24 P2：安全模式 ==========

    private static final String KEY_SAFE_MODE = "safe_mode";
    private static final String KEY_SAFE_MODE_SINCE = "safe_mode_since";
    private static final long SAFE_MODE_WINDOW_MS = 60 * 1000L; // 60 秒
    private static final int SAFE_MODE_THRESHOLD = 2; // 60 秒内 2 次崩溃进入安全模式
    private static final long SAFE_MODE_DURATION_MS = 24 * 60 * 60 * 1000L; // 24h 自动过期，避免永久卡死

    /**
     * 检查是否应进入安全模式（60 秒内崩溃 2 次）
     */
    private void checkSafeMode() {
        org.json.JSONArray history = CrashSentinel.getCrashHistory(this);
        long now = System.currentTimeMillis();
        int recentCrashes = 0;
        try {
            for (int i = history.length() - 1; i >= 0; i--) {
                JSONObject entry = history.getJSONObject(i);
                long recordedAt = entry.getLong("recordedAt");
                if (now - recordedAt > SAFE_MODE_WINDOW_MS) break;
                recentCrashes++;
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to check safe mode", e);
        }
        if (recentCrashes >= SAFE_MODE_THRESHOLD) {
            Log.w(TAG, "entering safe mode: " + recentCrashes + " crashes in 60s");
            android.content.SharedPreferences prefs = getSharedPreferences("crash-sentinel-prefs", MODE_PRIVATE);
            prefs.edit()
                    .putBoolean(KEY_SAFE_MODE, true)
                    .putLong(KEY_SAFE_MODE_SINCE, System.currentTimeMillis())
                    .apply();
        }
    }

    /**
     * 查询当前是否处于安全模式（供 SpiderPlugin / ExoPlayerPlugin 调用）
     */
    public static boolean isSafeMode(Context context) {
        try {
            android.content.SharedPreferences prefs = context.getSharedPreferences("crash-sentinel-prefs", MODE_PRIVATE);
            if (!prefs.getBoolean(KEY_SAFE_MODE, false)) return false;
            long since = prefs.getLong(KEY_SAFE_MODE_SINCE, 0L);
            if (since > 0 && System.currentTimeMillis() - since > SAFE_MODE_DURATION_MS) {
                prefs.edit().putBoolean(KEY_SAFE_MODE, false).remove(KEY_SAFE_MODE_SINCE).apply();
                Log.i(TAG, "safe mode auto-expired after 24h");
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 手动退出安全模式（供前端设置页调用）
     */
    public static void exitSafeMode(Context context) {
        try {
            android.content.SharedPreferences prefs = context.getSharedPreferences("crash-sentinel-prefs", MODE_PRIVATE);
            prefs.edit().putBoolean(KEY_SAFE_MODE, false).remove(KEY_SAFE_MODE_SINCE).apply();
            CrashSentinel.clearCrashHistory(context);
            Log.i(TAG, "safe mode exited");
        } catch (Exception e) {
            Log.w(TAG, "failed to exit safe mode", e);
        }
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable throwable) {
                try {
                    SpiderLogStore store = SpiderLogStore.get();
                    if (store != null) {
                        String msg = "FATAL in thread [" + thread.getName() + "]: "
                                + throwable.getClass().getName() + ": " + throwable.getMessage()
                                + "\n" + Log.getStackTraceString(throwable);
                        store.log("F", "CrashHandler", msg);
                        store.flushNow();
                    }
                } catch (Exception ignored) {
                    // 崩溃处理器内部不能再崩
                }
                if (defaultHandler != null) {
                    defaultHandler.uncaughtException(thread, throwable);
                }
            }
        });
    }

    @Override
    public void startActivity(Intent intent) {
        if (blockSettingsJump(intent)) return;
        super.startActivity(intent);
    }

    @Override
    public void startActivity(Intent intent, Bundle options) {
        if (blockSettingsJump(intent)) return;
        super.startActivity(intent, options);
    }

    private static boolean blockSettingsJump(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action != null && action.startsWith(SETTINGS_ACTION_PREFIX)) {
            // P0: 放行「所有文件访问」授权页，其余 settings 跳转继续拦截
            if (ALLOWED_SETTINGS_ACTION.equals(action)) {
                Log.d(TAG, "allowed settings jump: " + action);
                return false;
            }
            Log.w(TAG, "blocked settings jump: " + action);
            return true;
        }
        return false;
    }

    /** 供 MainActivity 等其它入口复用（jar 权限库会解包到 Activity 直调其 startActivity） */
    static boolean shouldBlockSettingsJump(Intent intent) {
        return blockSettingsJump(intent);
    }
}
