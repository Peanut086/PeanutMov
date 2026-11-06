package com.qoder.cinema;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderApi;
import com.github.catvod.crawler.SpiderDebug;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import com.google.gson.Gson;
import org.json.JSONObject;

/**
 * Spider —— TVBox jar 爬虫运行时
 *
 * 职责：
 * 1. 下载 jar（带 `;md5;hash` 时校验），缓存到 `filesDir/spider-jars`；
 * 2. `DexClassLoader` 加载 jar，按类名 `com.github.catvod.spider.{api}` 实例化；
 * 3. 依次调用 `init(Context, ext)` / `initApi(SpiderApi)`；
 * 4. 反射调用 `homeContent` / `categoryContent` / `detailContent` /
 *    `searchContent` / `playerContent`，把返回的 JSON 字符串交给 JS 侧。
 *
 * 设计约束：
 * - 爬虫方法签名在不同 jar 间有差异（`List` / `ArrayList`、`String` / `Object`），
 *   统一按"方法名 + 参数个数 + 参数可赋值"匹配，避免 `NoSuchMethodError`；
 * - 实例句柄是字符串 id，JS 侧持有；`unload` 释放 classloader；
 * - 同一 jar 只下载一次，多源共用（缓存目录按 md5 命名）。
 */
@CapacitorPlugin(name = "Spider")
public class SpiderPlugin extends Plugin {

    private static final String TAG = "SpiderPlugin";
    
    /** Gson 实例用于 JSON 序列化 */
    private static final Gson GSON = new Gson();
    private static final String SPIDER_PACKAGE = "com.github.catvod.spider.";
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final long MAX_JAR_BYTES = 8L * 1024 * 1024;
    /** jar 下载尝试次数（含首次）：慢/抖动主机（z.wiki、kstore 系）单次失败很常见 */
    private static final int JAR_DOWNLOAD_ATTEMPTS = 3;
    /** 重试退避基数，第 n 次重试等 n × 该值 */
    private static final long JAR_RETRY_BACKOFF_MS = 800;

    /**
     * 条件日志：根据开关决定是否输出详细信息，减少生产环境的日志噪音。
     * 用法：d("key=value", optionalExtraInfo)
     * 
     * 日志写入本地文件（filesDir/logs/），自动清理 3 天前的数据。
     * 关闭开关时仍记录 W/E，保证崩溃可诊断。
     */
    private void d(String message) {
        SpiderLogStore store = SpiderLogStore.get();
        if (store != null) store.log("D", TAG, message);
        else Log.d(TAG, message);
    }

    private void d(String format, Object... args) {
        SpiderLogStore store = SpiderLogStore.get();
        String message = String.format(format, args);
        if (store != null) store.log("D", TAG, message);
        else Log.d(TAG, message);
    }

    /**
     * 爬虫调用（下载 jar / DexClassLoader / 爬虫内部 HTTP）必须跑在独立线程池：
     * Capacitor 的插件方法全部走 bridge 的单一 taskHandler 线程（Bridge.java post 到
     * 同一个 Handler），同步执行会串行阻塞所有 JS→原生调用（搜索、播放、网络派发
     * 全部排队），表现为「搜索极慢 / 播放超时 / 首页永远骨架屏」。
     */
    private final ExecutorService spiderExecutor = Executors.newCachedThreadPool();
    /** 看门狗：超时后先给 JS 侧回错，避免调用方无限等待（任务线程本身无法强中断） */
    private final Handler watchdog = new Handler(Looper.getMainLooper());
    private static final long LOAD_TIMEOUT_MS = 75_000;
    private static final long INVOKE_TIMEOUT_MS = 30_000;
    private static final long PROXY_TIMEOUT_MS = 25_000;

    /** 后台任务接口（允许抛异常，统一转 call.reject） */
    private interface SpiderTask {
        void run() throws Exception;
    }

    /**
     * 把爬虫任务提交到线程池执行，带看门狗超时。
     * 成功路径在任务内部 resolve；失败或超时由这里统一 reject（二选一，不重复回调）。
     */
    private void runSpider(PluginCall call, String op, long timeoutMs, SpiderTask task) {
        final AtomicBoolean settled = new AtomicBoolean(false);
        final String label = "爬虫" + op;
        
        final Runnable timeoutTask = () -> {
            if (settled.compareAndSet(false, true)) {
                Log.w(TAG, op + " timeout after " + timeoutMs + "ms");
                call.reject(label + "超时（" + (timeoutMs / 1000) + " 秒），请重试或更换源");
            }
        };
        watchdog.postDelayed(timeoutTask, timeoutMs);
        spiderExecutor.execute(() -> {
            // 爬虫内壳子系（AppTT 等）会同步请求 127.0.0.1:9978，执行前确保本地代理活着
            SpiderProxyServer.ensureAlive();
            try {
                task.run();
                if (settled.compareAndSet(false, true)) {
                    watchdog.removeCallbacks(timeoutTask);
                }
            } catch (Throwable e) {
                if (settled.compareAndSet(false, true)) {
                    watchdog.removeCallbacks(timeoutTask);
                    Log.w(TAG, op + " failed", e);
                    call.reject(label + "失败: " + describeFailure(e));
                }
            }
        });
    }

    /**
     * 把反射/爬虫异常转成可读原因。
     *
     * 反射调用的异常一律包成 `InvocationTargetException`，而它的 `getMessage()` 是 null，
     * 直接拼接会让用户只看到「爬虫调用失败: null」——完全无法判断是源坏了还是 App 不支持。
     * 这里剥掉包装层，给出「类名: 消息」，并对常见形态（缺方法/缺类/ABI 不符）给出定论。
     */
    private static String describeFailure(Throwable e) {
        Throwable cause = e;
        while ((cause instanceof java.lang.reflect.InvocationTargetException
                || cause instanceof ExceptionInInitializerError)
                && cause.getCause() != null) {
            cause = cause.getCause();
        }
        String message = cause.getMessage();
        String type = cause.getClass().getSimpleName();
        if (cause instanceof UnsatisfiedLinkError) {
            // 预检抛出的文案已经说明架构不符；原生加载失败时补一句设备提示
            String detail = message == null ? "" : message;
            if (detail.contains("主架构") || detail.contains("模拟器")) return detail;
            return "该源依赖的原生库无法在当前设备加载（多为 ARM 专有源，模拟器不可用）：" + detail;
        }
        if (cause instanceof NoSuchMethodError) {
            return "爬虫调用了未实现的框架方法（" + message + "），App 版本偏旧";
        }
        if (cause instanceof NoClassDefFoundError || cause instanceof ClassNotFoundException) {
            return "爬虫类缺失（" + message + "），源配置与 jar 不匹配";
        }
        if (cause instanceof OutOfMemoryError) {
            return "内存不足，jar 过大";
        }
        if (message == null || message.isEmpty()) {
            // 至少给类型名，避免用户只看到 null
            StackTraceElement[] stack = cause.getStackTrace();
            String site = stack.length > 0 ? " @ " + stack[0].getClassName() : "";
            return type + site;
        }
        return type + ": " + message;
    }

    /** 已加载实例：handle → 实例上下文 */
    private final Map<String, LoadedSpider> loaded = new ConcurrentHashMap<>();
    /** jar 地址 → 已下载的 jar 文件，避免重复下载 */
    private final Map<String, File> jarCache = new ConcurrentHashMap<>();
    /** jar 文件 → dex 输出目录，避免重复解包 */
    private final Map<String, File> dexCache = new ConcurrentHashMap<>();
    /** P0-5: jar 文件 → DexClassLoader 池，复用避免重复加载 */
    private final Map<String, dalvik.system.DexClassLoader> loaderCache = new ConcurrentHashMap<>();
    private int handleSeq = 0;

    /**
     * 本地代理当前归属的爬虫句柄：JS 侧在调用 playerContent 前设置，
     * 9978 代理请求优先路由给该爬虫；避免其它爬虫（如移动•4K）劫持不属于自己的 do。
     * 置空表示无归属，回退到遍历全部已加载爬虫。
     */
    private static volatile String currentOwner = null;

    /**
     * Guard jar 初始化锁：按 jar 文件名加锁。
     *
     * 饭太硬 spider.jar 是 guard 加固类型，多个爬虫源（csp_BiliGuard / csp_AppSxGuard /
     * csp_DouDouGuard 等）共用同一个 jar。JS 侧在导入订阅后会并发 load 所有源，
     * 多个线程同时进入 loadSpider → Init.init() → DexNative.<clinit>()。
     *
     * DexNative 的静态初始化块从 jar assets 提取 ftyguard_v8.so 到 cache/.fty<random>
     * 临时文件再 System.load。并发时第一个线程可能还没写完文件，其他线程的 System.load
     * 就找不到文件 → UnsatisfiedLinkError。虽然 Java <clinit> 理论上只执行一次，但
     * ART 在 <clinit> 抛 Error 后会重试，导致行为不确定：有的线程成功有的失败。
     *
     * 这里用 per-jar-file 的锁保证 Init.init() 串行执行，加上已初始化标记避免重复调用。
     */
    private final Map<String, Object> guardInitLocks = new ConcurrentHashMap<>();
    /** jar 文件名 → 是否已成功完成 guard 初始化 */
    private final Map<String, Boolean> guardInitDone = new ConcurrentHashMap<>();

    /**
     * TVBox 爬虫类名解析：订阅里的 `api` 形如 `csp_XBPQ` / `py_cctv_full`，
     * jar 内的实际类是 `com.github.catvod.spider.XBPQ`（去掉 `csp_`/`py_` 前缀）。
     * 少数 jar 直接放同名类（`csp_XBPQ` 本身），两种都尝试。
     */
    private static String resolveSpiderClassName(String api, ClassLoader loader) throws ClassNotFoundException {
        String stripped = api.replaceFirst("^(csp|py)_", "");
        String[] candidates = {
                SPIDER_PACKAGE + stripped,
                SPIDER_PACKAGE + api,
                api,
        };
        ClassNotFoundException last = null;
        for (String candidate : candidates) {
            try {
                loader.loadClass(candidate);
                return candidate;
            } catch (ClassNotFoundException e) {
                last = e;
            }
        }
        throw last != null ? last : new ClassNotFoundException(api);
    }

    private static class LoadedSpider {
        final Spider spider;
        final String api;
        final File dexDir;
        final String jarMd5;

        LoadedSpider(Spider spider, String api, File dexDir, String jarMd5) {
            this.spider = spider;
            this.api = api;
            this.dexDir = dexDir;
            this.jarMd5 = jarMd5;
        }
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        call.resolve(ret);
    }

    /**
     * 设置详细日志开关（可通过前端调用）
     */
    @PluginMethod
    public void setDebugLog(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        SpiderLogStore store = SpiderLogStore.get();
        if (store == null) {
            call.reject("Log store not initialized");
            return;
        }
        store.setEnabled(enabled);
        
        JSObject ret = new JSObject();
        ret.put("enabled", store.isEnabled());
        call.resolve(ret);
    }

    /**
     * 获取当前详细日志开关状态及文件统计
     */
    @PluginMethod
    public void getDebugLogStatus(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        JSObject ret = new JSObject();
        if (store == null) {
            ret.put("enabled", false);
            ret.put("fileCount", 0);
            ret.put("totalBytes", 0);
            ret.put("retentionDays", 0);
            call.resolve(ret);
            return;
        }
        ret.put("enabled", store.isEnabled());
        File[] files = store.listFiles();
        ret.put("fileCount", files.length);
        ret.put("totalBytes", store.totalBytes());
        ret.put("retentionDays", 3);
        call.resolve(ret);
    }

    /**
     * 手动清理过期日志（可通过前端调用）
     */
    @PluginMethod
    public void cleanLogs(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        if (store == null) {
            call.reject("Log store not initialized");
            return;
        }
        
        SpiderLogStore.CleanResult result = store.cleanOldLogs();
        
        JSObject ret = new JSObject();
        ret.put("cleanedCount", result.cleanedCount);
        ret.put("freedBytes", result.freedBytes);
        call.resolve(ret);
    }

    /**
     * 列出所有日志文件
     */
    @PluginMethod
    public void listLogFiles(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        JSObject ret = new JSObject();
        if (store == null) {
            ret.put("files", new JSArray());
            call.resolve(ret);
            return;
        }
        File[] files = store.listFiles();
        JSArray arr = new JSArray();
        for (File f : files) {
            JSObject obj = new JSObject();
            obj.put("name", f.getName());
            obj.put("size", f.length());
            obj.put("mtime", f.lastModified());
            arr.put(obj);
        }
        ret.put("files", arr);
        call.resolve(ret);
    }

    /**
     * 导出日志：合并所有日志到单文件，返回 FileProvider URI
     */
    @PluginMethod
    public void exportLogs(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        if (store == null) {
            call.reject("Log store not initialized");
            return;
        }
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("No context available");
            return;
        }
        try {
            File exported = store.exportMerged();
            String authority = ctx.getPackageName() + ".fileprovider";
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(ctx, authority, exported);
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("path", exported.getAbsolutePath());
            ret.put("size", exported.length());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Export failed: " + e.getMessage());
        }
    }

    /**
     * 增量读取日志文件尾部。
     * 参数：file（可选，文件名）、offset（可选，字节偏移）、maxBytes（可选，默认 256KB）
     */
    @PluginMethod
    public void readLogTail(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        if (store == null) {
            call.reject("Log store not initialized");
            return;
        }
        String fileName = call.getString("file", null);
        long offset = call.getLong("offset", 0L);
        int maxBytes = call.getInt("maxBytes", 256 * 1024);
        try {
            SpiderLogStore.TailResult r = store.readTail(fileName, offset, maxBytes);
            JSObject ret = new JSObject();
            ret.put("file", r.file);
            ret.put("size", r.size);
            ret.put("offset", r.offset);
            ret.put("text", r.text);
            ret.put("reset", r.reset);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Read log tail failed: " + e.getMessage());
        }
    }

    /**
     * 清空全部日志文件（查看页"清空"按钮用）
     */
    @PluginMethod
    public void clearAllLogs(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        if (store == null) {
            call.reject("Log store not initialized");
            return;
        }
        store.clearAll();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * 批量写入 JS 侧日志。
     * 参数：entries（数组，每条 {level, tag, message, ts}）、source（可选，如 "JS"）
     */
    @PluginMethod
    public void appendLogs(PluginCall call) {
        SpiderLogStore store = SpiderLogStore.get();
        if (store == null) {
            call.reject("Log store not initialized");
            return;
        }
        JSArray entriesArr = call.getArray("entries", new JSArray());
        String source = call.getString("source", "JS");
        try {
            List<Map<String, Object>> entries = new ArrayList<>();
            for (int i = 0; i < entriesArr.length(); i++) {
                Object item = entriesArr.get(i);
                if (!(item instanceof JSObject)) continue;
                JSObject e = (JSObject) item;
                Map<String, Object> m = new HashMap<>();
                m.put("level", e.optString("level", "D"));
                m.put("tag", e.optString("tag", "app"));
                m.put("message", e.optString("message", ""));
                m.put("ts", e.optLong("ts", 0));
                entries.add(m);
            }
            store.appendBatch(entries, source);
            JSObject ret = new JSObject();
            ret.put("written", entries.size());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Append logs failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void load(PluginCall call) {
        String jarUrl = call.getString("jarUrl");
        String api = call.getString("api");
        String initExt = call.getString("initExt", "");
        String userAgent = call.getString("userAgent", null);

        if (jarUrl == null || jarUrl.isEmpty()) {
            call.reject("jarUrl is required");
            return;
        }
        if (api == null || api.isEmpty()) {
            call.reject("api is required");
            return;
        }

        runSpider(call, "加载", LOAD_TIMEOUT_MS, () -> {
            // 首次加载爬虫时拉起 127.0.0.1:9978 本地代理：壳子系爬虫（AppTT 等）在
            // playerContent 内部会同步请求它换直链，晚了就会 ECONNREFUSED 降级
            SpiderProxyServer.start(this::routeProxy);
            LoadedSpider result = loadSpider(getContext(), jarUrl, api, initExt, userAgent);
            String handle = "sp-" + (++handleSeq);
            loaded.put(handle, result);
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        });
    }

    /**
     * 设置本地代理当前归属的爬虫句柄（方向3：owner 机制）。
     * JS 侧在调用 playerContent 前设置，使后续 9978 代理请求优先路由给该爬虫。
     */
    @PluginMethod
    public void setCurrentOwner(PluginCall call) {
        String handle = call.getString("handle");
        if (handle == null || handle.isEmpty()) {
            currentOwner = null;
            Log.i(TAG, "proxy owner cleared");
        } else if (!loaded.containsKey(handle)) {
            call.reject("spider instance not found: " + handle);
            return;
        } else {
            currentOwner = handle;
            LoadedSpider target = loaded.get(handle);
            Log.i(TAG, "proxy owner set -> " + target.spider.getClass().getSimpleName() + " (" + handle + ")");
        }
        JSObject ret = new JSObject();
        ret.put("owner", currentOwner);
        call.resolve(ret);
    }

    /**
     * 9978 本地代理路由：优先 owner，其次遍历已加载爬虫调 proxy(params)。
     * 代理请求不带 handle，TVBox 原版也是全量遍历（多数爬虫对不认识的 do 立即返回 null）。
     * 方向3：先尝试 currentOwner，避免被其它爬虫（如移动•4K）劫持。
     * P0-2：do=m3u8 只尝试 owner，未认领则交还宿主 passThrough（避免被无关爬虫劫持）。
     */
    private Object[] routeProxy(Map<String, String> params) {
        String doParam = params.get("do");
        int proxyCapable = 0;
        
        // 方向3：优先尝试 currentOwner
        String owner = currentOwner;
        if (owner != null) {
            LoadedSpider target = loaded.get(owner);
            if (target != null) {
                Object[] result = tryProxy(target, params, doParam);
                if (result != null) return result;
                proxyCapable++;
            }
        }
        
        // P0-2：do=m3u8 只尝试 owner，未认领则交还宿主 passThrough 直取上游清单
        if ("m3u8".equals(doParam)) {
            Log.i(TAG, "proxy do=m3u8 not claimed by owner, defer to host passthrough");
            return null;
        }
        
        // 回退：遍历其他已加载爬虫
        for (Map.Entry<String, LoadedSpider> entry : loaded.entrySet()) {
            String handle = entry.getKey();
            if (handle.equals(owner)) continue; // 已尝试过
            LoadedSpider target = entry.getValue();
            Object[] result = tryProxy(target, params, doParam);
            if (result != null) {
                proxyCapable++;
                return result;
            }
            proxyCapable++;
        }
        Log.w(TAG, "proxy do=" + doParam + " -> no spider claimed it ("
                + loaded.size() + " loaded, " + proxyCapable + " with proxy)");
        return null;
    }
    
    /**
     * 尝试调用单个爬虫的 proxy 方法；返回非空表示认领，null 表示未认领或失败。
     */
    private Object[] tryProxy(LoadedSpider target, Map<String, String> params, String doParam) {
        try {
            Method method;
            try {
                method = target.spider.getClass().getMethod("proxy", Map.class);
            } catch (NoSuchMethodException e) {
                return null;
            }
            method.setAccessible(true);
            Object result = method.invoke(target.spider, params);
            if (result instanceof Object[]) {
                Object[] arr = (Object[]) result;
                if (arr.length > 0 && arr[0] != null && String.valueOf(arr[0]).trim().length() > 0) {
                    Log.i(TAG, "proxy do=" + doParam + " -> " + target.spider.getClass().getSimpleName());
                    return arr;
                }
            } else if (result instanceof String && !((String) result).trim().isEmpty()) {
                Log.i(TAG, "proxy do=" + doParam + " -> " + target.spider.getClass().getSimpleName());
                return new Object[]{result, null};
            }
        } catch (Throwable ignored) {
            // 该爬虫 proxy 执行失败 → 试下一个
        }
        return null;
    }

    @PluginMethod
    public void invoke(PluginCall call) {
        String handle = call.getString("handle");
        String method = call.getString("method");
        JSArray args = call.getArray("args", new JSArray());
        JSObject arrayArgs = call.getObject("arrayArgs", null);

        LoadedSpider target = handle == null ? null : loaded.get(handle);
        if (target == null) {
            call.reject("spider instance not found");
            return;
        }

        // 参数转换较轻量，先在桥接线程做完，重活（爬虫执行）进线程池
        Object[] javaArgs = toJavaArgs(args, arrayArgs);
        runSpider(call, "调用", INVOKE_TIMEOUT_MS, () -> {
            // REV-24：哨兵包裹爬虫调用——native crash 时下次启动可检测到
            try {
                JSONObject sentinelDetails = new JSONObject();
                sentinelDetails.put("jarMd5", target.jarMd5 != null ? target.jarMd5 : "");
                sentinelDetails.put("api", target.api);
                sentinelDetails.put("method", method);
                CrashSentinel.begin("spider.invoke", sentinelDetails);
            } catch (Exception e) {
                Log.w(TAG, "failed to write invoke sentinel", e);
            }
            try {
                String json = invokeSpider(target, method, javaArgs);
                CrashSentinel.end();
                JSObject ret = new JSObject();
                ret.put("json", json);
                ret.put("logs", new JSArray(Arrays.asList(targetLogs())));
                call.resolve(ret);
            } catch (Exception e) {
                CrashSentinel.end();
                throw e;
            }
        });
    }

    @PluginMethod
    public void proxy(PluginCall call) {
        String handle = call.getString("handle");
        String url = call.getString("url");

        LoadedSpider target = handle == null ? null : loaded.get(handle);
        if (target == null) {
            call.reject("spider instance not found");
            return;
        }

        runSpider(call, "代理", PROXY_TIMEOUT_MS, () -> {
            Object[] result = callProxy(target, url);
            JSObject ret = new JSObject();
            ret.put("url", result.length > 0 && result[0] != null ? String.valueOf(result[0]) : null);
            Map<String, String> headers = new HashMap<>();
            if (result.length > 1 && result[1] instanceof Map) {
                //noinspection unchecked
                headers.putAll((Map<String, String>) result[1]);
            }
            JSObject headerObj = new JSObject();
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                headerObj.put(entry.getKey(), entry.getValue());
            }
            ret.put("headers", headerObj);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        String handle = call.getString("handle");
        LoadedSpider target = handle == null ? null : loaded.remove(handle);
        // 方向3：卸载时清除 owner，避免悬空引用
        if (handle != null && handle.equals(currentOwner)) {
            currentOwner = null;
            Log.i(TAG, "proxy owner cleared (unloaded)");
        }
        JSObject ret = new JSObject();
        ret.put("released", target != null);
        call.resolve(ret);
    }

    /** REV-24：查询当前隔离名单（供前端健康管理页展示） */
    @PluginMethod
    public void getQuarantined(PluginCall call) {
        List<String> list = CrashSentinel.getQuarantined(getContext());
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        for (String sig : list) {
            arr.put(sig);
        }
        ret.put("items", arr);
        call.resolve(ret);
    }

    /** REV-24：手动解除某个签名的隔离（供前端健康管理页操作） */
    @PluginMethod
    public void unquarantine(PluginCall call) {
        String signature = call.getString("signature");
        if (signature == null || signature.isEmpty()) {
            call.reject("signature is required");
            return;
        }
        CrashSentinel.unquarantine(getContext(), signature);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** REV-24 P2：查询安全模式状态 */
    @PluginMethod
    public void getSafeMode(PluginCall call) {
        boolean active = MainApplication.isSafeMode(getContext());
        JSObject ret = new JSObject();
        ret.put("active", active);
        call.resolve(ret);
    }

    /** REV-24 P2：手动退出安全模式 */
    @PluginMethod
    public void exitSafeMode(PluginCall call) {
        MainApplication.exitSafeMode(getContext());
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        watchdog.removeCallbacksAndMessages(null);
        spiderExecutor.shutdownNow();
        SpiderProxyServer.stop();
        loaded.clear();
        jarCache.clear();
        dexCache.clear();
        guardInitLocks.clear();
        guardInitDone.clear();
        currentOwner = null;
    }

    /* ---------------- 内部 ---------------- */

    private String[] targetLogs() {
        return SpiderDebug.drain();
    }

    /**
     * JS 数组 → Java 反射参数（保持位置参数顺序）。
     * `arrayArgs` 的键是参数下标：List 形参（如 detailContent 的 ids）必须走这里，
     * 因为 Capacitor 桥接会把嵌套数组展平成字符串。
     */
    private static Object[] toJavaArgs(JSArray args, JSObject arrayArgs) {
        List<Object> out = new ArrayList<>();
        try {
            for (int i = 0; i < args.length(); i++) {
                // 显式数组参数优先
                if (arrayArgs != null && arrayArgs.has(String.valueOf(i))) {
                    out.add(toJavaListFromJson(arrayArgs.getJSONArray(String.valueOf(i))));
                    continue;
                }
                Object value = args.get(i);
                if (value == null) {
                    out.add("");
                } else if (value instanceof JSObject) {
                    // 对象参数（如 categoryContent 的 HashMap）转成 Java Map
                    out.add(toJavaMap((JSObject) value));
                } else if (value instanceof org.json.JSONObject) {
                    // 桥接层可能给的是原生 JSONObject
                    out.add(toJavaMapFromJson((org.json.JSONObject) value));
                } else if (value instanceof JSArray) {
                    // 数组参数（如 detailContent 的 ids / playerContent 的 vipFlags）转成 Java List
                    out.add(toJavaList((JSArray) value));
                } else if (value instanceof org.json.JSONArray) {
                    out.add(toJavaListFromJson((org.json.JSONArray) value));
                } else if (value instanceof String && ((String) value).startsWith("[") && ((String) value).endsWith("]")) {
                    // 防御：序列化后的 JSON 数组字符串也转成 List
                    out.add(parseJsonArrayString((String) value));
                } else if (value instanceof Boolean) {
                    out.add(value);
                } else if (value instanceof Integer || value instanceof Long || value instanceof Double) {
                    out.add(value);
                } else {
                    out.add(String.valueOf(value));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "args convert failed", e);
        }
        return out.toArray();
    }

    private static Map<String, String> toJavaMapFromJson(org.json.JSONObject obj) {
        Map<String, String> map = new HashMap<>();
        try {
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = obj.get(key);
                map.put(key, value == null ? "" : String.valueOf(value));
            }
        } catch (Exception e) {
            Log.w(TAG, "map convert failed", e);
        }
        return map;
    }

    private static List<String> toJavaListFromJson(org.json.JSONArray arr) {
        List<String> list = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) {
                Object value = arr.get(i);
                list.add(value == null ? "" : String.valueOf(value));
            }
        } catch (Exception e) {
            Log.w(TAG, "list convert failed", e);
        }
        return list;
    }

    private static Map<String, String> toJavaMap(JSObject obj) {
        Map<String, String> map = new HashMap<>();
        try {
            // JSObject.keys() 返回 Iterator，直接遍历
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = obj.get(key);
                map.put(key, value == null ? "" : String.valueOf(value));
            }
        } catch (Exception e) {
            Log.w(TAG, "map convert failed", e);
        }
        return map;
    }

    private static List<String> parseJsonArrayString(String raw) {
        List<String> list = new ArrayList<>();
        try {
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                Object value = arr.get(i);
                list.add(value == null ? "" : String.valueOf(value));
            }
        } catch (Exception e) {
            Log.w(TAG, "json array parse failed", e);
            list.add(raw);
        }
        return list;
    }

    private static List<String> toJavaList(JSArray arr) {
        List<String> list = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) {
                Object value = arr.get(i);
                list.add(value == null ? "" : String.valueOf(value));
            }
        } catch (Exception e) {
            Log.w(TAG, "list convert failed", e);
        }
        return list;
    }

    /**
     * 加载前 ABI 预检：jar 里带 native 库但当前设备架构跑不了时，直接拒绝加载。
     *
     * 为什么必须在加载前做：ftyguard 系 jar 的 `DexNative.getSpider` 是 JNI 实现，
     * 它在 `.so` 加载失败 / ClassLoader 为空时会触发 `JNI DETECTED ERROR` →
     * `SIGABRT`，**整个进程崩溃**（Java 的 try/catch 完全无效）。实测 MuMu（x86_64）
     * 上导入饭太硬后，后台预热直接让 App 闪退。
     *
     * 判定：扫 jar 的 `lib/<abi>/` 与 `assets/*.so`，读 ELF 头取 e_machine；
     * 与 `Build.SUPPORTED_ABIS` 一个都不匹配就抛 `UnsatisfiedLinkError`
     * （由 `describeFailure` 转成「该源依赖 ARM 原生库」的明确文案）。
     */
    private static void assertNativeAbiSupported(File jarFile) throws UnsatisfiedLinkError {
        java.util.Set<String> jarAbis;
        try {
            jarAbis = nativeAbisOf(jarFile);
        } catch (Exception e) {
            // 解析失败不阻断（纯 Java jar 是常态），交给后续加载路径
            Log.w(TAG, "jar abi precheck skipped: " + e.getMessage());
            return;
        }
        Log.i(TAG, "jar abi precheck: " + jarFile.getName() + " -> " + jarAbis
                + " device=" + java.util.Arrays.toString(android.os.Build.SUPPORTED_ABIS));
        if (jarAbis.isEmpty()) return;

        // 用**主 ABI**（第一个）判断，而不是 SUPPORTED_ABIS 全集：
        // MuMu 等模拟器带 ARM 转译层，SUPPORTED_ABIS 里会列出 arm64-v8a，
        // 但 ARM .so 在转译下跑 ftyguard 这类反调试/反模拟器 native 代码会直接
        // SIGABRT（实测 JNI DETECTED ERROR → 进程崩溃，catch 不住）。
        String primaryAbi = android.os.Build.SUPPORTED_ABIS.length > 0
                ? android.os.Build.SUPPORTED_ABIS[0]
                : "";
        boolean primaryMatches = primaryAbi.length() > 0 && jarAbis.contains(primaryAbi);
        if (primaryMatches) return;
        String message = "jar 内原生库 " + jarAbis + " 与设备主架构 " + primaryAbi
                + " 不符（模拟器转译层无法运行该源的原生代码）";
        Log.w(TAG, message);
        throw new UnsatisfiedLinkError(message);
    }

    /** 扫描 jar 内 native 库的 ABI 集合（`lib/<abi>/*.so` 与 `assets/*.so` 的 ELF 头） */
    private static java.util.Set<String> nativeAbisOf(File jarFile) throws Exception {
        java.util.Set<String> abis = new java.util.LinkedHashSet<>();
        java.util.zip.ZipFile zip = new java.util.zip.ZipFile(jarFile);
        try {
            java.util.Enumeration<? extends java.util.zip.ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                java.util.zip.ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (entry.isDirectory()) continue;
                if (name.startsWith("lib/") && name.endsWith(".so")) {
                    // lib/arm64-v8a/x.so → arm64-v8a
                    String[] parts = name.split("/");
                    if (parts.length >= 3) abis.add(parts[1]);
                    continue;
                }
                // 非标准位置：ftyguard 把 ARM .so 放在 assets/（还有加密的 .guard 载荷，
                // 运行时才解密落盘）。文件名不可靠，只能按 ELF 头判断。
                // 注意：getSize() 对部分压缩条目是 -1，不能用它筛，直接读头。
                String abi = elfAbiOf(zip, entry);
                if (abi != null) abis.add(abi);
            }
        } finally {
            zip.close();
        }
        return abis;
    }

    /** 读 ELF 头（e_machine）→ Android ABI 名；非 ELF 返回 null */
    private static String elfAbiOf(java.util.zip.ZipFile zip, java.util.zip.ZipEntry entry) {
        try (InputStream in = zip.getInputStream(entry)) {
            byte[] header = new byte[20];
            int read = in.read(header);
            if (read < 20) return null;
            // ELF magic
            if (header[0] != 0x7F || header[1] != 'E' || header[2] != 'L' || header[3] != 'F') return null;
            int machine = (header[18] & 0xFF) | ((header[19] & 0xFF) << 8);
            switch (machine) {
                case 0x28:
                    return "armeabi-v7a";
                case 0xB7:
                    return "arm64-v8a";
                case 0x3E:
                    return "x86_64";
                case 0x03:
                    return "x86";
                default:
                    return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 下载 + 加载 + 初始化爬虫。
     * jar 地址允许 `url;md5;hash` 形式（TVBox 约定）。
     */
    private LoadedSpider loadSpider(
            Context context, String jarUrl, String api, String initExt, String userAgent) throws Exception {
        // REV-24 P2：安全模式下拒绝加载 jar（高频崩溃源）
        if (MainApplication.isSafeMode(context)) {
            throw new IllegalStateException("safe mode active: spider loading disabled");
        }
        String cleanUrl = jarUrl;
        String expectedMd5 = null;
        int sep = jarUrl.indexOf(";md5;");
        if (sep > 0) {
            cleanUrl = jarUrl.substring(0, sep);
            expectedMd5 = jarUrl.substring(sep + 5).trim();
        }

        File jarFile = jarCache.get(cleanUrl);
        if (jarFile == null) {
            purgeCorruptJarCache(context);
            jarFile = ensureJarFile(context, cleanUrl, expectedMd5);
            jarCache.put(cleanUrl, jarFile);
        }

        // REV-24：计算 jar MD5 用于哨兵隔离签名
        String jarMd5 = "";
        try {
            jarMd5 = md5OfFile(jarFile);
        } catch (Exception e) {
            Log.w(TAG, "failed to compute jar md5", e);
        }

        File dexDir = dexCache.get(jarFile.getName());
        if (dexDir == null) {
            dexDir = new File(context.getFilesDir(), "spider-dex/" + jarFile.getName());
            if (!dexDir.exists() && !dexDir.mkdirs()) {
                throw new IllegalStateException("cannot create dex dir");
            }
            dexCache.put(jarFile.getName(), dexDir);
        }

        // REV-24：隔离检查——同 jar+api 签名若已崩溃 2 次被隔离，直接拒绝加载
        String quarantineSig = "spider:" + jarMd5 + ":" + api;
        if (CrashSentinel.isQuarantined(context, quarantineSig)) {
            throw new IllegalStateException("spider quarantined (crash x2): " + quarantineSig);
        }

        // REV-24：写哨兵——若后续 DexClassLoader/init 触发 native crash，下次启动可检测到
        try {
            JSONObject sentinelDetails = new JSONObject();
            sentinelDetails.put("jarMd5", jarMd5);
            sentinelDetails.put("api", api);
            sentinelDetails.put("jarUrl", cleanUrl);
            CrashSentinel.begin("spider.load", sentinelDetails);
        } catch (Exception e) {
            Log.w(TAG, "failed to write sentinel", e);
        }

        // 加载前做 ABI 预检：带 native 库的 jar（ftyguard 系列）如果只有 ARM 版本，
        // 在 x86 模拟器上会由 native 代码触发 JNI abort（SIGABRT 杀进程，catch 不住）。
        // 必须在 DexClassLoader 之前拒绝，否则一个后台预热就能把整个 App 打崩。
        assertNativeAbiSupported(jarFile);

        // P0-5: 复用 DexClassLoader，避免同一 jar 重复加载
        String jarKey = jarFile.getAbsolutePath();
        dalvik.system.DexClassLoader loader = loaderCache.get(jarKey);
        boolean loaderReused = loader != null;
        if (loader == null) {
            ClassLoader parent = context.getClassLoader();
            loader = new dalvik.system.DexClassLoader(
                    jarFile.getAbsolutePath(),
                    dexDir.getAbsolutePath(),
                    null,
                    parent);
            loaderCache.put(jarKey, loader);
            Log.i(TAG, "created new DexClassLoader for jar: " + jarKey);
        } else {
            Log.i(TAG, "reusing DexClassLoader for jar: " + jarKey);
        }

        // jar 自带 com.github.catvod.spider.Init（静态字段 Application c 由 TVBox 宿主注入）。
        // 不注入时 Init.context() 返回 null，爬虫在 detailContent 等路径里
        // 调 context.getPackageName() 会 NPE（YunDuo 等一大批爬虫的实际失败原因）。
        injectCatvodInit(loader, context);

        // P0-A: Guard Jar 必须在实例化前调用 Init.init(Application)。
        // Guard 类型 jar（BaseSpiderGuard 系）的构造函数会走 Init.getSpider() → Init.loader()，
        // 而 loader 字段只有 Init.init(Context) 才会赋值。我们此前只注入 Application 字段，
        // 导致真机 ARM64 上构造函数读到 null → JNI abort（SIGABRT 杀进程，Java catch 无效）。
        // 非 guard jar 绝不能调用 Init.init()：那会连带拉起 jar 自带的悬浮球/本地代理。
        if (isGuardJar(jarFile, loader)) {
            initGuardJar(loader, context, jarFile, api);
        }

        String className = resolveSpiderClassName(api, loader);
        Class<?> clazz = loader.loadClass(className);
        Object instance = clazz.getDeclaredConstructor().newInstance();
        if (!(instance instanceof Spider)) {
            throw new ClassCastException(api + " is not a Spider");
        }
        Spider spider = (Spider) instance;

        // 致命 init 失败（LinkageError 类：gson/okhttp 等宿主依赖版本不匹配）时
        // 必须拒绝该源：guard jar 半初始化后继续 invoke 会在 jar 内 native 代码
        // 触发 SIGSEGV/SIGABRT，Java 层无法捕获（真机 CrashSentinel 实证）。
        Throwable initFatal = invokeInit(spider, new GuardedSpiderContext(context), initExt, api, loader);
        if (initFatal != null) {
            // 主动清除哨兵：这是可预期的加载失败而非崩溃
            CrashSentinel.end();
            throw new IllegalStateException(
                    "爬虫初始化失败（" + api + "）：宿主依赖版本不匹配，已禁用该源（"
                            + initFatal.getClass().getSimpleName() + ": " + initFatal.getMessage() + "）",
                    initFatal);
        }
        // 同样按实例类型调用，确保爬虫拿到 SpiderApi（基类 stub 是空实现）
        try {
            Method initApi = spider.getClass().getMethod("initApi", SpiderApi.class);
            initApi.invoke(spider, SpiderApi.get());
        } catch (Exception e) {
            Log.w(TAG, "initApi failed", e);
        }
        if (userAgent != null && !userAgent.isEmpty()) {
            applyUserAgent(spider, userAgent);
        }
        Log.i(TAG, "loaded spider: " + api + (loaderReused ? " (reused loader)" : ""));
        CrashSentinel.end();
        return new LoadedSpider(spider, api, dexDir, jarMd5);
    }

    /**
     * 给 jar 内 `com.github.catvod.spider.Init` 注入宿主 Context。
     *
     * TVBox 宿主在启动时把 Application 写进 Init 的静态字段（不同 jar 混淆后字段名
     * 可能是 `c` / `context` / 其他），`Init.context()` 返回它。我们作为宿主必须做同样的
     * 注入，否则 `Init.context()` 返回 null：
     *   - 爬虫里 `Init.context().getPackageName()` 直接 NPE（YunDuo 等 detailContent）；
     *   - 依赖 context 的缓存/文件路径全部失效。
     *
     * 做法：反射调用 `Init.get()`（存在时）拿到单例，再把所有 `Application`/`Context`
     * 类型的静态字段填上；没有 get() 就逐个静态字段填。任何失败都只记日志——
     * 大多数爬虫不用 context，不能因此阻断加载。
     */
    private static void injectCatvodInit(ClassLoader loader, Context context) {
        try {
            Class<?> initClass = loader.loadClass("com.github.catvod.spider.Init");
            Application app = (Application) context.getApplicationContext();
            if (app == null) app = (Application) context;

            // 先把实例方法 Init.get() 拿到的单例也填一遍（部分 jar 字段是实例级）
            Object instance = null;
            try {
                Method get = initClass.getMethod("get");
                instance = get.invoke(null);
            } catch (Exception ignored) {
                // 没有 get() 的 jar 只填静态字段
            }

            int filled = 0;
            for (Field field : initClass.getDeclaredFields()) {
                Class<?> type = field.getType();
                boolean wantsApp = Application.class.isAssignableFrom(type);
                boolean wantsCtx = Context.class.isAssignableFrom(type);
                if (!wantsApp && !wantsCtx) continue;
                if (java.lang.reflect.Modifier.isStatic(field.getModifiers())) {
                    field.setAccessible(true);
                    field.set(null, app);
                    filled++;
                } else if (instance != null) {
                    field.setAccessible(true);
                    field.set(instance, app);
                    filled++;
                }
            }
            Log.i(TAG, "injected catvod Init context (" + filled + " field(s))");
        } catch (ClassNotFoundException e) {
            // 该 jar 不含 Init，正常
        } catch (Exception e) {
            Log.w(TAG, "inject catvod Init failed", e);
        }
    }

    /**
     * 预创建 guard jar 的工作目录。
     *
     * AiWex/MyCrypto 系 guard jar 在 `Init.init()` 里把 `assets/*guard_v*.so`
     * 解密落到 `files/AiWex/libdec/`，然后 `System.load()` 它。若目录缺失/不可写，
     * jar 内部只抛 `MyCrypto so 未在启动阶段初始化完成: <path>` 且不会重试，
     * 表现为该源永久不可用（实测 8 个 ManJu/Book 系源）。
     *
     * 这里提前建好目录并做一次可写探测，让 jar 的落盘步骤能成功。
     */
    private static void prepareGuardWorkDirs(Context context) {
        File base = context.getFilesDir();
        String[] dirs = {
                "AiWex",
                "AiWex/libdec",
                "AiWex/lib",
        };
        for (String rel : dirs) {
            File dir = new File(base, rel);
            if (dir.exists()) continue;
            if (dir.mkdirs()) {
                Log.i(TAG, "created guard work dir: " + rel);
            } else {
                Log.w(TAG, "cannot create guard work dir: " + rel);
            }
        }
        // 可写探测改为直接尝试写一个临时文件到目标目录，而非依赖 createNewFile 返回值。
        // 部分华为 ROM 的 SELinux 策略会让 createNewFile() 返回 false 即使目录可写，
        // 导致误报警告 "guard work dir not writable"。
        File testDir = new File(base, "AiWex");
        File probe = new File(testDir, ".write-probe-" + System.nanoTime());
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(probe)) {
            fos.write(0);
            // 写成功 = 可写
        } catch (Exception e) {
            Log.w(TAG, "guard work dir write probe failed: " + e.getMessage());
        } finally {
            if (probe.exists()) {
                //noinspection ResultOfMethodCallIgnored
                probe.delete();
            }
        }
    }

    /**
     * 初始化 guard jar 的 Init 环境，带并发保护和重试。
     *
     * 多线程并发加载同一 jar 时，DexNative.<clinit>() 提取 .so 到 cache 临时文件
     * 存在 race condition。这里用 per-jar-file 锁保证 Init.init() 串行执行，
     * 并用 guardInitDone 标记避免已成功的 jar 重复初始化。
     *
     * 首次 Init.init() 失败时会重试一次：DexNative 的 <clinit> 在首次失败后
     * ART 会清理错误状态允许重试，第二次通常能成功（.so 文件已落盘）。
     */
    private void initGuardJar(ClassLoader loader, Context context, File jarFile, String api) throws Exception {
        String lockKey = jarFile.getName();
        Object lock = guardInitLocks.computeIfAbsent(lockKey, k -> new Object());

        synchronized (lock) {
            Class<?> initClass = loader.loadClass("com.github.catvod.spider.Init");

            // 快速路径：done 标记只说明**某个** DexClassLoader 初始化成功过。
            // loadSpider 每次调用都 new DexClassLoader，Init 单例（Init$Loader.<clinit>）
            // 是 per-classloader 的——当前 loader 的 Init.loader() 未就绪时必须继续
            // 完整 init，否则构造函数里 Init.getSpider() → DexNative.getSpider(null)
            // → SIGABRT（Mate 50 Pro 实证：同 jar 的第二个源必崩 2026-11-03）。
            if (Boolean.TRUE.equals(guardInitDone.get(lockKey))) {
                try {
                    verifyGuardLoader(initClass, api);
                    Log.i(TAG, "guard jar already initialized, skip: " + api);
                    return;
                } catch (Throwable e) {
                    d("guardInitDone stale for fresh classloader, re-init: %s", api);
                    // 落入下方完整 init
                }
            }

            Application app = (Application) context.getApplicationContext();
            if (app == null) app = (Application) context;

            // 预创建 guard 工作目录
            prepareGuardWorkDirs(context);

            // InitOrigin 兼容性预检
            assertInitOriginCompatible(loader, api);

            Method initMethod = findInitMethod(initClass);
            if (initMethod == null) {
                throw new NoSuchMethodException("Init.init(Context/Application) not found");
            }
            initMethod.setAccessible(true);

            // 首次尝试
            Throwable firstError = null;
            try {
                initMethod.invoke(null, app);
                verifyGuardLoader(initClass, api);
                guardInitDone.put(lockKey, Boolean.TRUE);
                Log.i(TAG, "guard jar initialized: " + api);
                d("guard jar initialized successfully: %s", api);
                return;
            } catch (Throwable e) {
                firstError = unwrap(e);
                d("guard jar init first attempt failed: %s -> %s", api, describeFailure(firstError));
                Log.w(TAG, "guard jar init first attempt failed: " + api + " -> " + describeFailure(firstError)
                        + ", retrying...");
            }

            // 重试：清理可能的残留状态后重新调用
            // DexNative.<clinit> 首次失败后（如 .so 文件提取不完整），重试时
            // 文件可能已经完整落盘，或者 ART 清理了 erroneous 状态允许重新初始化。
            // 额外等待一小段时间让文件系统稳定。
            try {
                Thread.sleep(200);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }

            try {
                initMethod.invoke(null, app);
                verifyGuardLoader(initClass, api);
                guardInitDone.put(lockKey, Boolean.TRUE);
                Log.i(TAG, "guard jar initialized (retry): " + api);
                return;
            } catch (Throwable e) {
                Throwable cause = unwrap(e);
                Log.e(TAG, "guard jar init failed (retry): " + api + " -> " + describeFailure(cause), cause);
                throw new IllegalStateException(
                        "guard 类型爬虫初始化失败（" + api + "）：" + describeFailure(cause), cause);
            }
        }
    }

    /** 解包 InvocationTargetException / ExceptionInInitializerError 的 cause */
    private static Throwable unwrap(Throwable e) {
        while ((e instanceof java.lang.reflect.InvocationTargetException
                || e instanceof ExceptionInInitializerError)
                && e.getCause() != null) {
            e = e.getCause();
        }
        return e;
    }

    /** 验证 Init.init() 后 loader 是否就绪；loader 为 null 时必须抛异常终止加载 */
    private static void verifyGuardLoader(Class<?> initClass, String api) throws Exception {
        Method loaderMethod = findNoArgMethod(initClass, "loader", "getLoader");
        if (loaderMethod == null) {
            Log.w(TAG, "No loader/getLoader method found for " + api);
            return;
        }
        loaderMethod.setAccessible(true);
        Object loaderObj = loaderMethod.invoke(null);
        if (loaderObj == null) {
            // 不能"continuing anyway"：guard 爬虫构造函数会走 Init.getSpider() →
            // DexNative.getSpider(null, ...)，native 层对 null ClassLoader 调
            // loadClass 触发 JNI DETECTED ERROR → SIGABRT 杀进程（Java catch 无效，
            // Mate 50 Pro / EMUI 14.2 实证 2026-11-03）。必须在此拒绝，让源级
            // 失败由 runSpider 的 catch 转成 reject。
            throw new IllegalStateException(
                    "guard 爬虫 loader 未就绪（Init.init 后 Init.loader() 仍为 null，"
                            + "native DexNative 将崩溃，拒绝加载）: " + api);
        }
        Log.i(TAG, "Init.loader() successful: " + loaderObj.getClass().getName() + " for " + api);
    }

    /** guard 系 jar 的特征字符串（在 classes.dex 字节里出现即认定） */    private static final byte[][] GUARD_DEX_MARKERS = {
            "DexNative".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            "BaseSpiderGuard".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
    };

    /**
     * 判断 jar 是否 guard 加固类型。
     *
     * 实测（真机缓存取样）guard jar 的 zip 条目只有 5 个：
     * `classes.dex`(37KB) + `assets/{fty,wex}guard_v7/v8.so` + `assets/*shinidie.guard`(加密载荷)。
     * **真实爬虫类名不在 zip 条目里，而在 dex 字符串池中**，所以不能按条目名判断，
     * 必须读 dex 字节找 `DexNative` / `BaseSpiderGuard` 特征串。
     *
     * 判定必须保守：对非 guard jar 误调 `Init.init()` 会连带拉起 jar 自带的
     * 悬浮球与本地代理，反而污染宿主环境。
     */
    private static boolean isGuardJar(File jarFile, ClassLoader loader) {
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(jarFile)) {
            java.util.Enumeration<? extends java.util.zip.ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                java.util.zip.ZipEntry entry = entries.nextElement();
                if (entry.isDirectory() || !entry.getName().endsWith(".dex")) continue;
                byte[] dex;
                try (InputStream in = zip.getInputStream(entry)) {
                    // dex 可能很大（实测普通 jar 达 4.9MB），只需前 512KB 覆盖字符串池
                    byte[] buf = new byte[(int) Math.min(entry.getSize() > 0 ? entry.getSize() : 524288, 524288)];
                    int total = 0;
                    int read;
                    while (total < buf.length && (read = in.read(buf, total, buf.length - total)) > 0) {
                        total += read;
                    }
                    dex = total == buf.length ? buf : java.util.Arrays.copyOf(buf, total);
                }
                for (byte[] marker : GUARD_DEX_MARKERS) {
                    if (indexOf(dex, marker) >= 0) return true;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "guard jar probe failed: " + jarFile.getName() + " -> " + e.getMessage());
        }
        // 兜底：极少数 jar 把 guard 类放在外部（不在 dex 里），再试一次类加载
        for (String marker : new String[]{"com.github.catvod.spider.DexNative",
                "com.github.catvod.spider.BaseSpiderGuard"}) {
            try {
                Class.forName(marker, false, loader);
                return true;
            } catch (Throwable ignored) {
                // 该类不存在，继续看下一个特征
            }
        }
        return false;
    }

    /** 字节数组子串查找（dex 特征串匹配） */
    private static int indexOf(byte[] haystack, byte[] needle) {
        if (needle.length == 0 || haystack.length < needle.length) return -1;
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    /** 找 `Init.init(Context/Application)` 静态方法（不同 jar 参数类型不同） */
    private static Method findInitMethod(Class<?> initClass) {
        for (Method method : initClass.getDeclaredMethods()) {
            if (!method.getName().equals("init")) continue;
            if (!java.lang.reflect.Modifier.isStatic(method.getModifiers())) continue;
            Class<?>[] params = method.getParameterTypes();
            if (params.length != 1) continue;
            if (Context.class.isAssignableFrom(params[0]) || params[0].isAssignableFrom(Context.class)) {
                return method;
            }
        }
        return null;
    }

    /**
     * P1-7：`InitOrigin` 兼容性预检。
     *
     * 部分 guard jar 编译时依赖较新的 catvod 库，`Init.init()` 里会调用
     * `InitOrigin.setClass(Class)`；而它自己打包的 `InitOrigin` 是旧版，方法不存在 →
     * `NoSuchMethodError`（Error 而非 Exception）在初始化链里被 JNI 升级成 SIGABRT，
     * 整个进程被杀，Java 侧任何 catch 都来不及。
     *
     * 这里在调用 `Init.init` 之前静态确认方法存在；不存在就抛可读错误，
     * 让该源明确「不兼容」而不是拖死 App。没有 `InitOrigin` 的 jar 不受影响。
     */
    private static void assertInitOriginCompatible(ClassLoader loader, String api) {
        Class<?> origin;
        try {
            origin = loader.loadClass("com.github.catvod.spider.InitOrigin");
        } catch (ClassNotFoundException ignored) {
            return; // 不依赖 InitOrigin 的 jar 不走这条链路
        }
        try {
            origin.getMethod("setClass", Class.class);
        } catch (NoSuchMethodException missing) {
            throw new IllegalStateException(
                    "爬虫库版本不兼容（" + api + "）：InitOrigin 缺少 setClass(Class)，该源需要更新版本");
        }
    }

    /** 按候选名找无参静态方法（loader 字段的 getter 命名因混淆而异） */
    private static Method findNoArgMethod(Class<?> clazz, String... names) {        for (String name : names) {
            for (Method method : clazz.getDeclaredMethods()) {
                if (!method.getName().equals(name)) continue;
                if (method.getParameterTypes().length != 0) continue;
                return method;
            }
        }
        return null;
    }

    /**
     * `init(Context, String)` / `init(Context)` 两种签名都兼容。
     * 必须用**实例实际类型**取方法：jar 里的爬虫覆写了 init，
     * 用基类 `Spider.class` 会拿到 stub 的空实现，爬虫配置（分类/嗅探词）就丢了。
     *
     * Guard 系爬虫（BaseSpiderGuard）的 init(Context, String) 内部会调
     * Init.getSpider(api) 获取真正的爬虫实例再委托 init。若 getSpider 返回 null
     * 则 NPE。这里在 init 失败时额外诊断 getSpider 状态，给出可读错误而非吞掉。
     */
    private Throwable invokeInit(Spider spider, Context context, String initExt, String api, ClassLoader loader) {
        Class<?> clazz = spider.getClass();
        try {
            Method method = clazz.getMethod("init", Context.class, String.class);
            method.invoke(spider, context, initExt == null ? "" : initExt);
        } catch (NoSuchMethodException e) {
            try {
                Method method = clazz.getMethod("init", Context.class);
                method.invoke(spider, context);
            } catch (Exception inner) {
                return handleInitFailure(unwrap(inner), api, loader, inner);
            }
        } catch (Exception e) {
            return handleInitFailure(unwrap(e), api, loader, e);
        }
        return null;
    }

    /**
     * init 失败分类处理：返回非 null 表示致命失败，调用方必须拒绝该源。
     *
     * LinkageError（NoClassDefFoundError / NoSuchMethodError / ClassFormatError）说明
     * jar 与本 App 的依赖版本不兼容，init 没完成但对象已创建；继续 invoke 会进入
     * jar 内 native 路径直接崩进程（真机实证：csp_SheQuwonAmns / csp_AppTTGuard）。
     * 其余失败保留既有降级语义（例如 guard 内层为 null 的 NPE）。
     */
    private Throwable handleInitFailure(Throwable cause, String api, ClassLoader loader, Exception raw) {
        // Guard 系 init NPE 的典型表现：BaseSpiderGuard.init 委托内部 Spider 时
        // Spider 为 null（Init.getSpider(api) 返回 null）。
        if (cause instanceof NullPointerException) {
            String diag = diagnoseGuardSpiderNull(api, loader);
            Log.e(TAG, "init(Context, String) failed for " + api + ": NPE in guard spider init\n" + diag, cause);

            // 尝试降级：如果内部爬虫加载失败，跳过 init，让源可用但可能功能不完整
            Log.w(TAG, "trying fallback: skipping init for guard spider");
            return null;
        }
        Log.w(TAG, "init(Context, String) failed for " + api, raw);
        return cause instanceof LinkageError ? cause : null;
    }

    /**
     * 诊断 Guard 爬虫 init NPE：检查 Init.getSpider(api) 是否返回 null。
     *
     * BaseSpiderGuard.init(Context, String) 内部调用 Init.getSpider(api) 获取真正的
     * 爬虫实例。getSpider 依赖 Init.loader()（DexClassLoader）解密 .guard 文件加载
     * 真实爬虫类。如果 loader 无效或解密失败，getSpider 返回 null → NPE。
     */
    private String diagnoseGuardSpiderNull(String api, ClassLoader loader) {
        StringBuilder sb = new StringBuilder();
        sb.append("=== Guard Spider NPE Diagnosis for ").append(api).append(" ===\n");
        try {
            Class<?> initClass = loader.loadClass("com.github.catvod.spider.Init");

            // 检查 loader 是否就绪
            Method loaderMethod = findNoArgMethod(initClass, "loader", "getLoader");
            if (loaderMethod != null) {
                loaderMethod.setAccessible(true);
                Object loaderObj = loaderMethod.invoke(null);
                String loaderInfo = loaderObj == null ? "NULL" : loaderObj.getClass().getName();
                sb.append("Init.loader(): ").append(loaderInfo).append("\n");
                
                // 如果不为 NULL，输出详细信息
                if (loaderObj != null) {
                    d("Init.loader() for %s: %s", api, loaderInfo);
                }
                
                // 如果 loader 不为 null，尝试从它加载类
                if (loaderObj instanceof dalvik.system.DexClassLoader) {
                    try {
                        dalvik.system.DexClassLoader dexLoader = (dalvik.system.DexClassLoader) loaderObj;
                        String stripped = api.replaceFirst("^(csp|py)_", "");
                        String internalSpiderName = "com.github.catvod.crawler." + stripped;
                        
                        sb.append("Trying to load internal spider: ").append(internalSpiderName).append("\n");
                        try {
                            Class<?> internalSpiderClass = dexLoader.loadClass(internalSpiderName);
                            sb.append("Loaded successfully: ").append(internalSpiderClass.getName()).append("\n");
                            
                            // 尝试实例化
                            Object instance = internalSpiderClass.getDeclaredConstructor().newInstance();
                            sb.append("Instantiated: ").append(instance.getClass().getName()).append("\n");
                        } catch (Exception e) {
                            sb.append("Failed to load/instantiate: ").append(describeFailure(e)).append("\n");
                        }
                    } catch (Exception e) {
                        sb.append("Error accessing DexClassLoader: ").append(describeFailure(e)).append("\n");
                    }
                }
            } else {
                sb.append("Init.loader() method not found\n");
            }

            // 检查 getSpider(api) 是否返回 null
            Method getSpiderMethod = null;
            for (Method m : initClass.getDeclaredMethods()) {
                if (m.getName().equals("getSpider") && m.getParameterCount() == 1
                        && m.getParameterTypes()[0] == String.class) {
                    getSpiderMethod = m;
                    break;
                }
            }
            if (getSpiderMethod != null) {
                getSpiderMethod.setAccessible(true);
                String stripped = api.replaceFirst("^(csp|py)_", "");
                Object spider = getSpiderMethod.invoke(null, stripped);
                sb.append("Init.getSpider(").append(stripped).append("): ")
                        .append(spider == null ? "NULL" : spider.getClass().getName())
                        .append("\n");
            } else {
                sb.append("Init.getSpider(String) method not found\n");
            }
            
            // 列出所有可用的 getSpider 方法
            sb.append("\nAvailable methods with 'getSpider':\n");
            for (Method m : initClass.getDeclaredMethods()) {
                if (m.getName().equals("getSpider")) {
                    Class<?>[] params = m.getParameterTypes();
                    sb.append("  - ").append(m.getName()).append("(");
                    for (int i = 0; i < params.length; i++) {
                        if (i > 0) sb.append(", ");
                        sb.append(params[i].getSimpleName());
                    }
                    sb.append(")\n");
                }
            }
        } catch (Throwable t) {
            sb.append("diagnosis failed: ").append(describeFailure(t)).append("\n");
        }
        return sb.toString();
    }

    /**
     * 传给 jar 爬虫的 Context 守卫：吞掉爬虫代码发起的系统设置页跳转。
     * 部分 TVBox jar（如 ftyguard 系列）在 init/调用期会自行申请「所有文件访问」等
     * 特殊权限并 startActivity 到 Settings；本应用不需要也不声明这些权限（开关必然置灰），
     * 放行只会打断用户。守卫只拦 `android.settings.*`，其余调用原样透传。
     */
    static final class GuardedSpiderContext extends ContextWrapper {
        private static final String SETTINGS_ACTION_PREFIX = "android.settings.";

        GuardedSpiderContext(Context base) {
            super(base);
        }

        @Override
        public void startActivity(Intent intent) {
            if (blockSettingsJump(intent)) return;
            super.startActivity(intent);
        }

        @Override
        public void startActivity(Intent intent, Bundle options) {
            if (blockSettingsJump(intent)) return;
            super.startActivity(intent, options);
        }

        @Override
        public Context getApplicationContext() {
            // 爬虫常经 getApplicationContext() 再 startActivity；保持守卫链
            return this;
        }

        private boolean blockSettingsJump(Intent intent) {
            String action = intent == null ? null : intent.getAction();
            if (action != null && action.startsWith(SETTINGS_ACTION_PREFIX)) {
                Log.w(TAG, "spider blocked settings jump: " + action);
                return true;
            }
            return false;
        }
    }

    /** 部分爬虫有 `setUserAgent`；没有则忽略 */
    private static void applyUserAgent(Spider spider, String userAgent) {
        try {
            Method method = spider.getClass().getMethod("setUserAgent", String.class);
            method.invoke(spider, userAgent);
        } catch (Exception ignored) {
            // 爬虫不提供 UA 注入点时保持默认
        }
    }

    /** 按方法名 + 参数个数匹配爬虫覆写，参数不匹配时尝试宽松转换 */
    private String invokeSpider(LoadedSpider target, String method, Object[] args) throws Exception {
        Spider spider = target.spider;
        Class<? extends Spider> clazz = spider.getClass();
        Method matched = null;
        for (Method candidate : clazz.getMethods()) {
            if (!candidate.getName().equals(method)) continue;
            if (candidate.getParameterCount() != args.length) continue;
            if (isAssignable(candidate.getParameterTypes(), args)) {
                matched = candidate;
                break;
            }
        }
        if (matched == null) {
            for (Method candidate : clazz.getMethods()) {
                if (candidate.getName().equals(method) && candidate.getParameterCount() == args.length) {
                    matched = candidate;
                    break;
                }
            }
        }
        if (matched == null) {
            throw new NoSuchMethodException(method + "/" + args.length);
        }

        Object[] converted = convertArgs(matched.getParameterTypes(), args);
        Object result = matched.invoke(spider, converted);
        String json = result == null ? null : String.valueOf(result);

        // P2-9：searchContent 兼容——新版 catvod jar（饭太硬/潇洒系 Guard）只覆写了
        // 3 参 searchContent(String, boolean, String)，旧版宿主调 2 参版本时命中基类
        // stub 返回 null。这里在 null 时自动补 pg="1" 重试 3 参重载，避免一大批源
        // 在搜索时全军覆没（实测 21 个失败源里 13 个是这条原因）。
        if (json == null && method.equals("searchContent") && args.length == 2) {
            Method threeArg = null;
            for (Method candidate : clazz.getMethods()) {
                if (!candidate.getName().equals("searchContent")) continue;
                if (candidate.getParameterCount() != 3) continue;
                Class<?>[] params = candidate.getParameterTypes();
                if (params[0] == String.class && (params[1] == boolean.class || params[1] == Boolean.class)
                        && params[2] == String.class) {
                    threeArg = candidate;
                    break;
                }
            }
            if (threeArg != null) {
                threeArg.setAccessible(true);
                Object result2 = threeArg.invoke(spider, converted[0], converted[1], "1");
                json = result2 == null ? null : String.valueOf(result2);
                if (json != null) {
                    Log.i(TAG, "searchContent fallback to 3-arg version succeeded for " + target.api);
                    d("searchContent fallback: %s -> 3-arg successful", target.api);
                }
            }
        }

        return json;
    }
    private Object[] callProxy(LoadedSpider target, String url) throws Exception {
        Map<String, String> params = new HashMap<>();
        params.put("url", url);
        Method method = target.spider.getClass().getMethod("proxy", Map.class);
        Object result = method.invoke(target.spider, params);
        if (result instanceof Object[]) {
            return (Object[]) result;
        }
        return new Object[0];
    }

    private static boolean isAssignable(Class<?>[] types, Object[] args) {
        if (types.length != args.length) return false;
        for (int i = 0; i < types.length; i++) {
            if (args[i] == null) continue;
            Class<?> type = types[i];
            if (type.isPrimitive()) {
                if (type == boolean.class && !(args[i] instanceof Boolean)) return false;
                if (type == int.class && !(args[i] instanceof Integer)) return false;
                if (type == long.class && !(args[i] instanceof Long)) return false;
                if (type == double.class && !(args[i] instanceof Double)) return false;
                continue;
            }
            if (!type.isInstance(args[i])) {
                // Map 形参（如 HashMap）接受 JS 对象转换来的 Map
                if (Map.class.isAssignableFrom(type) && args[i] instanceof Map) continue;
                // List 形参（如 vipFlags）接受 JS 数组转换来的 List
                if (List.class.isAssignableFrom(type) && args[i] instanceof List) continue;
                return false;
            }
        }
        return true;
    }

    /** 宽松转换：把 JS 侧过来的值按目标参数类型装箱 */
    private static Object[] convertArgs(Class<?>[] types, Object[] args) {
        Object[] out = new Object[args.length];
        for (int i = 0; i < args.length; i++) {
            Object arg = args[i];
            Class<?> type = i < types.length ? types[i] : String.class;
            if (arg == null) {
                out[i] = type.isPrimitive() ? defaultOf(type) : null;
                continue;
            }
            if (type.isInstance(arg)) {
                out[i] = arg;
                continue;
            }
            // 目标形参是 Map（如 categoryContent 的 HashMap）：JS 对象直接可用
            if (Map.class.isAssignableFrom(type) && arg instanceof Map) {
                out[i] = arg;
                continue;
            }
            // 目标形参是 List（如 playerContent 的 vipFlags）：JS 数组转换来的 List 直接可用
            if (List.class.isAssignableFrom(type) && arg instanceof List) {
                out[i] = arg;
                continue;
            }
            if (type == boolean.class || type == Boolean.class) {
                out[i] = Boolean.parseBoolean(String.valueOf(arg)) || "1".equals(String.valueOf(arg));
            } else if (type == int.class || type == Integer.class) {
                out[i] = parseIntOr(String.valueOf(arg), 0);
            } else if (type == long.class || type == Long.class) {
                out[i] = parseLongOr(String.valueOf(arg), 0L);
            } else if (type == double.class || type == Double.class) {
                out[i] = parseDoubleOr(String.valueOf(arg), 0d);
            } else {
                out[i] = String.valueOf(arg);
            }
        }
        return out;
    }

    private static Object defaultOf(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == double.class) return 0d;
        return null;
    }

    private static int parseIntOr(String value, int fallback) {
        try {
            return Integer.parseInt(value.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static long parseLongOr(String value, long fallback) {
        try {
            return Long.parseLong(value.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static double parseDoubleOr(String value, double fallback) {
        try {
            return Double.parseDouble(value.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    /**
     * jar 落盘：`filesDir/spider-jars/{md5}.jar`，已存在则跳过下载。
     *
     * 带重试：实测 z.wiki 首次连接 30s 超时（复测即 200）、kstore 系域名间歇 DNS 失败。
     * 之前一次失败就让整个订阅几十个站全挂（用户感知「导入成功但都播放不了」），
     * 这里对「瞬时错误」重试 {@link #JAR_DOWNLOAD_ATTEMPTS} 次并递增退避。
     * HTTP 4xx（除 408/429）与 md5 不匹配属于确定性失败，不重试。
     */
    private File ensureJarFile(Context context, String url, String expectedMd5) throws Exception {
        String name = md5Of(url) + ".jar";
        File dir = new File(context.getFilesDir(), "spider-jars");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create spider-jars dir");
        }
        File jar = new File(dir, name);
        if (jar.exists() && jar.length() > 0) {
            // P0-B: 缓存命中也要验 ZIP magic。死域名常返回 HTML 跳转页（实测 114 字节），
            // 之前会被当 jar 落盘并长期缓存，之后每次加载都失败且错误信息误导。
            if (!hasZipMagic(jar)) {
                Log.w(TAG, "cached jar is not a valid zip, dropping: " + name);
                if (!jar.delete()) Log.w(TAG, "cannot delete invalid cached jar");
            } else if (expectedMd5 == null || expectedMd5.equalsIgnoreCase(md5OfFile(jar))) {
                return jar;
            } else {
                Log.w(TAG, "cached jar md5 mismatch, re-download");
                if (!jar.delete()) {
                    throw new IllegalStateException("cannot delete stale jar");
                }
            }
        }

        Exception lastError = null;
        for (int attempt = 1; attempt <= JAR_DOWNLOAD_ATTEMPTS; attempt++) {
            try {
                downloadJar(url, expectedMd5, dir, name, jar);
                Log.i(TAG, "downloaded jar: " + url + (attempt > 1 ? " (attempt " + attempt + ")" : ""));
                return jar;
            } catch (Exception e) {
                lastError = e;
                if (!isRetriableDownloadError(e) || attempt == JAR_DOWNLOAD_ATTEMPTS) break;
                long backoff = JAR_RETRY_BACKOFF_MS * attempt;
                Log.w(TAG, "jar download failed (attempt " + attempt + "/" + JAR_DOWNLOAD_ATTEMPTS
                        + "), retry in " + backoff + "ms: " + e.getMessage());
                try {
                    Thread.sleep(backoff);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        throw lastError != null ? lastError : new IllegalStateException("jar download failed");
    }

    /** 单次下载尝试；成功后临时文件已 rename 为最终 jar */
    private void downloadJar(String url, String expectedMd5, File dir, String name, File jar) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) PeanutMov");
        try {
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new HttpStatusException(status);
            }
            if (conn.getContentLength() > MAX_JAR_BYTES) {
                throw new IllegalStateException("jar too large");
            }
            File temp = new File(dir, name + ".tmp");
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[16384];
                long total = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_JAR_BYTES) {
                        throw new IllegalStateException("jar too large");
                    }
                    out.write(buffer, 0, read);
                }
            }
            if (expectedMd5 != null && !expectedMd5.equalsIgnoreCase(md5OfFile(temp))) {
                if (!temp.delete()) {
                    Log.w(TAG, "cannot delete mismatched temp jar");
                }
                throw new SecurityException("jar md5 mismatch");
            }
            // P0-B: 内容必须是 ZIP。死域名/防盗链会返回 HTML 或 200 空页，
            // 不校验就会把垃圾长期缓存成"已下载的 jar"。
            if (!hasZipMagic(temp)) {
                long size = temp.length();
                if (!temp.delete()) Log.w(TAG, "cannot delete non-zip temp jar");
                throw new java.io.IOException("下载内容不是有效 jar（" + size + " 字节，疑似 HTML/跳转页）：" + url);
            }
            if (!temp.renameTo(jar)) {
                throw new IllegalStateException("cannot save jar");
            }
        } finally {
            conn.disconnect();
        }
    }

    /** 一次性清扫标记：历史版本的污染 jar 只需清理一次 */
    private final AtomicBoolean cachePurged = new AtomicBoolean(false);

    /**
     * 清扫历史遗留的污染 jar 缓存。
     *
     * P0-B 只在「该源被重新加载」时才校验，用户设备上已落盘的假 jar / 半截下载
     * 会长期残留（实测真机上有 114 字节 HTML 跳转页和 central-directory 损坏的包）。
     * 首次加载任意源时顺带全量扫一遍 `spider-jars/`，把非 ZIP 的文件删掉——
     * 下次用到该源会自动重新下载。
     *
     * 只删「明显不是 jar」的文件，不动 ABI 不符或内容有效的 jar（那些是源本身的问题）。
     */
    private void purgeCorruptJarCache(Context context) {
        if (!cachePurged.compareAndSet(false, true)) return;
        File dir = new File(context.getFilesDir(), "spider-jars");
        File[] files = dir.listFiles();
        if (files == null) return;
        int removed = 0;
        for (File file : files) {
            String name = file.getName();
            if (!name.endsWith(".jar") || !file.isFile()) continue;
            if (hasZipMagic(file)) continue;
            long size = file.length();
            if (file.delete()) {
                removed++;
                jarCache.values().removeIf(cached -> cached.getName().equals(name));
                Log.w(TAG, "purged corrupt jar cache: " + name + " (" + size + " bytes)");
            } else {
                Log.w(TAG, "cannot delete corrupt jar: " + name);
            }
        }
        if (removed > 0) Log.i(TAG, "purged " + removed + " corrupt jar file(s)");
    }

    /** 校验文件头是否为 ZIP magic（`PK\x03\x04` / 空包 `PK\x05\x06`） */    private static boolean hasZipMagic(File file) {
        if (!file.exists() || file.length() < 4) return false;
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "r")) {
            int b0 = raf.read();
            int b1 = raf.read();
            int b2 = raf.read();
            int b3 = raf.read();
            if (b0 != 'P' || b1 != 'K') return false;
            return (b2 == 3 && b3 == 4) || (b2 == 5 && b3 == 6) || (b2 == 7 && b3 == 8);
        } catch (Exception e) {
            Log.w(TAG, "zip magic check failed: " + file.getName(), e);
            return false;
        }
    }

    /** 瞬时错误（网络/超时/5xx/408/429）可重试；4xx 与 md5 不符是确定性的，重试没意义 */
    private static boolean isRetriableDownloadError(Exception e) {
        if (e instanceof SecurityException) return false; // md5 mismatch
        if (e instanceof HttpStatusException) {
            int status = ((HttpStatusException) e).status;
            return status == 408 || status == 429 || status >= 500;
        }
        String message = e.getMessage();
        if (message != null && message.contains("jar too large")) return false;
        // 内容不是 zip：源站返回的是 HTML/跳转页，重试同样结果，直接判死
        if (message != null && message.contains("不是有效 jar")) return false;
        // IOException / SocketTimeout / UnknownHost / SSLException 等一律按瞬时处理
        return true;
    }

    /** 带 HTTP 状态码的下载失败，供重试策略判断 */
    private static final class HttpStatusException extends java.io.IOException {
        final int status;

        HttpStatusException(int status) {
            super("HTTP " + status);
            this.status = status;
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

    private static String md5OfFile(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("MD5");
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : digest.digest()) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

}
