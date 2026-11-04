package com.qoder.cinema;

import android.util.Log;

/**
 * 应用日志门面（P2）
 *
 * 统一的原生日志入口：同时写 logcat 和 SpiderLogStore。
 * 供 DownloadPlugin / ExoPlayerPlugin / LocalProxyPlugin 等高价值模块使用，
 * 使查看页能看到原生模块的关键日志。
 *
 * 用法：
 *   AppLog.d("DownloadEngine", "start download: " + url);
 *   AppLog.e("ExoPlayer", "playback error", exception);
 */
public final class AppLog {

    private AppLog() {}

    public static void d(String tag, String message) {
        Log.d(tag, message);
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("D", tag, message);
    }

    public static void i(String tag, String message) {
        Log.i(tag, message);
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("I", tag, message);
    }

    public static void w(String tag, String message) {
        Log.w(tag, message);
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("W", tag, message);
    }

    public static void w(String tag, String message, Throwable tr) {
        Log.w(tag, message, tr);
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("W", tag, message + "\n" + Log.getStackTraceString(tr));
    }

    public static void e(String tag, String message) {
        Log.e(tag, message);
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("E", tag, message);
    }

    public static void e(String tag, String message, Throwable tr) {
        Log.e(tag, message, tr);
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("E", tag, message + "\n" + Log.getStackTraceString(tr));
    }
}
