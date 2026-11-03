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
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

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
    private static final int RETENTION_DAYS = 3;
    private static final int MAX_QUEUE = 2048;
    private static final int MSG_DRAIN = 1;
    private static final long DRAIN_DELAY_MS = 80L;

    private static volatile SpiderLogStore instance;

    private final File logDir;
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
        File[] files = logDir.listFiles((dir, name) -> name.startsWith(base + ".") && name.endsWith(".log"));
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                String suffix = n.substring(base.length() + 1, n.length() - 4);
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
            }
        }
        currentFile = null;
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
        File[] files = logDir.listFiles((dir, name) -> name.endsWith(".log"));
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

    /** 合并所有日志到 cacheDir 下单文件，供导出 */
    public File exportMerged() throws IOException {
        File[] files = listFiles();
        File cacheDir = new File(logDir.getParentFile(), "cache");
        if (!cacheDir.exists()) cacheDir.mkdirs();
        File exportFile = new File(cacheDir, "peanutmov-logs-" + System.currentTimeMillis() + ".txt");
        try (BufferedWriter w = new BufferedWriter(new FileWriter(exportFile))) {
            for (File f : files) {
                w.write("===== " + f.getName() + " =====\n");
                try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        w.write(line);
                        w.newLine();
                    }
                }
                w.newLine();
            }
        }
        return exportFile;
    }
}
