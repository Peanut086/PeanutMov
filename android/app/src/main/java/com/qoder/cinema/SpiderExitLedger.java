package com.qoder.cinema;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Process;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * P0-1：爬虫退出现场台账。
 *
 * <p>真机日志暴露的两个盲区，都在这一个类里收口：
 * <ol>
 *   <li><b>Java 退出被吞掉。</b>{@code tryProxy} 对所有 Throwable 静默放弃，invoke 路径的
 *       {@code IncompatibleClassChangeError} 也只留下一句"爬虫执行失败"。这类异常本来就
 *       catch 得住，所以进程没死、哨兵被正常清除、下次启动查不到任何现场——坏构件因此
 *       永远隔离不掉，每轮预热再崩一次。</li>
 *   <li><b>归因字段散在好几行里。</b>处置档位、jarMd5、api、阶段、AEI 的 reason/status、
 *       tombstone 的 signal 各自一行，导出日志里要靠时间戳手工对。治理判定（按构件指纹 +
 *       API + 阶段 + 退出证据）需要一行看全。</li>
 * </ol>
 *
 * <p>所以这里做三件事：爬虫执行入口登记"当前在跑哪个 jar 的哪个 api、哪个阶段"；任何逃逸的
 * Throwable 归因成一条 {@code CrashExit} 证据行（pid/tid/jarHash/api/phase/exitReason/signal/
 * responseTier）；最近若干条留在内存 + 落盘一份，供 JS 在下次启动拉走（原生信号能直接杀死
 * 进程，catch 不到的那一半只能等重启后由 {@link MainApplication} 把 AEI/tombstone 写回来——
 * 这条链覆盖的是能被 catch 住、过去却什么都没留下的那一半）。
 *
 * <p>处置口径：只有<b>构件级故障</b>（LinkageError / VerifyError / ExceptionInInitializerError /
 * 缺类缺方法）才按 api 签名隔离——它每次都会以同样方式失败，冷却半小时毫无意义；源站侧的
 * 空指针、HTTP 失败仍交回原有的失败分类，不动健康站点。
 */
final class SpiderExitLedger {
    private static final String TAG = "CrashExit";
    /** 内存里保留的最近现场条数 */
    private static final int MEMORY_LIMIT = 8;
    /** 跨进程落盘保留的条数（启动时写回的 AEI/tombstone 证据） */
    private static final int PERSIST_LIMIT = 12;
    private static final String PREFS_NAME = "crash-exit-info";
    private static final String KEY_EVIDENCE = "exit_evidence";

    private static final ArrayDeque<JSONObject> recent = new ArrayDeque<>();
    /** 当前线程正在执行的爬虫现场；由 executeJar / invoke / proxy 入口处设置 */
    private static final ThreadLocal<JSONObject> current = new ThreadLocal<>();

    private SpiderExitLedger() {
    }

    /**
     * 登记本次执行现场（在写哨兵的同一处调用）。
     *
     * @param phase   阶段，如 {@code spider.load} / {@code spider.invoke:playContent} / {@code spider.proxy:do}
     * @param jarHash 构件指纹（jarMd5），拿不到给空串
     * @param api     订阅配置里的爬虫类名
     * @param detail  补充上下文（方法参数摘要等），可空
     */
    static void enter(String phase, String jarHash, String api, String detail) {
        JSONObject ctx = new JSONObject();
        try {
            ctx.put("phase", phase == null ? "?" : phase);
            ctx.put("jarHash", jarHash == null ? "" : jarHash);
            ctx.put("api", api == null ? "" : api);
            ctx.put("detail", detail == null ? "" : detail);
        } catch (Exception ignored) {
            // 台账绝不能反过来影响业务调用
        }
        current.set(ctx);
    }

    /** 现场结束（正常返回或异常都已记录） */
    static void exit() {
        current.remove();
    }

    /**
     * 记录一次被 catch 住的爬虫异常。
     *
     * @param throwable 逃逸到插件边界的异常
     * @param swallowed true = 调用方把它吞了（proxy 逐候选尝试）；false = 会以错误回执抛给 JS
     * @param context   用于按构件隔离
     */
    static void noteJavaExit(Throwable throwable, boolean swallowed, Context context) {
        if (throwable == null) return;
        JSONObject ctx = current.get();
        String phase = ctx != null ? ctx.optString("phase", "?") : "spider.?";
        String jarHash = ctx != null ? ctx.optString("jarHash", "") : "";
        String api = ctx != null ? ctx.optString("api", "") : "";
        Throwable root = unwrap(throwable);
        String exitReason = "java:" + root.getClass().getName();
        boolean structural = isStructuralFailure(root);

        String tier = "NONE";
        if (structural && !jarHash.isEmpty() && !api.isEmpty() && context != null) {
            // 构件级故障是确定性的：同一个 api 每次都会以同样方式失败，直接按签名隔离，
            // 而不是冷却（"暂停反复引发退出的 JAR"里"反复"由异常本身证明，不需要等第二次）
            String signature = "spider:" + jarHash + ":" + api;
            CrashSentinel.quarantine(context, signature);
            tier = "QUARANTINE";
        }

        JSONObject entry = new JSONObject();
        try {
            entry.put("ts", System.currentTimeMillis());
            entry.put("pid", Process.myPid());
            entry.put("tid", Thread.currentThread().getId());
            entry.put("threadName", Thread.currentThread().getName());
            entry.put("jarHash", jarHash);
            entry.put("api", api);
            entry.put("phase", phase);
            entry.put("exitReason", exitReason);
            entry.put("signal", "-");
            entry.put("responseTier", tier);
            entry.put("swallowed", swallowed);
            entry.put("detail", shorten(root.toString()));
            if (ctx != null && ctx.has("detail")) entry.put("call", ctx.get("detail"));
        } catch (Exception ignored) {
            // 同上
        }

        String line;
        try {
            line = entry.toString();
        } catch (Exception e) {
            line = "phase=" + phase + " exitReason=" + exitReason;
        }
        // W 级：详细日志开关关闭也要落盘，否则用户"闪退后导出日志"时这条链又是空的
        AppLog.w(TAG, "spider java exit " + line);
        record(entry);
        // 现场归因完即失效：执行线程会被复用，留着它会把下一次不相干的异常算到同一个 jar 头上
        exit();
    }

    /**
     * 只有当前线程确实有在途爬虫现场时才归因（用于统一的插件边界），
     * 避免把排队、参数转换这类与 jar 无关的失败也算到某个构件头上。
     */
    static void noteJavaExitIfInFlight(Throwable throwable, boolean swallowed, Context context) {
        if (throwable == null || current.get() == null) return;
        noteJavaExit(throwable, swallowed, context);
    }

    /** 启动阶段把上一次进程的真实退出证据写回台账（AEI / tombstone 归因结果） */
    static void recordProcessExit(String phase, String jarHash, String api, String exitReason,
                                  String signal, String responseTier, int pid, long ts,
                                  String detail, Context context) {
        JSONObject entry = new JSONObject();
        try {
            entry.put("ts", ts > 0 ? ts : System.currentTimeMillis());
            entry.put("pid", pid);
            entry.put("tid", -1);
            entry.put("jarHash", jarHash == null ? "" : jarHash);
            entry.put("api", api == null ? "" : api);
            entry.put("phase", phase == null ? "?" : phase);
            entry.put("exitReason", exitReason == null ? "?" : exitReason);
            entry.put("signal", signal == null ? "-" : signal);
            entry.put("responseTier", responseTier == null ? "NONE" : responseTier);
            entry.put("fromPreviousProcess", true);
            if (detail != null && !detail.isEmpty()) entry.put("detail", shorten(detail));
        } catch (Exception ignored) {
            return;
        }
        record(entry);
        if (context != null) {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONArray stored = new JSONArray(prefs.getString(KEY_EVIDENCE, "[]"));
                stored.put(entry);
                while (stored.length() > PERSIST_LIMIT) stored.remove(0);
                prefs.edit().putString(KEY_EVIDENCE, stored.toString()).apply();
            } catch (Exception e) {
                Log.w("SpiderExitLedger", "failed to persist exit evidence", e);
            }
        }
    }

    /** 内存 + 落盘的合并快照（新→旧），供 JS 拉取 */
    static JSONArray snapshot(Context context) {
        JSONArray out = new JSONArray();
        JSONArray persisted = new JSONArray();
        try {
            if (context != null) {
                SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                persisted = new JSONArray(prefs.getString(KEY_EVIDENCE, "[]"));
            }
        } catch (Exception e) {
            Log.w("SpiderExitLedger", "failed to read persisted exit evidence", e);
        }
        // 倒序：先落盘的旧记录，再内存里的本轮记录
        for (int i = 0; i < persisted.length(); i++) {
            JSONObject item = persisted.optJSONObject(i);
            if (item != null) out.put(item);
        }
        synchronized (recent) {
            Iterator<JSONObject> it = recent.descendingIterator();
            while (it.hasNext()) out.put(it.next());
        }
        return out;
    }

    private static void record(JSONObject entry) {
        synchronized (recent) {
            recent.addLast(entry);
            while (recent.size() > MEMORY_LIMIT) recent.pollFirst();
        }
    }

    /** 剥掉反射/初始化包装，拿到真正报错的那一层 */
    private static Throwable unwrap(Throwable t) {
        Throwable cur = t;
        for (int depth = 0; depth < 5; depth++) {
            boolean wrapper = cur instanceof java.lang.reflect.InvocationTargetException
                    || cur instanceof ExceptionInInitializerError;
            if (!wrapper || cur.getCause() == null) return cur;
            cur = cur.getCause();
        }
        return cur;
    }

    /**
     * 是否为构件级故障：dex/native 库之间的签名不匹配、校验失败、缺类缺方法。
     *
     * 这类异常由 jar 自身与运行时（其它 jar、ART、系统 API）不一致造成，重试必然同样失败，
     * 与"源站脚本 NPE / 网络超时"必须分开——后者隔离掉只会误杀健康站点。
     */
    private static boolean isStructuralFailure(Throwable t) {
        Throwable cur = t;
        for (int depth = 0; depth < 5 && cur != null; depth++) {
            if (cur instanceof LinkageError) return true; // NoSuchMethodError / IncompatibleClassChangeError / ...
            if (cur instanceof VerifyError) return true;
            if (cur instanceof ClassNotFoundException) return true;
            if (cur instanceof NoSuchMethodException) return true;
            if (cur instanceof NoSuchFieldException) return true;
            String name = cur.getClass().getName();
            if (name.contains("IncompatibleClassChangeError") || name.contains("NoClassDefFoundError")) {
                return true;
            }
            cur = cur.getCause();
        }
        return false;
    }

    private static String shorten(String value) {
        if (value == null) return "";
        String flat = value.replaceAll("\\s+", " ").trim();
        return flat.length() <= 220 ? flat : flat.substring(0, 220);
    }
}
