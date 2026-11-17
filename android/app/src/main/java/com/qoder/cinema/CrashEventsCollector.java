package com.qoder.cinema;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * 崩溃/退出事件中心（日志页「崩溃」tab 的数据源）。
 *
 * 三路来源合并去重：
 * - xCrash tombstones（files/tombstones，native/java 全文）
 * - java-crash.log 环形栈（crash-stacks，最近 5 条 Java FATAL）
 * - ApplicationExitInfo（API 30+，系统侧退出原因）
 *
 * 同一次崩溃会同时留下多路记录（相差秒级），按「高优先级先占位、低优先级向最近邻归并」
 * 去重：tombstone(3) > 环形栈(2) > 系统退出记录(1)。归并窗口 10s——再宽就会把连续闪退
 * （启动即崩的 crash loop，两次崩仅差几秒）误并成一条。
 */
public final class CrashEventsCollector {
    private static final String TAG = "CrashEvents";

    private static final long PAIR_WINDOW_MS = 10_000L;
    private static final int MAX_EVENTS = 64;
    private static final int MAX_FULL_CHARS = 512 * 1024;

    private static final String RING_DIR_NAME = "crash-stacks";
    private static final String RING_NAME = "java-crash.log";
    private static final String RING_MARK = "===== java crash ";
    private static final String LOG_DIR_NAME = "logs";
    private static final String CACHE_DIR_NAME = "cache";

    private static final Pattern LOG_HEAD_RE = Pattern.compile(
            "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}) ([DIWEF]) \\[([^\\]]+)\\] ([^:]+): (.*)$");
    private static final SimpleDateFormat TS_FMT = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);

    private CrashEventsCollector() {}

    /** 事件条目（同包 SpiderPlugin 直接读字段序列化） */
    public static final class Event {
        public String id;
        /** native / java / anr / killed / lomem / exit */
        public String kind;
        public long ts;
        /** tombstone=3 > 环形栈=2 > 退出记录=1；归并时低者并入高者 */
        public int priority;
        public String source;
        public String title;
        public String detail;
        final StringBuilder full = new StringBuilder();

        String fullText() {
            return full.toString();
        }
    }

    /** 轻量列表（不读全文），崩溃 tab 卡片用 */
    public static List<Event> collect(Context ctx) {
        return collect(ctx, false);
    }

    /** withFull=true 时带全文（详情抽屉 / 单事件导出用） */
    public static List<Event> collect(Context ctx, boolean withFull) {
        List<Event> all = new ArrayList<>();
        try {
            collectTombstones(ctx, all, withFull);
        } catch (Exception e) {
            AppLog.w(TAG, "collect tombstones failed", e);
        }
        try {
            collectRing(ctx, all, withFull);
        } catch (Exception e) {
            AppLog.w(TAG, "collect ring failed", e);
        }
        try {
            collectExitInfos(ctx, all, withFull);
        } catch (Exception e) {
            AppLog.w(TAG, "collect exit infos failed", e);
        }
        return mergeAndCap(all);
    }

    /** 按 id 取单条全文；找不到返回 null */
    public static Event findDetail(Context ctx, String id) {
        if (id == null || id.isEmpty()) return null;
        for (Event e : collect(ctx, true)) {
            if (id.equals(e.id)) return e;
        }
        return null;
    }

    /**
     * 单事件导出：事件全文 + 崩溃时刻 ±windowMinutes 的日志上下文切片，合成一个分享文件。
     */
    public static File export(Context ctx, String id, int windowMinutes) throws IOException {
        Event target = findDetail(ctx, id);
        if (target == null) throw new IOException("event not found: " + id);
        File cacheDir = new File(ctx.getFilesDir(), CACHE_DIR_NAME);
        if (!cacheDir.exists()) cacheDir.mkdirs();
        File out = new File(cacheDir, "peanutmov-crash-"
                + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".txt");
        try (BufferedWriter w = new BufferedWriter(new FileWriter(out))) {
            w.write("===== PeanutMov crash evidence =====\n");
            w.write("event: ").write(target.id).write("\n");
            w.write("kind: ").write(target.kind).write("\n");
            w.write("time: ").write(fmtTime(target.ts)).write("\n\n");
            w.write(target.fullText());
            w.write("\n\n===== log context (±").write(String.valueOf(windowMinutes)).write(" min) =====\n");
            appendLogContext(w, ctx, target.ts, windowMinutes * 60_000L);
        }
        return out;
    }

    // ---------------------------------------------------------------- 来源 1：tombstones

    private static void collectTombstones(Context ctx, List<Event> out, boolean withFull) {
        File dir = new File(ctx.getFilesDir(), CrashNative.TOMBSTONE_DIR_NAME);
        File[] files = dir.listFiles(
                (d, name) -> name.endsWith(".xcrash") || name.contains("tombstone"));
        if (files == null || files.length == 0) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        for (File f : files) {
            Map<String, String> parsed = null;
            try {
                parsed = xcrash.TombstoneParser.parse(f);
            } catch (Exception ignored) {
            }
            if (parsed == null) parsed = new java.util.HashMap<>();
            boolean isJava = f.getName().contains(".java.xcrash");
            Event e = new Event();
            e.kind = isJava ? "java" : "native";
            e.priority = 3;
            e.source = "xCrash tombstone";
            e.ts = crashTimeMs(parsed, f.lastModified());
            e.id = "tombstone|" + f.getName();
            e.title = isJava ? javaTitle(parsed, f.getName()) : nativeTitle(parsed);
            e.detail = (isJava ? "xCrash Java tombstone" : "xCrash native tombstone")
                    + " · " + fmtTime(e.ts);
            if (withFull) {
                try {
                    e.full.append(readCapped(f, MAX_FULL_CHARS));
                } catch (IOException ex) {
                    e.full.append("[read failed: ").append(ex.getMessage()).append("]");
                }
            }
            out.add(e);
        }
    }

    private static String nativeTitle(Map<String, String> parsed) {
        StringBuilder sb = new StringBuilder("Native ");
        String signal = orEmpty(parsed.get(xcrash.TombstoneParser.keySignal));
        sb.append(signal.isEmpty() ? "?" : signal);
        String thread = orEmpty(parsed.get(xcrash.TombstoneParser.keyThreadName));
        if (!thread.isEmpty()) sb.append(" · ").append(thread);
        String fault = orEmpty(parsed.get(xcrash.TombstoneParser.keyFaultAddr));
        if (!fault.isEmpty()) sb.append(" · fault ").append(fault);
        return sb.toString();
    }

    private static String javaTitle(Map<String, String> parsed, String filename) {
        String stack = orEmpty(parsed.get(xcrash.TombstoneParser.keyJavaStacktrace));
        for (String line : stack.split("\n")) {
            String t = line.trim();
            if (!t.isEmpty()) return truncate(t, 120);
        }
        return truncate(filename, 120);
    }

    // ---------------------------------------------------------------- 来源 2：java-crash 环形栈

    private static void collectRing(Context ctx, List<Event> out, boolean withFull) {
        File f = new File(new File(ctx.getFilesDir(), RING_DIR_NAME), RING_NAME);
        String content = readWhole(f);
        if (content.isEmpty()) return;
        int idx = content.indexOf(RING_MARK);
        while (idx >= 0) {
            int next = content.indexOf(RING_MARK, idx + RING_MARK.length());
            String block = next >= 0 ? content.substring(idx, next) : content.substring(idx);
            Event e = ringEvent(block, withFull);
            if (e != null) out.add(e);
            idx = next;
        }
    }

    private static Event ringEvent(String block, boolean withFull) {
        // 块首行形如 `===== java crash 2026-11-17 14:23:45.123 E [main] CrashHandler: FATAL ...`
        Matcher m = LOG_HEAD_RE.matcher(block);
        if (!m.find()) return null;
        long ts = parseLogTs(m.group(1));
        if (ts < 0) return null;
        Event e = new Event();
        e.kind = "java";
        e.priority = 2;
        e.source = "java-crash 环形栈";
        e.ts = ts;
        e.id = "ring|" + m.group(1);
        String msg = m.group(5);
        e.title = truncate(msg == null || msg.isEmpty() ? "Java FATAL" : msg, 120);
        e.detail = "Java 崩溃栈（环形保留 5 条） · " + fmtTime(ts);
        if (withFull) e.full.append(block);
        return e;
    }

    // ---------------------------------------------------------------- 来源 3：ApplicationExitInfo

    private static void collectExitInfos(Context ctx, List<Event> out, boolean withFull) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return;
        List<ApplicationExitInfo> infos =
                am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 32);
        if (infos == null) return;
        for (ApplicationExitInfo info : infos) {
            int reason = info.getReason();
            int status = info.getStatus();
            String desc = info.getDescription();
            Event e = new Event();
            e.kind = kindOf(reason, status);
            e.priority = 1;
            e.source = "ApplicationExitInfo";
            e.ts = info.getTimestamp();
            e.id = "exit|" + e.ts + "|" + info.getPid() + "|" + reason;
            StringBuilder title = new StringBuilder(ExitAttribution.reasonName(reason));
            if ("native".equals(e.kind)) title.append(" signal=").append(status);
            title.append(" · ").append(ExitAttribution.importanceName(info.getImportance()));
            if (desc != null && !desc.isEmpty()) title.append(" · ").append(truncate(desc, 80));
            e.title = title.toString();
            e.detail = "系统退出记录 · " + fmtTime(e.ts);
            if (withFull) {
                e.full.append("reason=").append(reason).append(' ')
                        .append(ExitAttribution.reasonName(reason)).append('\n')
                        .append("status=").append(status).append('\n')
                        .append("pid=").append(info.getPid()).append('\n')
                        .append("importance=").append(info.getImportance()).append(' ')
                        .append(ExitAttribution.importanceName(info.getImportance())).append('\n')
                        .append("pss=").append(info.getPss() / (1024L * 1024L)).append("MB\n")
                        .append("time=").append(fmtTime(e.ts)).append('\n')
                        .append("process=").append(info.getProcessName()).append('\n')
                        .append("description=").append(desc == null ? "" : desc);
            }
            out.add(e);
        }
    }

    private static String kindOf(int reason, int status) {
        switch (reason) {
            case ApplicationExitInfo.REASON_CRASH:
                return "java";
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "native";
            case ApplicationExitInfo.REASON_ANR:
                return "anr";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "lomem";
            case ApplicationExitInfo.REASON_SIGNALED:
                // SIGKILL/SIGTERM 是外部终止，SIGSEGV/SIGABRT 等才是进程自己倒下
                return ExitAttribution.isCrashSignal(status) ? "native" : "killed";
            default:
                return "exit";
        }
    }

    // ---------------------------------------------------------------- 归并与工具

    private static List<Event> mergeAndCap(List<Event> all) {
        // 高优先级先占位，低优先级向时间最近邻的同族事件归并
        all.sort((a, b) -> {
            int byP = Integer.compare(b.priority, a.priority);
            return byP != 0 ? byP : Long.compare(b.ts, a.ts);
        });
        List<Event> accepted = new ArrayList<>();
        for (Event e : all) {
            Event host = null;
            if (isFamily(e)) {
                long best = Long.MAX_VALUE;
                for (Event a : accepted) {
                    if (!isFamily(a)) continue;
                    long d = Math.abs(a.ts - e.ts);
                    if (d <= PAIR_WINDOW_MS && d < best) {
                        best = d;
                        host = a;
                    }
                }
            }
            if (host == null) {
                accepted.add(e);
            } else {
                host.full.append("\n\n===== ").append(e.source).append(" =====\n").append(e.full);
            }
        }
        accepted.sort((a, b) -> Long.compare(b.ts, a.ts));
        if (accepted.size() > MAX_EVENTS) {
            accepted = new ArrayList<>(accepted.subList(0, MAX_EVENTS));
        }
        return accepted;
    }

    private static boolean isFamily(Event e) {
        return "native".equals(e.kind) || "java".equals(e.kind);
    }

    /** xCrash 的 Crash time 兼容 epoch 毫秒 / 本地时间串 / ISO 三种形态，读不出退回文件 mtime */
    private static long crashTimeMs(Map<String, String> parsed, long fallback) {
        String t = orEmpty(parsed.get(xcrash.TombstoneParser.keyCrashTime)).trim();
        if (!t.isEmpty()) {
            if (t.matches("\\d{12,}")) {
                try {
                    return Long.parseLong(t);
                } catch (Exception ignored) {
                }
            }
            String norm = t.replace('T', ' ');
            String head = norm.substring(0, Math.min(23, norm.length()));
            try {
                Date d = TS_FMT.parse(head);
                if (d != null) return d.getTime();
            } catch (Exception ignored) {
            }
            try {
                return java.time.OffsetDateTime.parse(t).toInstant().toEpochMilli();
            } catch (Exception ignored) {
            }
        }
        return fallback;
    }

    /**
     * 日志上下文切片：扫描 spider-*.log / .gz，保留事件时刻 ±window 内的行
     * （无时间戳的续行跟随其宿主行）。只扫文件名日期在事件 ±1 天内的文件。
     */
    private static void appendLogContext(BufferedWriter w, Context ctx, long eventTs, long windowMs)
            throws IOException {
        File dir = new File(ctx.getFilesDir(), LOG_DIR_NAME);
        File[] files = dir.listFiles();
        if (files == null) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        long dayStart = dayFloor(eventTs);
        for (File f : files) {
            if (!withinOneDay(f.getName(), dayStart)) continue;
            boolean inCtx = false;
            try (BufferedReader r = openText(f)) {
                String line;
                while ((line = r.readLine()) != null) {
                    Matcher m = LOG_HEAD_RE.matcher(line);
                    if (m.matches()) {
                        long ts = parseLogTs(m.group(1));
                        inCtx = ts >= 0 && Math.abs(ts - eventTs) <= windowMs;
                    }
                    if (inCtx) {
                        w.write(line);
                        w.newLine();
                    }
                }
            } catch (Exception e) {
                AppLog.w(TAG, "log context read failed: " + f.getName(), e);
            }
        }
    }

    /** 文件名形如 spider-2026-11-17.log / .1.log.gz，取日期段与事件日比较 */
    private static boolean withinOneDay(String filename, long dayStart) {
        if (!filename.startsWith("spider-")) return false;
        int s = "spider-".length();
        if (filename.length() < s + 10) return false;
        String day = filename.substring(s, s + 10);
        try {
            Date d = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(day);
            if (d == null) return false;
            long diff = Math.abs(dayFloor(d.getTime()) - dayStart);
            return diff <= 24L * 60 * 60 * 1000;
        } catch (Exception e) {
            return false;
        }
    }

    private static long dayFloor(long ts) {
        java.util.Calendar c = java.util.Calendar.getInstance();
        c.setTimeInMillis(ts);
        c.set(java.util.Calendar.HOUR_OF_DAY, 0);
        c.set(java.util.Calendar.MINUTE, 0);
        c.set(java.util.Calendar.SECOND, 0);
        c.set(java.util.Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    private static BufferedReader openText(File f) throws IOException {
        if (f.getName().endsWith(".gz")) {
            return new BufferedReader(new InputStreamReader(
                    new GZIPInputStream(new FileInputStream(f)), "UTF-8"));
        }
        return new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"));
    }

    private static long parseLogTs(String ts) {
        try {
            Date d = TS_FMT.parse(ts);
            return d == null ? -1 : d.getTime();
        } catch (Exception e) {
            return -1;
        }
    }

    private static String readWhole(File f) {
        if (f == null || !f.isFile()) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
        } catch (Exception e) {
            AppLog.w(TAG, "read failed: " + f.getName(), e);
            return "";
        }
        return sb.toString();
    }

    private static String readCapped(File f, int maxChars) throws IOException {
        StringBuilder sb = new StringBuilder(64 * 1024);
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(f), "UTF-8"))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0 && sb.length() < maxChars) {
                sb.append(buf, 0, n);
            }
        }
        if (sb.length() >= maxChars) sb.append("\n... [truncated]");
        return sb.toString();
    }

    public static String fmtTime(long ts) {
        return TS_FMT.format(new Date(ts));
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s.trim();
    }
}
