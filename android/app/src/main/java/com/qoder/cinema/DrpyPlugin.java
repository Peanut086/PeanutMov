package com.qoder.cinema;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.qoder.cinema.drpy.DrpyRuntime;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Drpy —— drpy JS 规则运行时（CHG-16）
 *
 * 与 {@link SpiderPlugin}（jar 爬虫）对等：
 * 1. 下载规则文件（GitHub 镜像回退由 TS 侧做，这里只管单个 URL），
 *    缓存到 `filesDir/drpy-rules/{md5}.js`（8MB 上限，与 jar 同惯例）；
 * 2. 每条规则一个 {@link DrpyRuntime}（独立 QuickJS 实例 + 独占引擎线程），
 *    单规则死循环/崩溃不影响其它源；
 * 3. `invoke` 按编排方法（home/category/detail/search/play）返回 TVBox JSON，
 *    前端 SpiderAdapter 对 kind:'js' 源路由到这里，解析口径与 jar 完全一致。
 */
@CapacitorPlugin(name = "Drpy")
public class DrpyPlugin extends Plugin {

    private static final String TAG = "DrpyPlugin";
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final long MAX_RULE_BYTES = 8L * 1024 * 1024;

    /** 同 SpiderPlugin：Capacitor 桥接是单线程，重活必须进独立线程池 */
    private final ExecutorService drpyExecutor = Executors.newCachedThreadPool();
    private final Handler watchdog = new Handler(Looper.getMainLooper());
    private static final long LOAD_TIMEOUT_MS = 40_000;
    private static final long INVOKE_TIMEOUT_MS = 30_000;

    private interface DrpyTask {
        void run() throws Exception;
    }

    private void runDrpy(PluginCall call, String op, long timeoutMs, DrpyTask task) {
        final AtomicBoolean settled = new AtomicBoolean(false);
        final String label = "规则" + op;
        final Runnable timeoutTask = () -> {
            if (settled.compareAndSet(false, true)) {
                Log.w(TAG, op + " timeout after " + timeoutMs + "ms");
                call.reject(label + "超时（" + (timeoutMs / 1000) + " 秒），请重试或更换源");
            }
        };
        watchdog.postDelayed(timeoutTask, timeoutMs);
        drpyExecutor.execute(() -> {
            try {
                task.run();
                if (settled.compareAndSet(false, true)) {
                    watchdog.removeCallbacks(timeoutTask);
                }
            } catch (Exception e) {
                if (settled.compareAndSet(false, true)) {
                    watchdog.removeCallbacks(timeoutTask);
                    Log.w(TAG, op + " failed", e);
                    call.reject(label + "失败: " + e.getMessage());
                }
            }
        });
    }

    /** handle → 运行时 */
    private final Map<String, DrpyRuntime> loaded = new ConcurrentHashMap<>();
    /** 规则地址 → 已下载文件，避免重复下载 */
    private final Map<String, File> ruleCache = new ConcurrentHashMap<>();
    private int handleSeq = 0;

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        call.resolve(ret);
    }

    /** load({ ruleUrl?, ruleText?, initExt? }) → { handle }；ruleUrl 与 ruleText 二选一 */
    @PluginMethod
    public void load(PluginCall call) {
        String ruleUrl = call.getString("ruleUrl");
        String ruleText = call.getString("ruleText");
        String initExt = call.getString("initExt", "");

        if ((ruleUrl == null || ruleUrl.isEmpty()) && (ruleText == null || ruleText.isEmpty())) {
            call.reject("ruleUrl 或 ruleText 必须提供一个");
            return;
        }

        runDrpy(call, "加载", LOAD_TIMEOUT_MS, () -> {
            String code = ruleText != null && !ruleText.isEmpty()
                    ? ruleText
                    : loadRuleCode(getContext(), ruleUrl);
            String handle = "dp-" + (++handleSeq);
            DrpyRuntime runtime = new DrpyRuntime(getContext(), code, initExt, handle);
            loaded.put(handle, runtime);
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        });
    }

    /** invoke({ handle, method, arg? }) → { json, logs }；method ∈ home|category|detail|search|play */
    @PluginMethod
    public void invoke(PluginCall call) {
        String handle = call.getString("handle");
        String method = call.getString("method");
        String arg = call.getString("arg", "{}");

        DrpyRuntime target = handle == null ? null : loaded.get(handle);
        if (target == null) {
            call.reject("drpy instance not found");
            return;
        }

        runDrpy(call, "调用", INVOKE_TIMEOUT_MS, () -> {
            String json = target.invoke(method, arg);
            JSObject ret = new JSObject();
            ret.put("json", json);
            List<String> logs = target.drainLogs();
            ret.put("logs", new JSArray(logs));
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        String handle = call.getString("handle");
        DrpyRuntime target = handle == null ? null : loaded.remove(handle);
        if (target != null) {
            try (DrpyRuntime ignored = target) {
                // close() 在 try-with-resources 中执行
            } catch (Exception e) {
                Log.w(TAG, "unload failed", e);
            }
        }
        JSObject ret = new JSObject();
        ret.put("released", target != null);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        watchdog.removeCallbacksAndMessages(null);
        drpyExecutor.shutdownNow();
        for (DrpyRuntime runtime : loaded.values()) {
            try {
                runtime.close();
            } catch (Exception ignored) {
                // 销毁期静默
            }
        }
        loaded.clear();
        ruleCache.clear();
    }

    /* ---------------- 规则文件 ---------------- */

    /** 下载规则源码：`filesDir/drpy-rules/{md5}.js`，已缓存直接用 */
    private String loadRuleCode(Context context, String url) throws Exception {
        File file = ruleCache.get(url);
        if (file != null && file.exists()) {
            return readRuleFile(file);
        }
        File dir = new File(context.getFilesDir(), "drpy-rules");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create drpy-rules dir");
        }
        File target = new File(dir, md5Of(url) + ".js");
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) PeanutMov");
        try {
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("HTTP " + status);
            }
            File temp = new File(dir, target.getName() + ".tmp");
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[16384];
                long total = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_RULE_BYTES) {
                        throw new IllegalStateException("rule too large");
                    }
                    out.write(buffer, 0, read);
                }
            }
            if (!temp.renameTo(target)) {
                throw new IllegalStateException("cannot save rule");
            }
        } finally {
            conn.disconnect();
        }
        Log.i(TAG, "downloaded rule: " + url);
        ruleCache.put(url, target);
        return readRuleFile(target);
    }

    private static String readRuleFile(File file) throws Exception {
        long size = file.length();
        if (size > MAX_RULE_BYTES) throw new IllegalStateException("rule too large");
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[(int) size];
            int total = 0;
            int read;
            while (total < buffer.length && (read = in.read(buffer, total, buffer.length - total)) > 0) {
                total += read;
            }
            return new String(buffer, 0, total, "UTF-8");
        }
    }

    private static String md5Of(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] bytes = digest.digest(value.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(value.hashCode());
        }
    }
}
