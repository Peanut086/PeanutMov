package com.github.catvod.crawler;

import android.util.Log;

/**
 * TVBox 框架 `SpiderDebug` stub。
 *
 * 只做日志收集：爬虫内部 `SpiderDebug.log(...)` 调用量很大（单 jar 上百处），
 * 保留环形缓冲供 JS 侧排查，但不阻塞主流程。
 *
 * 注意：jar 内是以 `invoke-static` 调用的（dexdump 实证），所以方法**必须**声明为
 * static。声明成实例方法会在运行期抛
 * `IncompatibleClassChangeError: The method 'void SpiderDebug.log(...)' was
 *  expected to be of type static`，把整条源打死。
 */
public class SpiderDebug {

    private static final String TAG = "CatVodSpider";
    private static final int MAX_LINES = 200;

    private static final Object LOCK = new Object();
    private static final String[] LINES = new String[MAX_LINES];
    private static int cursor = 0;

    public static void log(String msg) {
        if (msg == null) return;
        Log.d(TAG, msg);
        synchronized (LOCK) {
            LINES[cursor] = msg;
            cursor = (cursor + 1) % MAX_LINES;
        }
    }

    public static void log(Throwable tr) {
        if (tr == null) return;
        log(tr.getClass().getSimpleName() + ": " + tr.getMessage());
    }

    /**
     * TVBox 里还有 `log(String, Throwable)` 重载（部分 jar 会调用），
     * 缺失时同样抛 IncompatibleClassChangeError，一并补上。
     */
    public static void log(String msg, Throwable tr) {
        if (msg != null) log(msg);
        if (tr != null) log(tr);
    }

    /** 取出最近的日志（按写入顺序），供 `invoke` 结果回传 JS */
    public static String[] drain() {
        synchronized (LOCK) {
            String[] out = new String[MAX_LINES];
            int index = 0;
            for (int i = 0; i < MAX_LINES; i++) {
                String line = LINES[(cursor + i) % MAX_LINES];
                if (line != null) out[index++] = line;
            }
            String[] trimmed = new String[index];
            System.arraycopy(out, 0, trimmed, 0, index);
            java.util.Arrays.fill(LINES, null);
            cursor = 0;
            return trimmed;
        }
    }
}
