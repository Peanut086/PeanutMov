package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.Message;
import android.util.Log;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * 爬虫/应用日志本地落盘仓库。
 *
 * 设计要点：
 * - 单例；启动时由 MainApplication.init 初始化，保证 App 生命周期内可用
 * - 单线程写队列（HandlerThread），log() 只入队不阻塞爬虫线程
 * - 按天滚动文件：filesDir/logs/spider-YYYY-MM-DD.log
 * - 单文件 2MB 上限，滚动为 .1/.2/... 后缀
 * - 目录总量 20MB 上限，超限删最旧
 * - 保留 3 天，启动时清理一次
 * - 开关持久化到 SharedPreferences，默认跟随 BuildConfig.DEBUG
 * - 关闭时仍写 W/E，保证崩溃可诊断
 * - 写入前脱敏 URL 中的 token/password/cookie 等
 */
public final class SpiderLogStore {
    private static final String TAG = "SpiderLogStore";
    private static final String PREFS_NAME = "spider_debug_log";
    private static final String KEY_ENABLED = "enabled";
    private static final String LOG_DIR_NAME = "logs";
    private static final long MAX_FILE_BYTES = 2L * 1024 * 1024;
    private static final long MAX_DIR_BYTES = 20L * 1024 * 1024;
    private static final int RETENTION_DAYS = 7;
    private static final int MAX_QUEUE = 2048;
    private static final int MSG_DRAIN = 1;
    private static final long DRAIN_DELAY_MS = 80L;

    private static volatile SpiderLogStore instance;

    private final File logDir;
    /** F3：xCrash 原生 tombstone 目录（导出包内附带原文，避免只有摘要帧拿不到真凶 .so） */
    private final File tombstoneDir;
    private final SharedPreferences prefs;
    private final HandlerThread worker;
    private final Handler workerHandler;
    private final BlockingQueue<String> queue = new ArrayBlockingQueue<>(MAX_QUEUE);
    private final Object fileLock = new Object();
    private final SimpleDateFormat dayFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
    private final SimpleDateFormat tsFmt = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);

    private volatile boolean enabled;
    private String currentDay;
    private File currentFile;
    private BufferedWriter currentWriter;
    private long currentFileBytes;

    public static SpiderLogStore init(Context appContext) {
        if (instance == null) {
            synchronized (SpiderLogStore.class) {
                if (instance == null) {
                    instance = new SpiderLogStore(appContext);
                }
            }
        }
        return instance;
    }

    public static SpiderLogStore get() {
        return instance;
    }

    private SpiderLogStore(Context appContext) {
        this.logDir = new File(appContext.getFilesDir(), LOG_DIR_NAME);
        if (!logDir.exists()) logDir.mkdirs();
        this.tombstoneDir = new File(appContext.getFilesDir(), CrashNative.TOMBSTONE_DIR_NAME);
        this.prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.enabled = prefs.getBoolean(KEY_ENABLED, false);
        this.worker = new HandlerThread("spider-log-writer");
        this.worker.start();
        this.workerHandler = new Handler(worker.getLooper()) {
            @Override
            public void handleMessage(Message msg) {
                try {
                    if (msg.what == MSG_DRAIN) drain();
                } catch (Exception e) {
                    Log.e(TAG, "worker crashed", e);
                }
            }
        };
        cleanExpired();
    }

    public boolean isEnabled() { return enabled; }

    public void setEnabled(boolean value) {
        this.enabled = value;
        prefs.edit().putBoolean(KEY_ENABLED, value).apply();
        Log.i(TAG, "debug log enabled=" + value);
    }

    /** 写入日志。level: D/I/W/E */
    public void log(String level, String tag, String message) {
        boolean isError = "W".equals(level) || "E".equals(level);
        if (!enabled && !isError) return;
        if (message == null) message = "";
        logcat(level, tag, message);
        String line = formatLine(level, tag, message);
        if (!queue.offer(line)) {
            queue.poll();
            queue.offer(line);
        }
        if (!workerHandler.hasMessages(MSG_DRAIN)) {
            workerHandler.sendEmptyMessageDelayed(MSG_DRAIN, DRAIN_DELAY_MS);
        }
    }

    private void logcat(String level, String tag, String message) {
        switch (level) {
            case "D": Log.d(tag, message); break;
            case "I": Log.i(tag, message); break;
            case "W": Log.w(tag, message); break;
            case "E": Log.e(tag, message); break;
            default: Log.d(tag, message);
        }
    }

    private String formatLine(String level, String tag, String message) {
        String ts;
        String day;
        synchronized (tsFmt) {
            Date now = new Date();
            ts = tsFmt.format(now);
            day = dayFmt.format(now);
        }
        String thread = Thread.currentThread().getName();
        String redacted = redact(message);
        return ts + " " + level + " [" + thread + "] " + tag + ": " + redacted + "\n";
    }

    private String redact(String s) {
        if (s == null || s.isEmpty()) return s;
        return s.replaceAll("(?i)(token|password|pwd|authorization|cookie|api_?key)=([^&\\s\"']+)", "$1=***");
    }

    private void drain() {
        synchronized (fileLock) {
            try {
                ensureWriter();
                String line;
                while ((line = queue.poll()) != null) {
                    if (currentWriter == null) {
                        ensureWriter();
                        if (currentWriter == null) break;
                    }
                    currentWriter.write(line);
                    currentFileBytes += line.getBytes().length;
                    if (currentFileBytes >= MAX_FILE_BYTES) {
                        rotateFile();
                        ensureWriter();
                    }
                }
                if (currentWriter != null) currentWriter.flush();
                enforceLimits();
            } catch (IOException e) {
                Log.e(TAG, "drain failed", e);
            }
        }
    }

    private void ensureWriter() throws IOException {
        String today;
        synchronized (dayFmt) { today = dayFmt.format(new Date()); }
        if (currentWriter != null && today.equals(currentDay) && currentFileBytes < MAX_FILE_BYTES) {
            return;
        }
        if (currentWriter != null) {
            try { currentWriter.close(); } catch (IOException ignored) {}
            currentWriter = null;
        }
        currentDay = today;
        currentFile = new File(logDir, "spider-" + today + ".log");
        if (!currentFile.exists()) currentFile.createNewFile();
        currentFileBytes = currentFile.length();
        currentWriter = new BufferedWriter(new FileWriter(currentFile, true));
    }

    private void rotateFile() {
        try {
            if (currentWriter != null) currentWriter.close();
        } catch (IOException ignored) {}
        currentWriter = null;
        String base = "spider-" + currentDay;
        int max = 0;
        File[] files = logDir.listFiles((dir, name) -> name.startsWith(base + ".") && (name.endsWith(".log") || name.endsWith(".log.gz")));
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                // Extract the number suffix: spider-YYYY-MM-DD.N.log or spider-YYYY-MM-DD.N.log.gz
                String withoutExt = n.endsWith(".gz") ? n.substring(0, n.length() - 3) : n;
                // 跳过无编号文件（如当前日志 spider-YYYY-MM-DD.log）
                int numStart = base.length() + 1;
                int numEnd = withoutExt.length() - 4;
                if (numEnd <= numStart) continue;
                String suffix = withoutExt.substring(numStart, numEnd);
                try {
                    int idx = Integer.parseInt(suffix);
                    if (idx > max) max = idx;
                } catch (Exception ignored) {}
            }
        }
        File rotated = new File(logDir, base + "." + (max + 1) + ".log");
        if (currentFile != null && currentFile.exists()) {
            if (!currentFile.renameTo(rotated)) {
                Log.w(TAG, "rotate rename failed: " + currentFile.getName());
            } else {
                // P2-5: 轮转后压缩旧日志，节省存储空间
                compressFile(rotated);
            }
        }
        currentFile = null;
    }

    /** 将文件压缩为 .gz 格式，成功后删除原文件 */
    private void compressFile(File source) {
        File gzFile = new File(source.getParent(), source.getName() + ".gz");
        try (FileInputStream fis = new FileInputStream(source);
             GZIPOutputStream gzos = new GZIPOutputStream(new FileOutputStream(gzFile))) {
            byte[] buffer = new byte[8192];
            int len;
            while ((len = fis.read(buffer)) != -1) {
                gzos.write(buffer, 0, len);
            }
            gzos.finish();
            source.delete();
            Log.d(TAG, "compressed " + source.getName() + " -> " + gzFile.getName());
        } catch (IOException e) {
            Log.w(TAG, "compress failed: " + e.getMessage());
            if (gzFile.exists()) gzFile.delete();
        }
    }

    private void enforceLimits() {
        File[] files = logDir.listFiles();
        if (files == null || files.length == 0) return;
        long total = 0;
        for (File f : files) total += f.length();
        while (total > MAX_DIR_BYTES && files.length > 1) {
            File oldest = null;
            for (File f : files) {
                if (oldest == null || f.lastModified() < oldest.lastModified()) oldest = f;
            }
            if (oldest == null) break;
            total -= oldest.length();
            oldest.delete();
            files = logDir.listFiles();
        }
    }

    public void cleanExpired() {
        long cutoff = System.currentTimeMillis() - RETENTION_DAYS * 24L * 60 * 60 * 1000;
        File[] files = logDir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.lastModified() < cutoff) f.delete();
        }
    }

    /** 兼容旧 cleanOldLogs 语义：清理 1 天前 */
    public CleanResult cleanOldLogs() {
        long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        File[] files = logDir.listFiles();
        if (files == null) return new CleanResult(0, 0);
        int count = 0;
        long freedBytes = 0;
        for (File f : files) {
            if (f.lastModified() < cutoff) {
                long size = f.length();
                if (f.delete()) {
                    count++;
                    freedBytes += size;
                }
            }
        }
        return new CleanResult(count, freedBytes);
    }

    public static final class CleanResult {
        public final int cleanedCount;
        public final long freedBytes;
        public CleanResult(int cleanedCount, long freedBytes) {
            this.cleanedCount = cleanedCount;
            this.freedBytes = freedBytes;
        }
    }

    public File[] listFiles() {
        File[] files = logDir.listFiles((dir, name) -> name.endsWith(".log") || name.endsWith(".log.gz"));
        if (files == null) return new File[0];
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        return files;
    }

    public File getLogDir() { return logDir; }

    public long totalBytes() {
        File[] files = listFiles();
        long total = 0;
        for (File f : files) total += f.length();
        return total;
    }

    /** 同步刷盘：查看页读文件前调用，避免 80ms 批缓冲延迟 */
    public void flushNow() {
        workerHandler.removeMessages(MSG_DRAIN);
        synchronized (fileLock) {
            drain();
        }
    }

    /** 清空全部日志文件 */
    public void clearAll() {
        synchronized (fileLock) {
            if (currentWriter != null) {
                try { currentWriter.close(); } catch (IOException ignored) {}
                currentWriter = null;
            }
            queue.clear();
            File[] files = logDir.listFiles();
            if (files != null) {
                for (File f : files) f.delete();
            }
            currentFile = null;
            currentFileBytes = 0;
        }
    }

    /**
     * 批量写入 JS 侧日志。
     *
     * @param entries 每条 {level, tag, message, ts}；ts 为客户端时间戳（毫秒），
     *                为 0 时使用服务端当前时间
     * @param source  来源标识，如 "JS"；会拼到 tag 前（`JS:tag`）
     */
    public void appendBatch(List<Map<String, Object>> entries, String source) {
        if (entries == null) return;
        for (Map<String, Object> e : entries) {
            if (e == null) continue;
            String level = String.valueOf(e.getOrDefault("level", "D"));
            String tag = String.valueOf(e.getOrDefault("tag", "app"));
            String message = String.valueOf(e.getOrDefault("message", ""));
            long ts = 0;
            Object tsObj = e.get("ts");
            if (tsObj instanceof Number) ts = ((Number) tsObj).longValue();
            if (source != null && !source.isEmpty()) {
                tag = source + ":" + tag;
            }
            message = message.replace("\n", "\\n").replace("\r", "\\r");
            if (!level.equals("D") && !level.equals("I")
                    && !level.equals("W") && !level.equals("E")) {
                level = "D";
            }
            logWithTs(level, tag, message, ts);
        }
    }

    /** 写入带客户端时间戳的日志（供 appendBatch 使用） */
    private void logWithTs(String level, String tag, String message, long clientTs) {
        boolean isError = "W".equals(level) || "E".equals(level);
        if (!enabled && !isError) return;
        logcat(level, tag, message);
        String line = formatLineWithTs(level, tag, message, clientTs);
        if (!queue.offer(line)) {
            queue.poll();
            queue.offer(line);
        }
        if (!workerHandler.hasMessages(MSG_DRAIN)) {
            workerHandler.sendEmptyMessageDelayed(MSG_DRAIN, DRAIN_DELAY_MS);
        }
    }

    private String formatLineWithTs(String level, String tag, String message, long clientTs) {
        String ts;
        String day;
        synchronized (tsFmt) {
            Date d = clientTs > 0 ? new Date(clientTs) : new Date();
            ts = tsFmt.format(d);
            day = dayFmt.format(d);
        }
        String thread = Thread.currentThread().getName();
        return ts + " " + level + " [" + thread + "] " + tag + ": " + message + "\n";
    }

    /**
     * 增量读取日志文件尾部。
     *
     * @param fileName 指定文件名；null 表示最新文件
     * @param offset   已读字节偏移；为 0 或负数表示从尾部读
     * @param maxBytes 单次最大读取字节数
     * @return {file, size, offset, text, reset}；reset=true 表示文件已滚动/换天，客户端应清空
     */
    public TailResult readTail(String fileName, long offset, int maxBytes) throws IOException {
        flushNow();
        File[] files = listFiles();
        if (files.length == 0) {
            return new TailResult("", 0, 0, "", true);
        }
        File target;
        if (fileName != null && !fileName.isEmpty()) {
            target = new File(logDir, fileName);
            if (!target.exists()) {
                target = files[files.length - 1];
            }
        } else {
            target = files[files.length - 1];
        }
        
        // P2-5: 压缩文件不支持偏移读取，直接解压返回全部内容
        if (target.getName().endsWith(".gz")) {
            return readCompressedFile(target, maxBytes);
        }
        
        long size = target.length();
        boolean reset = offset > size;
        long start;
        if (reset || offset <= 0) {
            start = Math.max(0, size - maxBytes);
        } else {
            start = offset;
        }
        String text;
        long endOffset;
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(target, "r")) {
            raf.seek(start);
            // 跳过首行残行（非首次读时）
            if (start > 0 && offset <= 0) {
                raf.readLine();
                start = raf.getFilePointer();
            }
            byte[] buf = new byte[(int) Math.min(maxBytes, size - start)];
            int read = raf.read(buf);
            if (read <= 0) {
                text = "";
                endOffset = start;
            } else {
                String raw = new String(buf, 0, read, "UTF-8");
                int lastNl = raw.lastIndexOf('\n');
                if (lastNl < 0) {
                    text = "";
                    endOffset = start;
                } else {
                    text = raw.substring(0, lastNl + 1);
                    endOffset = start + lastNl + 1;
                }
            }
        }
        return new TailResult(target.getName(), size, endOffset, text, reset);
    }
    
    /** 读取压缩日志文件：解压后返回全部内容（历史日志不支持增量读取） */
    private TailResult readCompressedFile(File gzFile, int maxBytes) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (GZIPInputStream gis = new GZIPInputStream(new FileInputStream(gzFile));
             BufferedReader reader = new BufferedReader(new java.io.InputStreamReader(gis, "UTF-8"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
                if (sb.length() > maxBytes) {
                    // 超限截断，保留最后 maxBytes 字节
                    sb.delete(0, sb.length() - maxBytes);
                }
            }
        }
        String text = sb.toString();
        return new TailResult(gzFile.getName(), gzFile.length(), text.length(), text, false);
    }

    public static final class TailResult {
        public final String file;
        public final long size;
        public final long offset;
        public final String text;
        public final boolean reset;
        public TailResult(String file, long size, long offset, String text, boolean reset) {
            this.file = file;
            this.size = size;
            this.offset = offset;
            this.text = text;
            this.reset = reset;
        }
    }

    /** 合并所有日志到 cacheDir 下单文件，供导出 */
    public File exportMerged() throws IOException {
        File[] files = listFiles();
        File cacheDir = new File(logDir.getParentFile(), "cache");
        if (!cacheDir.exists()) cacheDir.mkdirs();
        File exportFile = new File(cacheDir, "peanutmov-logs-" + System.currentTimeMillis() + ".txt");
        try (BufferedWriter w = new BufferedWriter(new FileWriter(exportFile))) {
            for (File f : files) {
                w.write("===== " + f.getName() + " =====\n");
                // P2-5: 支持读取压缩日志
                if (f.getName().endsWith(".gz")) {
                    try (GZIPInputStream gis = new GZIPInputStream(new FileInputStream(f));
                         BufferedReader r = new BufferedReader(new java.io.InputStreamReader(gis, "UTF-8"))) {
                        String line;
                        while ((line = r.readLine()) != null) {
                            w.write(line);
                            w.newLine();
                        }
                    }
                } else {
                    try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                        String line;
                        while ((line = r.readLine()) != null) {
                            w.write(line);
                            w.newLine();
                        }
                    }
                }
                w.newLine();
            }
            // F3：原始 tombstone 全文入包。AppLog 里的摘要只有 top-N 帧与寄存器片段，
            // 归因第三方 jar 的原生真凶必须看完整 backtrace / memory map，导出必须带上。
            appendTombstones(w);
        }
        return exportFile;
    }

    /** F3：导出包追加最近的原生 tombstone 原文（单文件截断，总量封顶，避免撑爆分享） */
    private static final int TOMBSTONE_MAX_FILES = 8;
    private static final int TOMBSTONE_MAX_BYTES_PER_FILE = 256 * 1024;

    private void appendTombstones(BufferedWriter w) throws IOException {
        if (tombstoneDir == null || !tombstoneDir.isDirectory()) return;
        File[] stones = tombstoneDir.listFiles(
                (dir, name) -> name.contains(".tombstone") || name.endsWith(".log"));
        if (stones == null || stones.length == 0) return;
        Arrays.sort(stones, Comparator.comparingLong(File::lastModified).reversed());
        int limit = Math.min(TOMBSTONE_MAX_FILES, stones.length);
        for (int i = 0; i < limit; i++) {
            File f = stones[i];
            w.write("===== tombstone " + f.getName() + " =====\n");
            try (BufferedReader r = new BufferedReader(
                    new java.io.InputStreamReader(new FileInputStream(f), "UTF-8"))) {
                char[] buf = new char[8192];
                int written = 0;
                int read;
                while (written < TOMBSTONE_MAX_BYTES_PER_FILE && (read = r.read(buf)) > 0) {
                    w.write(buf, 0, read);
                    written += read;
                }
                if (written >= TOMBSTONE_MAX_BYTES_PER_FILE) {
                    w.write("\n... [truncated]\n");
                }
            } catch (IOException e) {
                try {
                    w.write("[read failed: " + e.getMessage() + "]\n");
                } catch (IOException ignored) {
                }
            }
            w.newLine();
        }
    }
}
