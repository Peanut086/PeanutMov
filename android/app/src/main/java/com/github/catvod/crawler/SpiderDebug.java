package com.github.catvod.crawler;

import android.util.Log;

/**
 * TVBox 框架 `SpiderDebug` stub。
 *
 * 只做日志收集：爬虫内部 `SpiderDebug.log(...)` 调用量很大（单 jar 上百处），
 * 保留环形缓冲供 JS 侧排查，但不阻塞主流程。
 */
public class SpiderDebug {

    private static final String TAG = "CatVodSpider";
    private static final int MAX_LINES = 200;

    private final Object lock = new Object();
    private final String[] lines = new String[MAX_LINES];
    private int cursor = 0;

    public void log(String msg) {
        if (msg == null) return;
        Log.d(TAG, msg);
        synchronized (lock) {
            lines[cursor] = msg;
            cursor = (cursor + 1) % MAX_LINES;
        }
    }

    public void log(Throwable tr) {
        if (tr == null) return;
        log(tr.getClass().getSimpleName() + ": " + tr.getMessage());
    }

    /** 取出最近的日志（按写入顺序），供 `invoke` 结果回传 JS */
    public String[] drain() {
        synchronized (lock) {
            String[] out = new String[MAX_LINES];
            int index = 0;
            for (int i = 0; i < MAX_LINES; i++) {
                String line = lines[(cursor + i) % MAX_LINES];
                if (line != null) out[index++] = line;
            }
            String[] trimmed = new String[index];
            System.arraycopy(out, 0, trimmed, 0, index);
            java.util.Arrays.fill(lines, null);
            cursor = 0;
            return trimmed;
        }
    }
}
