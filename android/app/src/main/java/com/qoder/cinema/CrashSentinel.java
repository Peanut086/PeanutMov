package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.nio.file.Files;
import java.util.Iterator;

/**
 * REV-24：崩溃哨兵
 *
 * 在进入高危操作（spider jar 加载、ExoPlayer 播放、下载服务启动）前写一条"我在做什么"，
 * 正常结束后清除。若应用异常退出（native crash / ANR / 系统强杀），下次启动时发现哨兵未清除，
 * 即可判定上次操作导致崩溃，并据此进行隔离（quarantine）。
 *
 * 哨兵文件：`filesDir/crash-sentinel.json`
 * 隔离名单：SharedPreferences `quarantine` (key=signature, value=timestamp)
 */
public class CrashSentinel {
    private static final String TAG = "CrashSentinel";
    private static final String SENTINEL_FILE = "crash-sentinel.json";
    private static final String PREFS_NAME = "crash-sentinel-prefs";
    private static final String KEY_QUARANTINE = "quarantine";
    private static final String KEY_CRASH_HISTORY = "crash_history";
    private static final long QUARANTINE_DURATION_MS = 7 * 24 * 60 * 60 * 1000L; // 7 天

    private static File sentinelFile;

    /**
     * 初始化哨兵文件路径（Application.onCreate 调用）
     */
    public static void init(Context context) {
        sentinelFile = new File(context.getFilesDir(), SENTINEL_FILE);
    }

    /**
     * 写入哨兵（进入高危操作前调用）
     *
     * @param action   操作类型（spider.play / spider.detail / exoplayer / download 等）
     * @param details  附加信息（JSON 对象，如 sourceKey, jarMd5, api, url 等）
     */
    public static void begin(String action, JSONObject details) {
        if (sentinelFile == null) {
            Log.w(TAG, "sentinel not initialized");
            return;
        }
        try {
            JSONObject sentinel = new JSONObject();
            sentinel.put("action", action);
            sentinel.put("timestamp", System.currentTimeMillis());
            if (details != null) {
                Iterator<String> keys = details.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    sentinel.put(key, details.get(key));
                }
            }
            try (FileWriter writer = new FileWriter(sentinelFile)) {
                writer.write(sentinel.toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to write sentinel", e);
        }
    }

    /**
     * 清除哨兵（操作正常结束后调用）
     */
    public static void end() {
        if (sentinelFile == null) return;
        try {
            if (sentinelFile.exists()) {
                Files.delete(sentinelFile.toPath());
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to clear sentinel", e);
        }
    }

    /**
     * 读取未清除的哨兵（应用启动时调用）
     *
     * @return 哨兵 JSON，若不存在或解析失败返回 null
     */
    public static JSONObject readUncleared() {
        if (sentinelFile == null || !sentinelFile.exists()) return null;
        try {
            String content = new String(Files.readAllBytes(sentinelFile.toPath()));
            return new JSONObject(content);
        } catch (Exception e) {
            Log.w(TAG, "failed to read sentinel", e);
            return null;
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
     * @param signature 隔离签名（如 jarMd5 + api，或 sourceId + host）
     */
    public static void quarantine(Context context, String signature) {
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
    public static boolean isQuarantined(Context context, String signature) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String quarantineJson = prefs.getString(KEY_QUARANTINE, "{}");
            JSONObject quarantine = new JSONObject(quarantineJson);
            if (!quarantine.has(signature)) return false;
            long timestamp = quarantine.getLong(signature);
            if (System.currentTimeMillis() - timestamp > QUARANTINE_DURATION_MS) {
                // 过期，自动移除
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
    public static void unquarantine(Context context, String signature) {
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
    public static java.util.List<String> getQuarantined(Context context) {
        java.util.List<String> result = new java.util.ArrayList<>();
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
