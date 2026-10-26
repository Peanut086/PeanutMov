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
    private static final String SPIDER_PACKAGE = "com.github.catvod.spider.";
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final long MAX_JAR_BYTES = 8L * 1024 * 1024;
    /** jar 下载尝试次数（含首次）：慢/抖动主机（z.wiki、kstore 系）单次失败很常见 */
    private static final int JAR_DOWNLOAD_ATTEMPTS = 3;
    /** 重试退避基数，第 n 次重试等 n × 该值 */
    private static final long JAR_RETRY_BACKOFF_MS = 800;

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
    private int handleSeq = 0;

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

        LoadedSpider(Spider spider, String api, File dexDir) {
            this.spider = spider;
            this.api = api;
            this.dexDir = dexDir;
        }
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        call.resolve(ret);
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
            LoadedSpider result = loadSpider(getContext(), jarUrl, api, initExt, userAgent);
            String handle = "sp-" + (++handleSeq);
            loaded.put(handle, result);
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        });
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
            String json = invokeSpider(target, method, javaArgs);
            JSObject ret = new JSObject();
            ret.put("json", json);
            ret.put("logs", new JSArray(Arrays.asList(targetLogs())));
            call.resolve(ret);
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
        JSObject ret = new JSObject();
        ret.put("released", target != null);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        watchdog.removeCallbacksAndMessages(null);
        spiderExecutor.shutdownNow();
        loaded.clear();
        jarCache.clear();
        dexCache.clear();
    }

    /* ---------------- 内部 ---------------- */

    private String[] targetLogs() {
        return SpiderApi.get().getDebug().drain();
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
        String cleanUrl = jarUrl;
        String expectedMd5 = null;
        int sep = jarUrl.indexOf(";md5;");
        if (sep > 0) {
            cleanUrl = jarUrl.substring(0, sep);
            expectedMd5 = jarUrl.substring(sep + 5).trim();
        }

        File jarFile = jarCache.get(cleanUrl);
        if (jarFile == null) {
            jarFile = ensureJarFile(context, cleanUrl, expectedMd5);
            jarCache.put(cleanUrl, jarFile);
        }
        File dexDir = dexCache.get(jarFile.getName());
        if (dexDir == null) {
            dexDir = new File(context.getFilesDir(), "spider-dex/" + jarFile.getName());
            if (!dexDir.exists() && !dexDir.mkdirs()) {
                throw new IllegalStateException("cannot create dex dir");
            }
            dexCache.put(jarFile.getName(), dexDir);
        }

        // 加载前做 ABI 预检：带 native 库的 jar（ftyguard 系列）如果只有 ARM 版本，
        // 在 x86 模拟器上会由 native 代码触发 JNI abort（SIGABRT 杀进程，catch 不住）。
        // 必须在 DexClassLoader 之前拒绝，否则一个后台预热就能把整个 App 打崩。
        assertNativeAbiSupported(jarFile);

        ClassLoader parent = context.getClassLoader();
        dalvik.system.DexClassLoader loader = new dalvik.system.DexClassLoader(
                jarFile.getAbsolutePath(),
                dexDir.getAbsolutePath(),
                null,
                parent);

        // jar 自带 com.github.catvod.spider.Init（静态字段 Application c 由 TVBox 宿主注入）。
        // 不注入时 Init.context() 返回 null，爬虫在 detailContent 等路径里
        // 调 context.getPackageName() 会 NPE（YunDuo 等一大批爬虫的实际失败原因）。
        injectCatvodInit(loader, context);

        String className = resolveSpiderClassName(api, loader);
        Class<?> clazz = loader.loadClass(className);
        Object instance = clazz.getDeclaredConstructor().newInstance();
        if (!(instance instanceof Spider)) {
            throw new ClassCastException(api + " is not a Spider");
        }
        Spider spider = (Spider) instance;

        invokeInit(spider, new GuardedSpiderContext(context), initExt);
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
        Log.i(TAG, "loaded spider: " + api);
        return new LoadedSpider(spider, api, dexDir);
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
     * `init(Context, String)` / `init(Context)` 两种签名都兼容。
     * 必须用**实例实际类型**取方法：jar 里的爬虫覆写了 init，
     * 用基类 `Spider.class` 会拿到 stub 的空实现，爬虫配置（分类/嗅探词）就丢了。
     */
    private static void invokeInit(Spider spider, Context context, String initExt) {
        Class<?> clazz = spider.getClass();
        try {
            Method method = clazz.getMethod("init", Context.class, String.class);
            method.invoke(spider, context, initExt == null ? "" : initExt);
        } catch (NoSuchMethodException e) {
            try {
                Method method = clazz.getMethod("init", Context.class);
                method.invoke(spider, context);
            } catch (Exception inner) {
                Log.w(TAG, "init(Context) failed", inner);
            }
        } catch (Exception e) {
            Log.w(TAG, "init(Context, String) failed", e);
        }
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
        return result == null ? null : String.valueOf(result);
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
            if (expectedMd5 == null || expectedMd5.equalsIgnoreCase(md5OfFile(jar))) {
                return jar;
            }
            Log.w(TAG, "cached jar md5 mismatch, re-download");
            if (!jar.delete()) {
                throw new IllegalStateException("cannot delete stale jar");
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
            if (!temp.renameTo(jar)) {
                throw new IllegalStateException("cannot save jar");
            }
        } finally {
            conn.disconnect();
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
