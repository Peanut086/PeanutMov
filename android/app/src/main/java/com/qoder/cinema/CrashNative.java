package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
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
 * G2：在此之上再加一路「宽松签名」（signal + code + 真凶 .so + 崩溃线程，不含 fault addr）。
 *      UAF / 堆越界的 fault addr 会随堆布局漂移，同一根因会被算成互不相同的严格签名，
 *      24h 内永远凑不满 2 次，熔断形同虚设；两路任一达阈值即熔断。
 */
public class CrashNative {
    private static final String TAG = "CrashNative";
    private static final String PREFS = "crash-native-prefs";
    private static final String KEY_INGESTED = "ingested";
    private static final String KEY_SIG_PREFIX = "sig:";       // 严格签名：fault addr + 首个 .so 帧
    private static final String KEY_LOOSE_SIG_PREFIX = "lgs:";  // G2 宽松签名：不含 fault addr
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
        /** G2：不含 fault addr 的第二路签名 */
        public String looseSignature;
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
                    info.looseSignature = crashSignatureLoose(parsed);
                    info.summary = summary;

                    // F2'/G2：两路签名各自累计复发，任一路达阈值即熔断（被杀不算，只统计真崩溃信号）
                    if (info.crashSignal && (info.signature != null || info.looseSignature != null)) {
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

            pruneExpiredSignatures(prefs, System.currentTimeMillis());
            prefs.edit().putStringSet(KEY_INGESTED, newIngested).apply();
        } catch (Exception e) {
            AppLog.w(TAG, "ingest failed", e);
        }
        return newest;
    }

    /**
     * F2'：严格签名 = fault addr + backtrace 里第一个带 `.so`/库名的帧（去掉偏移与符号地址）。
     * 之所以取第一个 .so 帧而非整条栈：本次真凶是第三方 jar 的原生库，前几帧恒是 ART 跳板，
     * 稳定区分度在 .so 层。签名缺失（解析异常）时返回 null，不计熔断。
     */
    static String crashSignature(Map<String, String> parsed) {
        return strictSignature(
                parsed.getOrDefault(xcrash.TombstoneParser.keyFaultAddr, "?"),
                parsed.getOrDefault(xcrash.TombstoneParser.keyBacktrace, ""));
    }

    /**
     * G2：宽松签名 = signal + code + 真凶 .so + 崩溃线程名，刻意不含 fault addr。
     * `0x7461642f`（「/dat」被当指针用）这类字符串覆盖型崩溃的 fault addr 相对稳定，但同一根因
     * 若是 UAF / 堆越界，fault addr 随堆布局逐次漂移，严格签名每次都不一样，24h 内永远凑不满
     * 阈值。真凶库取「第一个非运行时 .so 帧」，全栈只有 ART/libc 时记为 `nolib`——此时宽松签名
     * 会退化到「信号 + 线程」粒度，代价是偶发误熔断，而熔断只把预热降级成串行、不禁用任何源。
     */
    static String crashSignatureLoose(Map<String, String> parsed) {
        return looseSignature(
                parsed.getOrDefault(xcrash.TombstoneParser.keySignal, "?"),
                parsed.getOrDefault(xcrash.TombstoneParser.keyCode, "?"),
                parsed.getOrDefault(xcrash.TombstoneParser.keyBacktrace, ""),
                parsed.getOrDefault(xcrash.TombstoneParser.keyThreadName, ""));
    }

    /** 严格签名本体（纯字符串，便于 JVM 单测） */
    static String strictSignature(String faultAddr, String backtrace) {
        String frame = firstSoFrame(backtrace);
        if (frame == null) return null;
        return (faultAddr == null ? "?" : faultAddr).trim() + "|" + frame;
    }

    /** 宽松签名本体（纯字符串，便于 JVM 单测） */
    static String looseSignature(String signal, String code, String backtrace, String threadName) {
        if (backtrace == null || backtrace.trim().isEmpty()) return null;
        String culprit = culpritSoFrame(backtrace);
        return normToken(signal) + "|" + normToken(code) + "|" + culprit + "|" + normThread(threadName);
    }

    /** 运行时 / linker 帧：签名时跳过，才能落到第三方库上 */
    private static final Set<String> RUNTIME_LIBS = new HashSet<>(Arrays.asList(
            "libart", "libc", "libdl", "libm", "libbase", "libc++", "libc++abi", "libnativehelper",
            "libjavacore", "libsigchain", "libutils", "liblog", "libandroid", "libbinder",
            "libandroid_runtime", "libstagefright_foundation", "linker", "linker64"));

    /** 从 backtrace 文本里提取第一个含 `.so` 的帧名（丢弃路径与偏移，保证跨会话稳定） */
    private static String firstSoFrame(String backtrace) {
        for (String lib : soLibsOf(backtrace)) {
            return lib;
        }
        return null;
    }

    /** 第一个非运行时 .so 帧名 = 真凶库候选；全栈只有运行时帧时返回 `nolib` */
    private static String culpritSoFrame(String backtrace) {
        for (String lib : soLibsOf(backtrace)) {
            String bare = lib.substring(0, lib.length() - 3).toLowerCase(Locale.US);
            if (!RUNTIME_LIBS.contains(bare)) return lib;
        }
        return "nolib";
    }

    /** 按帧序返回 backtrace 里所有 `libxxx.so` 形式的库名 */
    private static List<String> soLibsOf(String backtrace) {
        List<String> libs = new ArrayList<>();
        if (backtrace == null || backtrace.isEmpty()) return libs;
        for (String raw : backtrace.split("\n")) {
            String line = raw.trim();
            int so = line.indexOf(".so");
            if (so < 0) continue;
            // 取 "<path>/libxxx.so (sym+off)" 里的 "libxxx.so"
            String before = line.substring(0, so);
            int slash = Math.max(before.lastIndexOf('/'), before.lastIndexOf(' '));
            String lib = (slash >= 0 ? before.substring(slash + 1) : before).trim();
            if (lib.isEmpty()) lib = "unknown";
            libs.add(lib + ".so");
        }
        return libs;
    }

    /** `11 (SIGSEGV)` / `1 (SEGV_MAPERR)` 之类字段的小写归一 */
    private static String normToken(String s) {
        if (s == null || s.trim().isEmpty()) return "?";
        return s.trim().toLowerCase(Locale.US).replaceAll("\\s+", "");
    }

    /** 线程名归一：去掉尾部编号（`spider-worker-3` → `spider-worker`），空值给 `unknown` */
    private static String normThread(String s) {
        if (s == null || s.trim().isEmpty()) return "unknown";
        return s.trim().toLowerCase(Locale.US).replaceAll("[-_]?\\d+$", "");
    }

    /** F2'/G2：严格、宽松两路各自累计，任一路达阈值即熔断 */
    private static void recordOccurrence(SharedPreferences prefs, TombstoneInfo info) {
        try {
            long now = info.crashTime > 0 ? info.crashTime : System.currentTimeMillis();
            int strict = info.signature == null ? 0
                    : bumpSignature(prefs, KEY_SIG_PREFIX + info.signature, now);
            int loose = info.looseSignature == null ? 0
                    : bumpSignature(prefs, KEY_LOOSE_SIG_PREFIX + info.looseSignature, now);
            if (strict >= BREAKER_THRESHOLD || loose >= BREAKER_THRESHOLD) {
                prefs.edit().putLong(KEY_THROTTLED_UNTIL, now + THROTTLE_DURATION_MS).apply();
                AppLog.w(TAG, "native crash breaker tripped: strict=" + strict
                        + " (" + info.signature + ") loose=" + loose + " (" + info.looseSignature + ")"
                        + " in 24h → prewarm throttled");
            }
        } catch (Exception e) {
            AppLog.w(TAG, "recordOccurrence failed", e);
        }
    }

    /** 累计某一路签名的 24h 内次数，返回累计后的值（签名只进 key 前缀之后的原文，不参与拆分） */
    private static int bumpSignature(SharedPreferences prefs, String key, long now) throws Exception {
        JSONArray arr = new JSONArray(prefs.getString(key, "[]"));
        JSONArray kept = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            long ts = arr.optLong(i, 0);
            if (now - ts <= BREAKER_WINDOW_MS) kept.put(ts);
        }
        kept.put(now);
        prefs.edit().putString(key, kept.toString()).apply();
        return kept.length();
    }

    /**
     * 清掉窗口外已无记录的签名键。签名串里含 fault addr，崩溃现场每换一次堆地址就多一个键；
     * 不 prune 的话 prefs 会随会话数单调增长，而熔断判定只看 24h 窗口，这些键早就没有任何作用。
     */
    private static void pruneExpiredSignatures(SharedPreferences prefs, long now) {
        try {
            SharedPreferences.Editor editor = null;
            for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                String key = entry.getKey();
                if (!key.startsWith(KEY_SIG_PREFIX) && !key.startsWith(KEY_LOOSE_SIG_PREFIX)) continue;
                try {
                    JSONArray arr = new JSONArray(String.valueOf(entry.getValue()));
                    JSONArray kept = new JSONArray();
                    for (int i = 0; i < arr.length(); i++) {
                        long ts = arr.optLong(i, 0);
                        if (now - ts <= BREAKER_WINDOW_MS) kept.put(ts);
                    }
                    if (kept.length() == 0) {
                        if (editor == null) editor = prefs.edit();
                        editor.remove(key);
                    } else if (kept.length() != arr.length()) {
                        if (editor == null) editor = prefs.edit();
                        editor.putString(key, kept.toString());
                    }
                } catch (Exception ignored) {
                    // 值不是数组（历史脏数据）：直接删掉，别让一条坏键卡住整轮 prune
                    if (editor == null) editor = prefs.edit();
                    editor.remove(key);
                }
            }
            if (editor != null) editor.apply();
        } catch (Exception e) {
            AppLog.w(TAG, "pruneExpiredSignatures failed", e);
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
