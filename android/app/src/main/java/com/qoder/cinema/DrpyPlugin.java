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

    /**
     * 下载内容是 HTML 页面而非 JS 源码时抛出。
     * 与普通过载区分开：load() 捕获后可走 ext 回退（CHG-29）。
     */
    static final class HtmlResponseException extends Exception {
        HtmlResponseException(String message) { super(message); }
    }

    /** 同 SpiderPlugin：Capacitor 桥接是单线程，重活必须进独立线程池 */
    // OPT-21: 有界线程池（core 2 / max 8 / queue 32），防突发并发线程爆炸
    private final ExecutorService drpyExecutor = new java.util.concurrent.ThreadPoolExecutor(
            2, 8, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.LinkedBlockingQueue<>(32),
            r -> {
                Thread t = new Thread(r, "drpy-worker");
                t.setDaemon(true);
                return t;
            },
            new java.util.concurrent.ThreadPoolExecutor.AbortPolicy()
    );
    private final Handler watchdog = new Handler(Looper.getMainLooper());
    private static final long LOAD_TIMEOUT_MS = 75_000;
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
        try {
            drpyExecutor.execute(() -> {
                try {
                    task.run();
                    if (settled.compareAndSet(false, true)) {
                        watchdog.removeCallbacks(timeoutTask);
                    }
                } catch (Throwable e) {
                    if (settled.compareAndSet(false, true)) {
                        watchdog.removeCallbacks(timeoutTask);
                        Log.w(TAG, op + " failed", e);
                        call.reject(label + "失败: " + e.getMessage());
                    }
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException rex) {
            // OPT-21: 线程池满时明确报错
            if (settled.compareAndSet(false, true)) {
                watchdog.removeCallbacks(timeoutTask);
                Log.w(TAG, op + " rejected (pool full)", rex);
                call.reject(label + "繁忙（线程池满），请稍后重试");
            }
        }
    }

    /** handle → 运行时 */
    private final Map<String, DrpyRuntime> loaded = new ConcurrentHashMap<>();
    // OPT-19: 运行时 LRU 回收（上限 8 个，空闲超 10min 自动 close）
    private static final int MAX_LOADED_RUNTIMES = 8;
    private static final long IDLE_EVICTION_MS = 10 * 60 * 1000L;
    private final Map<String, Long> lastAccessTime = new ConcurrentHashMap<>();
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
            String code;
            String effectiveRuleUrl = ruleUrl;
            try {
                code = ruleText != null && !ruleText.isEmpty()
                        ? ruleText
                        : loadRuleCode(getContext(), ruleUrl);
            } catch (HtmlResponseException he) {
                // CHG-29: api URL 返回 HTML 门户页（源站路径失效的典型表现）——
                // 若 initExt 是 http(s) 规则文件地址，改从 ext 下载真正的规则代码，
                // drpy_host.js 已内置完整 drpy2 API 绑定，不依赖远端运行时库。
                if (initExt != null && initExt.matches("^https?://.+")) {
                    Log.i(TAG, "api 返回 HTML，回退到 ext 规则文件: " + initExt);
                    try {
                        code = loadRuleCode(getContext(), initExt);
                        effectiveRuleUrl = initExt;
                    } catch (Exception extEx) {
                        throw new IllegalStateException(
                                "该站点脚本地址失效（服务器返回门户页），规则文件同样不可用：" + extEx.getMessage());
                    }
                } else {
                    throw new IllegalStateException(
                            "该站点脚本地址失效（服务器返回门户页而非 JS 源码），建议更换订阅源或在反馈中报告此站点");
                }
            }
            String handle = "dp-" + (++handleSeq);
            // v1.8/CHG-27：ruleUrl 传入运行时——catvod 模块规则的相对 import 需要基地址
            DrpyRuntime runtime = new DrpyRuntime(getContext(), code, initExt, handle, effectiveRuleUrl);

            // OPT-19: LRU 回收（超上限时关闭最久未使用的运行时）
            if (loaded.size() >= MAX_LOADED_RUNTIMES) {
                evictIdleRuntime();
            }

            loaded.put(handle, runtime);
            lastAccessTime.put(handle, System.currentTimeMillis());
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        });
    }

    // OPT-19: 回收最久未使用的运行时（空闲超 10min 优先）
    private void evictIdleRuntime() {
        long now = System.currentTimeMillis();
        String oldestHandle = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<String, Long> entry : lastAccessTime.entrySet()) {
            long idle = now - entry.getValue();
            if (idle > IDLE_EVICTION_MS) {
                // 优先回收空闲超时的
                oldestHandle = entry.getKey();
                break;
            }
            if (entry.getValue() < oldestTime) {
                oldestTime = entry.getValue();
                oldestHandle = entry.getKey();
            }
        }
        if (oldestHandle != null) {
            DrpyRuntime evicted = loaded.remove(oldestHandle);
            lastAccessTime.remove(oldestHandle);
            if (evicted != null) {
                try {
                    evicted.close();
                    Log.i(TAG, "evicted idle runtime: " + oldestHandle);
                } catch (Exception e) {
                    Log.w(TAG, "failed to close evicted runtime", e);
                }
            }
        }
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

        // OPT-19: 刷新访问时间
        lastAccessTime.put(handle, System.currentTimeMillis());

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
            lastAccessTime.remove(handle); // OPT-19: 清理访问时间
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
        String normalized = normalizeRuleUrl(url);
        java.util.List<String> candidates = buildRuleUrlCandidates(normalized);
        if (candidates.isEmpty()) {
            throw new IllegalStateException("empty rule url");
        }
        // 用「归一化后的原地址」做缓存 key（不随镜像前缀变化）
        String cacheKey = normalized;
        File file = ruleCache.get(cacheKey);
        if (file != null && file.exists()) {
            // 旧版本可能已把 HTML 页缓存成 .js，命中时也要验一遍
            String problem = inspectRuleContent(file);
            if (problem == null) return readRuleFile(file);
            Log.w(TAG, "cached rule is not JS, dropping: " + cacheKey);
            if (!file.delete()) Log.w(TAG, "cannot delete invalid cached rule");
            ruleCache.remove(cacheKey);
            // 缓存是 HTML → 服务器一直返回门户页，直接走 HtmlResponseException 以便上层回退
            if (problem.startsWith("返回的是 HTML")) throw new HtmlResponseException(problem + "：" + url);
        }
        File dir = new File(context.getFilesDir(), "drpy-rules");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create drpy-rules dir");
        }
        File target = new File(dir, md5Of(cacheKey) + ".js");

        // 逐个候选尝试：gh-proxy.net 失效时自动换直连 / 其它镜像
        Exception lastError = null;
        for (int i = 0; i < candidates.size(); i++) {
            String tryUrl = candidates.get(i);
            try {
                lastError = null;
                downloadRuleTo(tryUrl, dir, target);
                if (i > 0) {
                    Log.i(TAG, "rule url fallback hit (#" + (i + 1) + "): " + tryUrl);
                } else if (!tryUrl.equals(url)) {
                    Log.i(TAG, "rule url normalized: " + url + " -> " + tryUrl);
                }
                ruleCache.put(cacheKey, target);
                return readRuleFile(target);
            } catch (HtmlResponseException he) {
                // HTML 门户页：同域名其它候选路径也一样，直接传播给上层走 ext 回退
                throw he;
            } catch (Exception e) {
                lastError = e;
                Log.w(TAG, "rule url candidate failed (#" + (i + 1) + "): " + tryUrl
                        + " -> " + describeRuleError(e));
            }
        }
        throw lastError != null ? lastError : new IllegalStateException("all rule url candidates failed");
    }

    /** 从单个 URL 下载规则并做内容校验，失败抛异常 */
    private void downloadRuleTo(String fetchUrl, File dir, File target) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(fetchUrl).openConnection();
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
            // P1-C: 内容必须是 JS。GitHub blob 页 / 死镜像 / 防盗链都会 200 返回 HTML，
            // 直接喂给 QuickJS 只会报 `unexpected token '<'`，掩盖真实原因。
            // CHG-29: HTML 走专用异常，上层可据此回退到 ext 规则文件。
            String problem = inspectRuleContent(temp);
            if (problem != null) {
                long size = temp.length();
                if (!temp.delete()) Log.w(TAG, "cannot delete invalid rule temp");
                if (problem.startsWith("返回的是 HTML")) {
                    throw new HtmlResponseException(problem + "（" + size + " 字节）：" + fetchUrl);
                }
                throw new IllegalStateException(problem + "（" + size + " 字节）：" + fetchUrl);
            }
            if (!temp.renameTo(target)) {
                throw new IllegalStateException("cannot save rule");
            }
        } finally {
            conn.disconnect();
        }
        Log.i(TAG, "downloaded rule: " + fetchUrl);
    }

    /** 规则下载错误的简短描述（用于日志，避免逐条打堆栈） */
    private static String describeRuleError(Exception e) {
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }


    /**
     * 把常见的「网页地址」归一化成「源码直链」。
     *
     * 订阅里贴 GitHub 网页链接是最常见的错误来源：`/blob/` 页返回的是 HTML 外壳，
     * QuickJS 解析必然失败。这里在下载前改写，避免把 HTML 当规则缓存下来。
     * 纯字符串处理，不做网络探测。
     */
    private static String normalizeRuleUrl(String url) {
        if (url == null) return "";
        String out = url.trim();
        // 镜像前缀 + GitHub blob：gh-proxy.net/https://github.com/o/r/blob/ref/p.js
        int githubAt = out.indexOf("github.com/");
        if (githubAt >= 0 && out.indexOf("/blob/", githubAt) > 0) {
            String head = out.substring(0, githubAt);       // 保留镜像前缀（如 https://gh-proxy.net/）
            String tail = out.substring(githubAt + "github.com/".length());
            String converted = tail.replaceFirst("/blob/", "/");
            return head + "raw.githubusercontent.com/" + converted;
        }
        // GitLab：/-/blob/ → /-/raw/
        if (out.contains("gitlab.com/") && out.contains("/-/blob/")) {
            return out.replace("/-/blob/", "/-/raw/");
        }
        return out;
    }

    /**
     * 镜像前缀 → 可用的 GitHub 镜像候选（顺序即优先级）。
     * 与 TS 侧 `GITHUB_MIRROR_HOSTS` / `URL_PROXY_HOSTS` 保持一致；
     * 实测 `gh-proxy.net` 在部分网络下完全不可达（20s 超时），必须有别的接上。
     */
    private static final String[] GITHUB_MIRROR_PREFIXES = {
            "https://gh-proxy.org/",
            "https://ghfast.top/",
            "https://gh-proxy.com/",
            "https://ghproxy.net/",
            "https://mirror.ghproxy.com/",
    };

    /**
     * jsdelivr 系 CDN 主机（国内可达性通常优于 GitHub 直连与 gh-proxy 系）。
     * 它们不是「前缀代理」，而是把 `raw.githubusercontent.com/u/r/ref/path`
     * 映射成 `https://<cdn>/gh/u/r@ref/path` 的独立 CDN，需要单独拼接。
     */
    private static final String[] JSDELIVR_HOSTS = {
            "https://cdn.jsdelivr.net/gh/",
            "https://fastly.jsdelivr.net/gh/",
            "https://gcore.jsdelivr.net/gh/",
            "https://testingcf.jsdelivr.net/gh/",
    };

    /** 会被镜像前缀包装的原始 host（剥掉前缀后能直连的） */
    private static final String[] MIRRORED_HOSTS = {
            "raw.githubusercontent.com",
            "gist.githubusercontent.com",
            "github.com",
            "gitlab.com",
    };

    /**
     * 为一条规则地址生成**按优先级排列的候选列表**，首个为原地址。
     *
     * 解决的真实故障：订阅里写的是 `https://gh-proxy.net/https://raw.githubusercontent.com/...`，
     * 该镜像在真机网络下 20s 超时，而代码只尝试这一个地址 → 整条规则死掉。
     * 候选依次为：
     *   1. 原地址（用户配置优先，能用就不折腾）
     *   2. 剥掉镜像前缀直连原始 host
     *   3. jsdelivr CDN 变体（国内可达性最好，放在 gh-proxy 系之前）
     *   4. 其它 gh-proxy 系镜像前缀
     *
     * 非 GitHub 域名不生成候选（避免对任意 URL 乱加前缀）。
     */
    private static java.util.List<String> buildRuleUrlCandidates(String url) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (url == null || url.isEmpty()) return out;
        out.add(url);

        // 1) 剥前缀：找到 URL 里第一个「被镜像的原始地址」起点
        String bare = null;
        for (String host : MIRRORED_HOSTS) {
            int at = url.indexOf(host + "/");
            if (at > 0 && at < url.length() - host.length() - 1) {
                String candidate = "https://" + url.substring(at);
                if (!candidate.equals(url)) bare = candidate;
                break;
            }
        }
        // 原地址本身就是裸 GitHub 地址时也要生成变体（直连不通时可走 CDN）
        if (bare == null && url.startsWith("https://")) {
            for (String host : MIRRORED_HOSTS) {
                if (url.startsWith("https://" + host + "/")) {
                    bare = url;
                    break;
                }
            }
        }
        if (bare == null) return out;   // 非 GitHub 域名，不需要回退
        if (!out.contains(bare)) out.add(bare);

        // 2) jsdelivr CDN 变体：raw.githubusercontent.com/u/r/ref/path → cdn/gh/u/r@ref/path
        for (String jsdelivr : jsdelivrUrlVariants(bare)) {
            if (!out.contains(jsdelivr)) out.add(jsdelivr);
        }

        // 3) gh-proxy 系前缀镜像
        for (String prefix : GITHUB_MIRROR_PREFIXES) {
            String candidate = prefix + bare;
            if (!out.contains(candidate)) out.add(candidate);
        }
        return out;
    }

    /**
     * 生成 jsdelivr 变体。
     * `https://raw.githubusercontent.com/{u}/{r}/{ref}/{path}`
     *   → `https://cdn.jsdelivr.net/gh/{u}/{r}@{ref}/{path}`
     * 非 raw 域名（gist/gitlab 等）不生成。
     */
    private static java.util.List<String> jsdelivrUrlVariants(String bareUrl) {
        java.util.List<String> out = new java.util.ArrayList<>();
        String rawPrefix = "https://raw.githubusercontent.com/";
        if (!bareUrl.startsWith(rawPrefix)) return out;
        String rest = bareUrl.substring(rawPrefix.length());
        // 至少要 u/r/ref/path 四段
        String[] parts = rest.split("/", 4);
        if (parts.length < 4 || parts[3].isEmpty()) return out;
        String mapped = parts[0] + "/" + parts[1] + "@" + parts[2] + "/" + parts[3];
        for (String host : JSDELIVR_HOSTS) {
            out.add(host + mapped);
        }
        return out;
    }

    /**
     * 检查下载物是否是「看起来像规则源码」的内容。
     * 返回 null 表示通过，否则返回可读的问题描述。
     */
    private static String inspectRuleContent(File file) throws Exception {
        long size = file.length();
        if (size <= 0) return "规则内容为空";
        byte[] head = new byte[(int) Math.min(size, 4096)];
        try (InputStream in = new java.io.FileInputStream(file)) {
            int read = in.read(head);
            if (read <= 0) return "规则内容为空";
            String text = new String(head, 0, read, "UTF-8");
            // BOM 是 U+FEFF，trim() 去不掉（只去 <= ' '），带 BOM 的 HTML 页会骗过首字符判断
            if (!text.isEmpty() && text.charAt(0) == '\uFEFF') text = text.substring(1);
            String trimmed = text.trim();
            if (trimmed.isEmpty()) return "规则内容为空";
            String lower = trimmed.toLowerCase();
            if (trimmed.charAt(0) == '<' || lower.startsWith("<!doctype") || lower.startsWith("<html")) {
                return "返回的是 HTML 页面而非 JS 源码";
            }
        }
        return null;
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
