package com.qoder.cinema;

import android.content.Context;
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

        try {
            LoadedSpider result = loadSpider(getContext(), jarUrl, api, initExt, userAgent);
            String handle = "sp-" + (++handleSeq);
            loaded.put(handle, result);
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "load failed: " + jarUrl, e);
            call.reject("爬虫加载失败: " + e.getMessage());
        }
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

        try {
            String json = invokeSpider(target, method, toJavaArgs(args, arrayArgs));
            JSObject ret = new JSObject();
            ret.put("json", json);
            ret.put("logs", new JSArray(Arrays.asList(targetLogs())));
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "invoke failed: " + method, e);
            call.reject("爬虫执行失败: " + e.getMessage());
        }
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

        try {
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
        } catch (Exception e) {
            Log.w(TAG, "proxy failed", e);
            call.reject("proxy failed: " + e.getMessage());
        }
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

        ClassLoader parent = context.getClassLoader();
        dalvik.system.DexClassLoader loader = new dalvik.system.DexClassLoader(
                jarFile.getAbsolutePath(),
                dexDir.getAbsolutePath(),
                null,
                parent);

        String className = resolveSpiderClassName(api, loader);
        Class<?> clazz = loader.loadClass(className);
        Object instance = clazz.getDeclaredConstructor().newInstance();
        if (!(instance instanceof Spider)) {
            throw new ClassCastException(api + " is not a Spider");
        }
        Spider spider = (Spider) instance;

        invokeInit(spider, context, initExt);
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

    /** jar 落盘：`filesDir/spider-jars/{md5}.jar`，已存在则跳过下载 */
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
        Log.i(TAG, "downloaded jar: " + url);
        return jar;
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
