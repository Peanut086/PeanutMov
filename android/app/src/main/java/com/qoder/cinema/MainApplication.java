package com.qoder.cinema;

import android.app.Application;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

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

    @Override
    public void onCreate() {
        super.onCreate();
        // 初始化日志仓库（启动时恢复开关状态，清理过期日志）
        SpiderLogStore.init(this);
        // P3：安装全局崩溃处理器，写 FATAL 日志后交还默认处理
        installCrashHandler();
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
