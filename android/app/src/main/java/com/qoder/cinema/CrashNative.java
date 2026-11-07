package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * A3：原生崩溃 tombstone 摄入器
 *
 * 启动时解析 files/tombstones 下的 xCrash 原生崩溃日志，提取关键信息写入 AppLog，
 * 使其在日志页可见并可导出。同时返回最新 tombstone 信息供归因使用。
 */
public class CrashNative {
    private static final String TAG = "CrashNative";
    private static final String PREFS = "crash-native-prefs";
    private static final String KEY_INGESTED = "ingested";

    /**
     * Tombstone 解析结果（供归因交叉核对）
     */
    public static class TombstoneInfo {
        public String filename;
        public String threadName;
        public long pid;
        public long crashTime;
        public String signal;
        public String code;
        public String faultAddr;
        public String summary;
    }

    /**
     * 摄入所有未处理的 native tombstone，返回最新的一个（或 null）
     */
    public static TombstoneInfo ingest(Context ctx) {
        TombstoneInfo newest = null;
        try {
            File[] tombstones = xcrash.TombstoneManager.getNativeTombstones();
            if (tombstones == null || tombstones.length == 0) return null;

            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            Set<String> ingested = prefs.getStringSet(KEY_INGESTED, new HashSet<>());
            Set<String> newIngested = new HashSet<>(ingested);

            for (File f : tombstones) {
                String name = f.getName();
                if (ingested.contains(name)) continue;

                try {
                    Map<String, String> parsed = xcrash.TombstoneParser.parse(f);
                    String summary = buildSummary(name, parsed);
                    AppLog.w(TAG, summary);
                    newIngested.add(name);

                    // 记录最新的（按文件名排序，时间戳在文件名里）
                    if (newest == null || name.compareTo(newest.filename) > 0) {
                        newest = new TombstoneInfo();
                        newest.filename = name;
                        newest.threadName = parsed.getOrDefault(xcrash.TombstoneParser.keyThreadName, "");
                        newest.pid = parseLong(parsed.getOrDefault(xcrash.TombstoneParser.keyProcessId, "0"));
                        newest.crashTime = parseLong(parsed.getOrDefault(xcrash.TombstoneParser.keyCrashTime, "0"));
                        newest.signal = parsed.getOrDefault(xcrash.TombstoneParser.keySignal, "");
                        newest.code = parsed.getOrDefault(xcrash.TombstoneParser.keyCode, "");
                        newest.faultAddr = parsed.getOrDefault(xcrash.TombstoneParser.keyFaultAddr, "");
                        newest.summary = summary;
                    }
                } catch (Exception e) {
                    AppLog.w(TAG, "parse failed: " + name, e);
                }
            }

            prefs.edit().putStringSet(KEY_INGESTED, newIngested).apply();
        } catch (Exception e) {
            AppLog.w(TAG, "ingest failed", e);
        }
        return newest;
    }

    /**
     * 构建 tombstone 摘要（写入 AppLog 的格式）
     */
    private static String buildSummary(String filename, Map<String, String> parsed) {
        StringBuilder sb = new StringBuilder();
        sb.append("tombstone=").append(filename);
        sb.append(" signal=").append(parsed.getOrDefault(xcrash.TombstoneParser.keySignal, "?"));
        sb.append(" code=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyCode, "?"));
        sb.append(" fault=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyFaultAddr, "?"));
        sb.append(" pid=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyProcessId, "?"));
        sb.append(" tid=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyThreadId, "?"));
        sb.append(" thread=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyThreadName, "?"));
        String abort = parsed.getOrDefault(xcrash.TombstoneParser.keyAbortMessage, "");
        if (!abort.isEmpty()) {
            sb.append(" abort=").append(abort);
        }
        sb.append(" time=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyCrashTime, "?"));

        String backtrace = parsed.getOrDefault(xcrash.TombstoneParser.keyBacktrace, "");
        if (!backtrace.isEmpty()) {
            String[] lines = backtrace.split("\n");
            int count = Math.min(15, lines.length);
            sb.append("\nbacktrace (top ").append(count).append("):\n");
            for (int i = 0; i < count; i++) {
                String line = lines[i].trim();
                if (!line.isEmpty()) {
                    sb.append("  ").append(line).append("\n");
                }
            }
        }

        return sb.toString();
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s);
        } catch (Exception e) {
            return 0;
        }
    }
}
