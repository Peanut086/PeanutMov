package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * REV-24 / B1：崩溃哨兵（per-invocation token 版）
 *
 * 每次高危操作（spider jar 加载、ExoPlayer 播放等）写一个独立的哨兵文件，正常结束后清除。
 * 若应用异常退出（native crash / ANR / 系统强杀），下次启动时发现哨兵未清除，即可判定上次
 * 操作导致崩溃，并据此进行隔离（quarantine）。
 *
 * 哨兵目录：filesDir/crash-sentinel/
 * 文件名格式：<startedAt>-<seq>-t<tid>.json
 * 隔离名单：SharedPreferences quarantine (key=signature, value=timestamp)
 */
public class CrashSentinel {
    private static final String TAG = "CrashSentinel";
    private static final String SENTINEL_DIR_NAME = "crash-sentinel";
    private static final String LEGACY_SENTINEL_FILE = "crash-sentinel.json";
    private static final String PREFS_NAME = "crash-sentinel-prefs";
    private static final String KEY_QUARANTINE = "quarantine";
    private static final String KEY_CRASH_HISTORY = "crash_history";
    private static final long QUARANTINE_DURATION_MS = 7 * 24 * 60 * 60 * 1000L; // 7 天

    private static File sentinelDir;
    private static final AtomicLong seq = new AtomicLong(0);

    /**
     * 初始化哨兵目录（Application.onCreate 调用）
     */
    public static void init(Context context) {
        sentinelDir = new File(context.getFilesDir(), SENTINEL_DIR_NAME);
        if (!sentinelDir.exists()) {
            if (!sentinelDir.mkdirs()) {
                Log.w(TAG, "failed to create sentinel dir: " + sentinelDir);
            }
        }

        // 迁移旧版单文件哨兵（一次性）
        File legacy = new File(context.getFilesDir(), LEGACY_SENTINEL_FILE);
        if (legacy.exists()) {
            try {
                String content = new String(Files.readAllBytes(legacy.toPath()));
                JSONObject obj = new JSONObject(content);
                long ts = obj.optLong("timestamp", System.currentTimeMillis());
                obj.put("startedAt", ts);
                obj.put("legacy", true);
                String name = ts + "-00000-t0.json";
                File target = new File(sentinelDir, name);
                try (FileWriter w = new FileWriter(target)) {
                    w.write(obj.toString());
                }
                legacy.delete();
                Log.i(TAG, "migrated legacy sentinel to " + name);
            } catch (Exception e) {
                Log.w(TAG, "legacy migration failed", e);
            }
        }
    }

    /**
     * 写入哨兵（进入高危操作前调用）
     *
     * @param action   操作类型（spider.invoke / spider.load / exoplayer 等）
     * @param details  附加信息（JSON 对象，如 jarMd5, api, method, url 等）
     * @return token（文件名），用于后续 end() 清除；失败返回 null
     */
    public static String begin(String action, JSONObject details) {
        if (sentinelDir == null) {
            Log.w(TAG, "sentinel not initialized");
            return null;
        }
        try {
            long startedAt = System.currentTimeMillis();
            long s = seq.incrementAndGet();
            long tid = Thread.currentThread().getId();
            String name = startedAt + "-" + String.format("%05d", s) + "-t" + tid + ".json";
            File tmp = new File(sentinelDir, name + ".tmp");
            File finalFile = new File(sentinelDir, name);

            JSONObject sentinel = new JSONObject();
            sentinel.put("action", action);
            sentinel.put("startedAt", startedAt);
            sentinel.put("threadName", Thread.currentThread().getName());
            sentinel.put("threadId", tid);
            sentinel.put("pid", android.os.Process.myPid());
            if (details != null) {
                Iterator<String> keys = details.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    sentinel.put(key, details.get(key));
                }
            }

            try (FileWriter writer = new FileWriter(tmp)) {
                writer.write(sentinel.toString());
            }
            if (!tmp.renameTo(finalFile)) {
                Log.w(TAG, "rename failed: " + tmp + " -> " + finalFile);
                tmp.delete();
                return null;
            }
            return name;
        } catch (Exception e) {
            Log.w(TAG, "failed to write sentinel", e);
            return null;
        }
    }

    /**
     * 清除哨兵（操作正常结束后调用）
     *
     * @param token begin() 返回的 token
     */
    public static void end(String token) {
        if (sentinelDir == null || token == null) return;
        try {
            File f = new File(sentinelDir, token);
            if (f.exists()) {
                if (!f.delete()) {
                    Log.w(TAG, "failed to delete sentinel: " + f);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to clear sentinel", e);
        }
    }

    /**
     * 读取所有未清除的哨兵（应用启动时调用）
     *
     * @return 按 startedAt 倒序排列的哨兵列表
     */
    public static List<JSONObject> readUnclearedAll() {
        if (sentinelDir == null || !sentinelDir.exists()) return Collections.emptyList();

        List<JSONObject> result = new ArrayList<>();

        File[] files = sentinelDir.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return result;

        for (File f : files) {
            try {
                String content = new String(Files.readAllBytes(f.toPath()));
                result.add(new JSONObject(content));
            } catch (Exception e) {
                Log.w(TAG, "failed to read sentinel " + f.getName(), e);
            }
        }

        result.sort((a, b) -> {
            try {
                return Long.compare(b.getLong("startedAt"), a.getLong("startedAt"));
            } catch (Exception e) {
                return 0;
            }
        });
        return result;
    }

    /**
     * 清除所有哨兵文件
     */
    public static void clearAll() {
        if (sentinelDir == null || !sentinelDir.exists()) return;
        File[] files = sentinelDir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (!f.delete()) {
                    Log.w(TAG, "failed to delete: " + f);
                }
            }
        }
    }

    /**
     * 清理超过指定年龄的哨兵（防止看门狗超时后挂死线程遗留）
     *
     * @param maxAgeMs 最大年龄（毫秒）
     */
    public static void sweepStale(long maxAgeMs) {
        if (sentinelDir == null || !sentinelDir.exists()) return;
        long now = System.currentTimeMillis();
        File[] files = sentinelDir.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return;
        for (File f : files) {
            if (now - f.lastModified() > maxAgeMs) {
                if (!f.delete()) {
                    Log.w(TAG, "failed to sweep stale: " + f);
                }
            }
        }
    }

    /**
     * 记录一次异常退出（发现未清除哨兵时调用）
     *
     * @param context  上下文
     * @param sentinel 未清除的哨兵
     */
    public static void recordCrash(Context context, JSONObject sentinel) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String historyJson = prefs.getString(KEY_CRASH_HISTORY, "[]");
            org.json.JSONArray history = new org.json.JSONArray(historyJson);

            JSONObject entry = new JSONObject();
            entry.put("sentinel", sentinel);
            entry.put("recordedAt", System.currentTimeMillis());
            history.put(entry);

            // 只保留最近 20 条
            while (history.length() > 20) {
                history.remove(0);
            }

            prefs.edit().putString(KEY_CRASH_HISTORY, history.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "failed to record crash", e);
        }
    }

    /**
     * 将某个签名加入隔离名单
     *
     * @param context   上下文
     * @param signature 隔离签名（如 spider:<jarMd5>:<api>）
     */
    public static synchronized void quarantine(Context context, String signature) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String quarantineJson = prefs.getString(KEY_QUARANTINE, "{}");
            JSONObject quarantine = new JSONObject(quarantineJson);
            quarantine.put(signature, System.currentTimeMillis());
            prefs.edit().putString(KEY_QUARANTINE, quarantine.toString()).apply();
            Log.i(TAG, "quarantined: " + signature);
        } catch (Exception e) {
            Log.w(TAG, "failed to quarantine", e);
        }
    }

    /**
     * 检查某个签名是否在隔离名单中（且未过期）
     *
     * @param context   上下文
     * @param signature 隔离签名
     * @return true 表示已隔离，应拒绝执行
     */
    public static synchronized boolean isQuarantined(Context context, String signature) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String quarantineJson = prefs.getString(KEY_QUARANTINE, "{}");
            JSONObject quarantine = new JSONObject(quarantineJson);
            if (!quarantine.has(signature)) return false;
            long timestamp = quarantine.getLong(signature);
            if (System.currentTimeMillis() - timestamp > QUARANTINE_DURATION_MS) {
                quarantine.remove(signature);
                prefs.edit().putString(KEY_QUARANTINE, quarantine.toString()).apply();
                return false;
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "failed to check quarantine", e);
            return false;
        }
    }

    /**
     * 解除某个签名的隔离
     */
    public static synchronized void unquarantine(Context context, String signature) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String quarantineJson = prefs.getString(KEY_QUARANTINE, "{}");
            JSONObject quarantine = new JSONObject(quarantineJson);
            quarantine.remove(signature);
            prefs.edit().putString(KEY_QUARANTINE, quarantine.toString()).apply();
            Log.i(TAG, "unquarantined: " + signature);
        } catch (Exception e) {
            Log.w(TAG, "failed to unquarantine", e);
        }
    }

    /**
     * 获取所有隔离签名（供设置页展示）
     */
    public static synchronized List<String> getQuarantined(Context context) {
        List<String> result = new ArrayList<>();
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String quarantineJson = prefs.getString(KEY_QUARANTINE, "{}");
            JSONObject quarantine = new JSONObject(quarantineJson);
            Iterator<String> keys = quarantine.keys();
            long now = System.currentTimeMillis();
            while (keys.hasNext()) {
                String key = keys.next();
                long timestamp = quarantine.getLong(key);
                if (now - timestamp <= QUARANTINE_DURATION_MS) {
                    result.add(key);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to get quarantined", e);
        }
        return result;
    }

    /**
     * 获取崩溃历史（供诊断页展示）
     */
    public static org.json.JSONArray getCrashHistory(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String historyJson = prefs.getString(KEY_CRASH_HISTORY, "[]");
            return new org.json.JSONArray(historyJson);
        } catch (Exception e) {
            Log.w(TAG, "failed to get crash history", e);
            return new org.json.JSONArray();
        }
    }

    /**
     * 清空崩溃历史
     */
    public static void clearCrashHistory(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_CRASH_HISTORY, "[]").apply();
        } catch (Exception e) {
            Log.w(TAG, "failed to clear crash history", e);
        }
    }
}
