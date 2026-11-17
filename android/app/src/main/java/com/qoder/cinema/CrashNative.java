package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * A3：原生崩溃 tombstone 摄入器
 *
 * 启动时解析 files/tombstones 下的 xCrash 原生崩溃日志，提取关键信息写入 AppLog，
 * 使其在日志页可见并可导出。同时返回最新 tombstone 信息供归因使用。
 *
 * F3：摘要深度 15 → 40，并追加寄存器 / 其它线程 / Java 栈线索。
 * F2'：为每条 tombstone 计算「崩溃签名」（fault addr + 首个 .so 帧），按签名计 24h 内
 *      复发次数；同签名 ≥2 次即置熔断标记，供预热降级（见 {@link #isPrewarmThrottled}）。
 */
public class CrashNative {
    private static final String TAG = "CrashNative";
    private static final String PREFS = "crash-native-prefs";
    private static final String KEY_INGESTED = "ingested";
    private static final String KEY_SIG_PREFIX = "sig:";      // sig:<signature> -> "[ts,ts,...]"
    private static final String KEY_THROTTLED_UNTIL = "throttledUntil";

    /** 崩溃签名熔断阈值与窗口：同签名 24h 内 ≥2 次 → 熔断 */
    private static final int BREAKER_THRESHOLD = 2;
    private static final long BREAKER_WINDOW_MS = 24 * 60 * 60 * 1000L;
    /** 熔断生效后预热降级的持续时长 */
    private static final long THROTTLE_DURATION_MS = 24 * 60 * 60 * 1000L;

    /** F3：单条 tombstone 摘要里保留的 backtrace 深度（此前 15 帧，够不到真凶 .so 帧） */
    private static final int BACKTRACE_DEPTH = 40;
    private static final int REGISTERS_LINES = 20;
    private static final int OTHER_THREADS_LINES = 40;

    /** tombstones 目录名（与 MainApplication 里 xCrash.setLogDir 一致） */
    public static final String TOMBSTONE_DIR_NAME = "tombstones";

    /**
     * Tombstone 解析结果（供归因交叉核对）
     */
    public static class TombstoneInfo {
        public String filename;
        public String threadName;
        public String processName;
        public long pid;
        public long crashTime;
        public String signal;
        public String code;
        public String faultAddr;
        public String signature;
        public boolean crashSignal;
        public String summary;
    }

    /**
     * 摄入所有未处理的 native tombstone，返回最新的一个（或 null）。
     */
    public static TombstoneInfo ingest(Context ctx) {
        TombstoneInfo newest = null;
        try {
            File[] tombstones = xcrash.TombstoneManager.getNativeTombstones();
            if (tombstones == null || tombstones.length == 0) return null;

            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            Set<String> ingested = new HashSet<>(prefs.getStringSet(KEY_INGESTED, new HashSet<>()));
            Set<String> newIngested = new HashSet<>(ingested);

            for (File f : tombstones) {
                String name = f.getName();
                if (ingested.contains(name)) continue;

                try {
                    Map<String, String> parsed = xcrash.TombstoneParser.parse(f);
                    String summary = buildSummary(name, parsed);
                    AppLog.w(TAG, summary);
                    newIngested.add(name);

                    TombstoneInfo info = new TombstoneInfo();
                    info.filename = name;
                    info.threadName = parsed.getOrDefault(xcrash.TombstoneParser.keyThreadName, "");
                    info.processName = parsed.getOrDefault(xcrash.TombstoneParser.keyProcessName, "");
                    info.pid = parseLong(parsed.getOrDefault(xcrash.TombstoneParser.keyProcessId, "0"));
                    info.crashTime = parseLong(parsed.getOrDefault(xcrash.TombstoneParser.keyCrashTime, "0"));
                    info.signal = parsed.getOrDefault(xcrash.TombstoneParser.keySignal, "");
                    info.code = parsed.getOrDefault(xcrash.TombstoneParser.keyCode, "");
                    info.faultAddr = parsed.getOrDefault(xcrash.TombstoneParser.keyFaultAddr, "");
                    info.crashSignal = isCrashSignal(info.signal);
                    info.signature = crashSignature(parsed);
                    info.summary = summary;

                    // F2'：按签名累计复发，达阈值即熔断（只统计真崩溃信号，被杀不算）
                    if (info.crashSignal && info.signature != null) {
                        recordOccurrence(prefs, info);
                    }

                    // 记录最新的（按文件名排序，时间戳在文件名里）
                    if (newest == null || name.compareTo(newest.filename) > 0) {
                        newest = info;
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
     * F2'：崩溃签名 = fault addr + backtrace 里第一个带 `.so`/库名的帧（去掉偏移与符号地址）。
     * 之所以取第一个 .so 帧而非整条栈：本次真凶是第三方 jar 的原生库，前几帧恒是 ART 跳板，
     * 稳定区分度在 .so 层。签名缺失（解析异常）时返回 null，不计熔断。
     */
    static String crashSignature(Map<String, String> parsed) {
        String fault = parsed.getOrDefault(xcrash.TombstoneParser.keyFaultAddr, "?").trim();
        String backtrace = parsed.getOrDefault(xcrash.TombstoneParser.keyBacktrace, "");
        String frame = firstSoFrame(backtrace);
        if (frame == null) return null;
        return fault + "|" + frame;
    }

    /** 从 backtrace 文本里提取第一个含 `.so` 的帧，归一化为 `lib名!(symbol|offset)` 之外的稳定串 */
    private static String firstSoFrame(String backtrace) {
        if (backtrace == null || backtrace.isEmpty()) return null;
        for (String raw : backtrace.split("\n")) {
            String line = raw.trim();
            int so = line.indexOf(".so");
            if (so < 0) continue;
            // 取 "<path>/libxxx.so (sym+off)" 里的 "libxxx.so"，丢弃路径与偏移，保证跨会话稳定
            String before = line.substring(0, so);
            int slash = Math.max(before.lastIndexOf('/'), before.lastIndexOf(' '));
            String lib = (slash >= 0 ? before.substring(slash + 1) : before).trim();
            if (lib.isEmpty()) lib = "unknown";
            return lib + ".so";
        }
        return null;
    }

    private static void recordOccurrence(SharedPreferences prefs, TombstoneInfo info) {
        try {
            long now = info.crashTime > 0 ? info.crashTime : System.currentTimeMillis();
            String key = KEY_SIG_PREFIX + info.signature;
            JSONArray arr = new JSONArray(prefs.getString(key, "[]"));
            JSONArray kept = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                long ts = arr.optLong(i, 0);
                if (now - ts <= BREAKER_WINDOW_MS) kept.put(ts);
            }
            kept.put(now);
            SharedPreferences.Editor editor = prefs.edit().putString(key, kept.toString());
            if (kept.length() >= BREAKER_THRESHOLD) {
                editor.putLong(KEY_THROTTLED_UNTIL, now + THROTTLE_DURATION_MS);
                AppLog.w(TAG, "native crash breaker tripped: sig=" + info.signature
                        + " count=" + kept.length() + " in 24h → prewarm throttled");
            }
            editor.apply();
        } catch (Exception e) {
            AppLog.w(TAG, "recordOccurrence failed", e);
        }
    }

    /** F2'/F4：当前是否处于熔断期（预热需降级为串行/延后） */
    public static boolean isPrewarmThrottled(Context ctx) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long until = prefs.getLong(KEY_THROTTLED_UNTIL, 0L);
            if (until <= 0) return false;
            if (System.currentTimeMillis() >= until) {
                prefs.edit().remove(KEY_THROTTLED_UNTIL).apply();
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 信号字符串（如 `11 (SIGSEGV)`）是否为「进程内部崩溃」而非被外部杀 */
    private static boolean isCrashSignal(String signal) {
        if (signal == null) return false;
        String s = signal.toUpperCase();
        return s.contains("SIGSEGV") || s.contains("SIGABRT") || s.contains("SIGBUS")
                || s.contains("SIGILL") || s.contains("SIGTRAP") || s.contains("SIGFPE");
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
        String pname = parsed.getOrDefault(xcrash.TombstoneParser.keyProcessName, "");
        if (!pname.isEmpty()) sb.append(" pname=").append(pname);
        String abort = parsed.getOrDefault(xcrash.TombstoneParser.keyAbortMessage, "");
        if (!abort.isEmpty()) {
            sb.append(" abort=").append(abort);
        }
        sb.append(" time=").append(parsed.getOrDefault(xcrash.TombstoneParser.keyCrashTime, "?"));

        appendBlock(sb, "backtrace (top " + BACKTRACE_DEPTH + ")",
                parsed.getOrDefault(xcrash.TombstoneParser.keyBacktrace, ""), BACKTRACE_DEPTH);
        // F3：寄存器与其它线程是定位真凶 .so / 竞态线程的关键，此前完全没落盘。
        appendBlock(sb, "registers",
                parsed.getOrDefault(xcrash.TombstoneParser.keyRegisters, ""), REGISTERS_LINES);
        appendBlock(sb, "java stacktrace",
                parsed.getOrDefault(xcrash.TombstoneParser.keyJavaStacktrace, ""), BACKTRACE_DEPTH);
        appendBlock(sb, "other threads",
                parsed.getOrDefault(xcrash.TombstoneParser.keyOtherThreads, ""), OTHER_THREADS_LINES);

        return sb.toString();
    }

    /** 追加一个多行分块（截断到 maxLines），内容为空则整体跳过 */
    private static void appendBlock(StringBuilder sb, String label, String body, int maxLines) {
        if (body == null || body.trim().isEmpty()) return;
        String[] lines = body.split("\n");
        int count = Math.min(maxLines, lines.length);
        sb.append('\n').append(label).append(":\n");
        for (int i = 0; i < count; i++) {
            String line = lines[i].trim();
            if (!line.isEmpty()) {
                sb.append("  ").append(line).append('\n');
            }
        }
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s);
        } catch (Exception e) {
            return 0;
        }
    }
}
