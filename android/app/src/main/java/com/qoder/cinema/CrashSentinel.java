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
 *
 * P0-1：哨兵只能证明"崩溃时这个操作在跑"，证明不了"是它让进程死的"。归因引擎据此把处置
 * 分成两档，隔离（quarantine，7 天）只在有 tombstone 实锤或同一签名反复出现时才用，单次可疑
 * 只进短时冷却（cooldown），避免一次误判把源禁一整周。
 */
public class CrashSentinel {
    private static final String TAG = "CrashSentinel";
    private static final String SENTINEL_DIR_NAME = "crash-sentinel";
    private static final String LEGACY_SENTINEL_FILE = "crash-sentinel.json";
    private static final String PREFS_NAME = "crash-sentinel-prefs";
    private static final String KEY_QUARANTINE = "quarantine";
    private static final String KEY_CRASH_HISTORY = "crash_history";
    /** P0-1：短时冷却表（值为到期时刻），与 7 天隔离分表存放，设置页的解除隔离不碰它 */
    private static final String KEY_COOLDOWN = "cooldown";
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
            // P0-1：隔离档覆盖冷却档，撤掉被覆盖的冷却键，免得同一签名在两张表里各留一条记录
            if (signature != null && signature.endsWith(":*")) {
                clearJarCooldowns(context, jarMd5Of(signature));
            } else {
                clearCooldown(context, signature);
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to quarantine", e);
        }
    }

    /** 从 {@code spider:<md5>:<api>} / {@code spider:<md5>:*} 里取 jarMd5，取不到给空串 */
    private static String jarMd5Of(String signature) {
        if (signature == null || !signature.startsWith("spider:")) return "";
        String rest = signature.substring("spider:".length());
        int colon = rest.indexOf(':');
        return colon < 0 ? rest : rest.substring(0, colon);
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
     * P0-1：爬虫在 load/invoke 前被拦的原因；返回 {@code null} 表示放行。
     *
     * <ul>
     *   <li>{@code "api-quarantined"} —— 该 jar+api 被隔离 7 天；</li>
     *   <li>{@code "jar-quarantined"} —— 整个 jarMd5 被隔离（{@code spider:<md5>:*}）；</li>
     *   <li>{@code "cooldown"} —— 短时冷却，到点自动放行。</li>
     * </ul>
     *
     * <p>为什么要 jar 级：真机两次实证「同一 jar 换个 api 照崩」——tombstone 实锤（F2'），
     * 以及导出日志 11-18 19:27 崩 {@code csp_PanWebShare123}、22:37 崩 {@code csp_PanWebShare}
     * （同一 jarMd5 {@code 440f930e…}，两次都无 tombstone）。只隔崩溃现场那个 api，等于每次都
     * 隔错东西；{@code isQuarantined} 因此在 api 级之外再认 {@code :*} 通配。
     *
     * <p>为什么要把冷却与隔离分开报：两者对用户的说法完全不同（"这个源崩过、7 天内不再用" vs
     * "刚崩过一次，半小时后再试"），混成一句会让健康管理和加载失败提示都不诚实。
     */
    public static synchronized String spiderBlockReason(Context context, String jarMd5, String api) {
        if (jarMd5 == null || jarMd5.isEmpty()) return null;
        if (api != null && !api.isEmpty() && isQuarantined(context, "spider:" + jarMd5 + ":" + api)) {
            return "api-quarantined";
        }
        if (isQuarantined(context, "spider:" + jarMd5 + ":*")) return "jar-quarantined";
        if (api != null && !api.isEmpty() && isCoolingDown(context, "spider:" + jarMd5 + ":" + api)) {
            return "cooldown";
        }
        return null;
    }

    // ========== P0-1：短时冷却（与 7 天隔离分表存放，互不影响） ==========

    /**
     * 开始一次短时冷却：值为到期时刻（毫秒），到期后自动放行；不写隔离名单。
     */
    public static synchronized void startCooldown(Context context, String signature, long durationMs) {
        try {
            JSONObject cooldown = readCooldown(context);
            cooldown.put(signature, System.currentTimeMillis() + Math.max(0L, durationMs));
            writeCooldown(context, cooldown);
            Log.i(TAG, "cooldown started: " + signature + " until+" + durationMs + "ms");
        } catch (Exception e) {
            Log.w(TAG, "failed to start cooldown", e);
        }
    }

    /** 是否处于冷却中（到期即视为不冷却，并顺手清掉该键） */
    public static synchronized boolean isCoolingDown(Context context, String signature) {
        try {
            JSONObject cooldown = readCooldown(context);
            if (!cooldown.has(signature)) return false;
            long until = cooldown.optLong(signature, 0L);
            if (System.currentTimeMillis() < until) return true;
            cooldown.remove(signature);
            writeCooldown(context, cooldown);
            return false;
        } catch (Exception e) {
            Log.w(TAG, "failed to check cooldown", e);
            return false;
        }
    }

    /** 冷却到期时刻（0 = 不在冷却），供日志与诊断页说明"还有多久自动放行" */
    public static synchronized long cooldownUntil(Context context, String signature) {
        try {
            JSONObject cooldown = readCooldown(context);
            long until = cooldown.optLong(signature, 0L);
            return until > System.currentTimeMillis() ? until : 0L;
        } catch (Exception e) {
            return 0L;
        }
    }

    /**
     * 当前处于冷却中的签名快照：key=签名，value=剩余毫秒（已过期的键顺手清掉）。
     *
     * P0-1：冷却不影响隔离名单，健康中心必须看得见它，否则用户只会遇到"源打不开、
     * 名单里却什么都没有"——排查入口不能被它要解释的问题挡住。
     */
    public static synchronized JSONObject cooldownSnapshot(Context context) {
        JSONObject result = new JSONObject();
        try {
            JSONObject cooldown = readCooldown(context);
            long now = System.currentTimeMillis();
            Iterator<String> keys = cooldown.keys();
            List<String> expired = new ArrayList<>();
            while (keys.hasNext()) {
                String key = keys.next();
                long until = cooldown.optLong(key, 0L);
                if (until <= now) {
                    expired.add(key);
                    continue;
                }
                result.put(key, until - now);
            }
            if (!expired.isEmpty()) {
                for (String key : expired) cooldown.remove(key);
                writeCooldown(context, cooldown);
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to read cooldown snapshot", e);
        }
        return result;
    }

    /** 冷却升级为隔离时调用：把冷却键撤掉，避免同一签名两处都有记录 */
    public static synchronized void clearCooldown(Context context, String signature) {
        try {
            JSONObject cooldown = readCooldown(context);
            if (!cooldown.has(signature)) return;
            cooldown.remove(signature);
            writeCooldown(context, cooldown);
        } catch (Exception e) {
            Log.w(TAG, "failed to clear cooldown", e);
        }
    }

    private static JSONObject readCooldown(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return new JSONObject(prefs.getString(KEY_COOLDOWN, "{}"));
    }

    private static void writeCooldown(Context context, JSONObject cooldown) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_COOLDOWN, cooldown.toString()).apply();
    }

    /**
     * F2'：按 jar 粒度隔离（该 jarMd5 下所有 api 一并拒绝），7 天后自动过期。
     */
    public static void quarantineJar(Context context, String jarMd5) {
        if (jarMd5 == null || jarMd5.isEmpty()) return;
        quarantine(context, "spider:" + jarMd5 + ":*");
    }

    /**
     * P0-1：jar 级隔离落实后，撤掉该 jar 下所有 api 的短时冷却键。
     *
     * 冷却是「单次可疑」档，隔离是「实锤」档，前者已被后者覆盖；不清的话同一签名在两张表里
     * 各留一条记录，冷却到点后读起来就像这个 api 又被放行过一轮。
     */
    public static synchronized void clearJarCooldowns(Context context, String jarMd5) {
        if (jarMd5 == null || jarMd5.isEmpty()) return;
        try {
            JSONObject cooldown = readCooldown(context);
            String prefix = "spider:" + jarMd5 + ":";
            boolean changed = false;
            Iterator<String> keys = cooldown.keys();
            List<String> hit = new ArrayList<>();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key.startsWith(prefix)) hit.add(key);
            }
            for (String key : hit) {
                cooldown.remove(key);
                changed = true;
            }
            if (changed) {
                writeCooldown(context, cooldown);
                Log.i(TAG, "cooldown cleared by jar-level quarantine: " + hit);
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to clear jar cooldowns", e);
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
            // P0-1：一次「解除」把该 jar 的隔离与冷却一起清掉。健康中心的解除按钮分不出
            // 面前这条属于哪一档，只清一档就会出现「点了还在被拦」，那比不加这个按钮更糟。
            List<String> related = new ArrayList<>();
            related.add(signature);
            if (signature != null && signature.endsWith(":*")) {
                String prefix = signature.substring(0, signature.length() - 1);
                related.addAll(cooldownKeysWithPrefix(context, prefix));
                related.addAll(quarantineKeysWithPrefix(prefs, prefix));
            }
            for (String key : related) {
                quarantine.remove(key);
                clearCooldown(context, key);
            }
            prefs.edit().putString(KEY_QUARANTINE, quarantine.toString()).apply();
            Log.i(TAG, "unquarantined: " + related);
        } catch (Exception e) {
            Log.w(TAG, "failed to unquarantine", e);
        }
    }

    /** 冷却表里以某前缀开头的键（jar 级解除时用：{@code spider:<md5>:} 覆盖该 jar 全部 api） */
    private static List<String> cooldownKeysWithPrefix(Context context, String prefix) {
        List<String> hit = new ArrayList<>();
        try {
            JSONObject cooldown = readCooldown(context);
            Iterator<String> keys = cooldown.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key.startsWith(prefix)) hit.add(key);
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to scan cooldown keys", e);
        }
        return hit;
    }

    /** 隔离表里以某前缀开头的键（jar 级 {@code :*} 解除时，同 jar 的 api 级隔离一并放行） */
    private static List<String> quarantineKeysWithPrefix(SharedPreferences prefs, String prefix) {
        List<String> hit = new ArrayList<>();
        try {
            JSONObject quarantine = new JSONObject(prefs.getString(KEY_QUARANTINE, "{}"));
            Iterator<String> keys = quarantine.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key.startsWith(prefix)) hit.add(key);
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to scan quarantine keys", e);
        }
        return hit;
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
