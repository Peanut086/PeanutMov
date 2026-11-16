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
        // P2-15：xCrash 原生崩溃/ANR 捕获（须在 installCrashHandler 之前，避免链式覆盖）
        // A2：xCrash 初始化（带参数 + errno 检查 + dumper 自检）
        xcrash.XCrash.InitParameters xcrashParams = new xcrash.XCrash.InitParameters()
                .setLogDir(new java.io.File(getFilesDir(), "tombstones").getAbsolutePath())
                .setNativeRethrow(true)
                .setJavaRethrow(true);
        int xcrashErr = xcrash.XCrash.init(this, xcrashParams);
        if (xcrashErr != 0) {
            AppLog.w(TAG, "xcrash init failed errno=" + xcrashErr);
        }
        // dumper 不存在则原生崩溃必无 tombstone（本次修复前就是这个原因）
        java.io.File dumper = new java.io.File(getApplicationInfo().nativeLibraryDir, "libxcrash_dumper.so");
        if (!dumper.exists()) {
            AppLog.w(TAG, "xcrash dumper missing: " + dumper);
        }
        // P3：安装全局崩溃处理器，写 FATAL 日志后交还默认处理
        installCrashHandler();
        // REV-24：初始化崩溃哨兵并检查上次异常退出
        CrashSentinel.init(this);
        checkLastExit();
    }

    /**
     * REV-24 / B3：检查上次退出原因，若发现未清除的哨兵则记录并隔离
     * OPT-17: tombstone 摄入与 ApplicationExitInfo 读取移后台（IO 重，不阻塞启动）
     */
    private void checkLastExit() {
        // 1. 检查未清除的哨兵（B1：per-invocation token 版）—— 同步，决定安全模式
        java.util.List<JSONObject> sentinels = CrashSentinel.readUnclearedAll();
        boolean crashed = true;
        if (!sentinels.isEmpty()) {
            // 取最新的（startedAt 最大）作为归因目标
            JSONObject sentinel = sentinels.get(0);
            AppLog.w(TAG, "found " + sentinels.size() + " uncleared sentinels, attributing to: " + sentinel.toString());

            // G1：先问系统上次进程究竟怎么没的。哨兵只证明「死亡时该操作在途」，不证明因果；
            // ROM 后台清理/低内存杀进程也会留下未清除哨兵，照常隔离等于每次被清就随机冤枉一个好源。
            ExitVerdict verdict = classifyLastExit(sentinel.optInt("pid", -1));
            AppLog.w("CrashExit", "sentinel attribution: " + verdict.detail);
            crashed = verdict.kind != ExitAttribution.NON_CRASH_EXIT;

            if (crashed) {
                CrashSentinel.recordCrash(this, sentinel);

                // 根据哨兵内容生成隔离签名
                String signature = buildQuarantineSignature(sentinel);
                if (signature != null) {
                    // 爬虫原生崩溃归因可靠（哨兵紧贴 invoke 写入/清除）：首次即隔离该 jar+api，
                    // 避免同一坏源反复崩进程；7 天后自动过期，也可在健康管理手动解除。
                    // 其余签名（exoplayer）沿用 24h 内 2 次阈值——播放崩溃更可能与具体内容相关。
                    if (signature.startsWith("spider:") || shouldQuarantine(signature)) {
                        CrashSentinel.quarantine(this, signature);
                        AppLog.w(TAG, "quarantined: " + signature);
                    }
                }

                // 记录其他并发哨兵作为上下文
                for (int i = 1; i < sentinels.size(); i++) {
                    AppLog.i(TAG, "inFlight sentinel: " + sentinels.get(i).toString());
                }

                // P2：检查是否应进入安全模式
                checkSafeMode();
            } else {
                // 被系统杀掉：在途哨兵只是被打断，不记崩溃、不隔离、不进安全模式
                for (int i = 0; i < sentinels.size(); i++) {
                    AppLog.i(TAG, "inFlight at kill (not a crash): " + sentinels.get(i).toString());
                }
            }

            // 清除所有哨兵（两种归因都已记录完毕）
            CrashSentinel.clearAll();
        }

        // 2. 稳定启动（无新崩溃）时自动静默退出安全模式——用户无感，爬虫源立即恢复
        //    被系统强杀同样算稳定启动：那些隔离/降级本就不该由它触发。
        if (!crashed && isSafeMode(this)) {
            exitSafeMode(this);
            Log.i(TAG, "system kill: auto-exited safe mode");
        }
        if (sentinels.isEmpty() && isSafeMode(this)) {
            exitSafeMode(this);
            Log.i(TAG, "stable launch: auto-exited safe mode");
        }

        // OPT-17: 以下 IO 重操作移后台线程
        new Thread(() -> {
            // 0. 摄入 tombstone 摘要（A3）
            CrashNative.TombstoneInfo tombstone = CrashNative.ingest(this);
            if (tombstone != null) {
                AppLog.w(TAG, "found native tombstone: " + tombstone.filename + " signal=" + tombstone.signal);
            }

            // 3. 读取 ApplicationExitInfo（API 30+）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    // 原生 SIGSEGV 等绕过 Java 崩溃处理器，只能靠 ApplicationExitInfo 归因。
                    // 华为屏蔽第三方 logcat，故写文件日志（W 级，开关关闭也落盘），查看页可见。
                    // 按时间戳去重：只记录上次启动之后新出现的退出，避免每次启动重复刷旧崩溃。
                    android.content.SharedPreferences exitPrefs =
                            getSharedPreferences("crash-exit-info", MODE_PRIVATE);
                    long lastSeen = exitPrefs.getLong("lastTs", 0L);
                    long maxSeen = lastSeen;
                    // 16 条：WebView 沙箱进程的退出会插在主进程记录前面，5 条经常读不到主进程那条。
                    // 按包名过滤——传 null 会把别的 App 的退出记录一起塞进这 16 个名额里，把我们的挤掉。
                    List<ApplicationExitInfo> exitInfos = getApplicationContext()
                            .getSystemService(android.app.ActivityManager.class)
                            .getHistoricalProcessExitReasons(getPackageName(), 0, 16);
                    for (ApplicationExitInfo info : exitInfos) {
                        if (info.getTimestamp() > maxSeen) maxSeen = info.getTimestamp();
                        if (info.getTimestamp() <= lastSeen) continue;
                        // G2：所有原因都落盘。此前只记 2/4/5，而国产 ROM 上「闪退」的主因是
                        // reason=10/13（管家强杀）与 3（低内存），日志里一行都没有，用户报
                        // 「崩溃」时无从归因。W 级保证详细日志开关关闭也落盘。
                        int kind = ExitAttribution.classify(
                                info.getReason(), info.getStatus(), info.getDescription());
                        String prefix = kind == ExitAttribution.CRASH
                                ? "crash exit: "
                                : kind == ExitAttribution.NON_CRASH_EXIT
                                        ? "process gone (not a crash): "
                                        : "process gone (reason undetermined): ";
                        AppLog.w("CrashExit", prefix + ExitAttribution.summary(info));
                    }
                    if (maxSeen > lastSeen) exitPrefs.edit().putLong("lastTs", maxSeen).apply();
                } catch (Exception e) {
                    AppLog.w(TAG, "failed to read ApplicationExitInfo", e);
                }
            }
        }, "startup-io").start();
    }

    /** 上次进程退出的归因结论：kind 为 ExitAttribution.CRASH / NON_CRASH_EXIT / UNKNOWN，detail 为整行日志文案 */
    private static final class ExitVerdict {
        final int kind;
        final String detail;

        ExitVerdict(int kind, String detail) {
            this.kind = kind;
            this.detail = detail;
        }
    }

    /**
     * G1：查系统记录的最近一次主进程退出，判断是崩溃还是被杀。
     * <p>
     * 先用哨兵里的 pid 精确查（同一 pid 的退出不可能来自别的进程，返回集也最小）；
     * 查不到再退回该包名最新的一条。API 30 以下没有该接口，或读取异常时返回 UNKNOWN
     * ——保持原有「按崩溃处理」的行为。
     */
    private ExitVerdict classifyLastExit(int sentinelPid) {
        int kind = ExitAttribution.UNKNOWN;
        String detail = "no ApplicationExitInfo (API " + Build.VERSION.SDK_INT + ")";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                android.app.ActivityManager am = getApplicationContext()
                        .getSystemService(android.app.ActivityManager.class);
                String self = getPackageName();
                ApplicationExitInfo target = null;
                boolean byPid = false;
                if (sentinelPid > 0) {
                    target = newestMainProcess(am.getHistoricalProcessExitReasons(self, sentinelPid, 4), self);
                    byPid = target != null;
                }
                if (target == null) {
                    // WebView 沙箱进程的退出记录会插在前面，只能多取几条再筛主进程
                    target = newestMainProcess(am.getHistoricalProcessExitReasons(self, 0, 16), self);
                }
                if (target != null) {
                    kind = ExitAttribution.classify(
                            target.getReason(), target.getStatus(), target.getDescription());
                    detail = (byPid ? "pid matched" : "newest main-process exit")
                            + "; " + ExitAttribution.summary(target);
                } else {
                    detail = "no main-process exit record";
                }
            } catch (Exception e) {
                detail = "read ApplicationExitInfo failed: " + e;
            }
        }
        return new ExitVerdict(kind, ExitAttribution.kindName(kind) + " (" + detail + ")");
    }

    /** 过滤掉 WebView 沙箱等子进程；exit-info 按时间倒序，第一条即最新 */
    private static ApplicationExitInfo newestMainProcess(List<ApplicationExitInfo> infos, String self) {
        for (ApplicationExitInfo info : infos) {
            if (self.equals(info.getProcessName())) return info;
        }
        return null;
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
