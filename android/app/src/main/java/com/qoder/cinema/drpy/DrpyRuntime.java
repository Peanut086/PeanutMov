package com.qoder.cinema.drpy;

import android.content.Context;
import android.util.Log;

import com.github.catvod.crawler.SpiderApi;
import com.whl.quickjs.wrapper.JSCallFunction;
import com.whl.quickjs.wrapper.QuickJSContext;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * drpy 运行时（CHG-16）—— 一个 QuickJS 实例封装一条 drpy 规则
 *
 * 线程模型：QuickJSContext 要求所有操作在同一线程（checkSameThread），
 * 因此每个 runtime 独占一个单线程 executor，外部调用经 onEngine() 阻塞转发；
 * 超时由 DrpyPlugin 的看门狗负责（本类不中断阻塞中的 JS，与 jar 爬虫同策略）。
 *
 * 宿主环境：assets/drpy_host.js 提供req/pdfa/pdfh/pd/local/log 等全局 API，
 * 并把规则的 home/category/detail/search/play 编排为 __drpyCall 同步入口；
 * 本类只提供底层绑定（HTTP / DOM 选择器 / 日志 / local 存储 / 编解码）。
 */
public class DrpyRuntime implements AutoCloseable {

    private static final String TAG = "DrpyRuntime";
    /** DOM 片段上限：超大页面（几 MB 的 HTML）解析成本高，超出直接截断 */
    private static final int MAX_HTML_LENGTH = 2_000_000;

    private static final ExecutorService ENGINE_INIT = Executors.newSingleThreadExecutor();

    /** 绑定返回/入参统一走 JSON 字符串，避免桥接层类型转换歧义 */
    private final QuickJSContext context;
    private final ExecutorService engineThread;
    private final File localFile;
    private final Map<String, String> localStore = new HashMap<>();
    private final ArrayDeque<String> logs = new ArrayDeque<>();
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(15_000, TimeUnit.MILLISECONDS)
            .readTimeout(15_000, TimeUnit.MILLISECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build();

    private volatile boolean closed = false;

    static {
        com.whl.quickjs.android.QuickJSLoader.init();
    }

    /** 规则源码 → 运行时。抛出的异常信息直接面向用户（规则哪一步失败一目了然） */
    public DrpyRuntime(Context appContext, String ruleCode, String initExt, String handle) throws Exception {
        engineThread = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "drpy-" + handle);
            t.setDaemon(true);
            return t;
        });
        localFile = new File(new File(appContext.getFilesDir(), "drpy-local"), handle + ".json");
        loadLocalStore();
        context = onEngine(() -> {
            QuickJSContext ctx = QuickJSContext.create();
            try {
                installBindings(ctx, handle);
                ctx.evaluate(readHostScript(appContext), "drpy_host.js");
                ctx.getGlobalObject().setProperty("__drpyExt", initExt == null ? "" : initExt);
                ctx.evaluate(ruleCode, "rule.js");
                // 规则里常见的 `var rule = {...}` 与 `globalThis.rule = {...}` 都覆盖
                Object ruleObj = ctx.getGlobalObject().getProperty("rule");
                if (ruleObj == null) {
                    throw new IllegalStateException("规则未定义 rule 对象");
                }
                return ctx;
            } catch (Exception e) {
                try { ctx.destroy(); } catch (Exception ignored) { }
                throw e;
            }
        });
        Log.i(TAG, "drpy runtime loaded: " + handle);
    }

    /** 调用规则的某个编排方法，返回 TVBox JSON 字符串（含 __error 时抛出） */
    public String invoke(String method, String argJson) throws Exception {
        if (closed) throw new IllegalStateException("runtime closed");
        Object first = onEngine(() ->
                context.evaluate("__drpyCall(" + jsStr(method) + "," + jsStr(argJson == null ? "{}" : argJson) + ")"));
        String result = first == null ? "null" : String.valueOf(first);
        if ("__DRPY_ASYNC__".equals(result)) {
            // evaluate 返回前微任务已泵完（Promise 在同一次 evaluate 内执行），正常应拿到终值
            Object out = onEngine(() -> context.evaluate("__drpyOutJson()"));
            result = out == null ? "null" : String.valueOf(out);
        }
        JSONObject parsed = new JSONObject(result);
        if (parsed.optBoolean("__error")) {
            throw new IllegalStateException(parsed.optString("__error", "规则执行失败"));
        }
        // __error 可能嵌在返回体里（异步路径整包 stringify）
        if (parsed.has("__error")) {
            throw new IllegalStateException(parsed.optString("__error", "规则执行失败"));
        }
        return result;
    }

    /** 收集本条规则执行期日志（随 invoke 返回给前端，排查规则问题用） */
    public List<String> drainLogs() {
        synchronized (logs) {
            List<String> out = new ArrayList<>(logs);
            logs.clear();
            return out;
        }
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        try {
            onEngine(() -> {
                context.destroy();
                return null;
            });
        } catch (Exception e) {
            Log.w(TAG, "destroy failed", e);
        }
        engineThread.shutdownNow();
    }

    /* ---------------- 引擎线程转发 ---------------- */

    private <T> T onEngine(Callable<T> task) throws Exception {
        Future<T> future = engineThread.submit(task);
        try {
            return future.get();
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IllegalStateException(cause);
        }
    }

    private static String readHostScript(Context context) throws Exception {
        try (InputStream in = context.getAssets().open("drpy_host.js")) {
            byte[] buffer = new byte[256 * 1024];
            int total = 0;
            int read;
            while ((read = in.read(buffer, total, buffer.length - total)) > 0) {
                total += read;
                if (total >= buffer.length) break;
            }
            return new String(buffer, 0, total, StandardCharsets.UTF_8);
        }
    }

    private static String jsStr(String value) {
        return JSONObject.quote(value == null ? "" : value);
    }

    /* ---------------- 底层绑定 ---------------- */

    private void installBindings(QuickJSContext ctx, String handle) {
        ctx.getGlobalObject().setProperty("__req", (JSCallFunction) args -> httpBinding(args));
        ctx.getGlobalObject().setProperty("__domSelect", (JSCallFunction) args -> domSelectBinding(args));
        ctx.getGlobalObject().setProperty("__log", (JSCallFunction) args -> {
            addLog(args.length > 0 ? String.valueOf(args[0]) : "");
            return null;
        });
        ctx.getGlobalObject().setProperty("__localGet", (JSCallFunction) args -> {
            String key = args.length > 0 ? String.valueOf(args[0]) : "";
            String v = localStore.get(key);
            return v == null ? null : v;
        });
        ctx.getGlobalObject().setProperty("__localSet", (JSCallFunction) args -> {
            if (args.length >= 2) {
                localStore.put(String.valueOf(args[0]), String.valueOf(args[1]));
                persistLocalStore();
            }
            return null;
        });
        ctx.getGlobalObject().setProperty("__b64e", (JSCallFunction) args ->
                args.length > 0 ? Base64.getEncoder().encodeToString(String.valueOf(args[0]).getBytes(StandardCharsets.UTF_8)) : "");
        ctx.getGlobalObject().setProperty("__b64d", (JSCallFunction) args -> {
            if (args.length == 0) return "";
            try {
                return new String(Base64.getDecoder().decode(String.valueOf(args[0])), StandardCharsets.UTF_8);
            } catch (IllegalArgumentException e) {
                return "";
            }
        });
        ctx.getGlobalObject().setProperty("__md5", (JSCallFunction) args ->
                args.length > 0 ? md5(String.valueOf(args[0])) : "");
        Log.d(TAG, "bindings installed for " + handle);
    }

    /** __req(specJson) -> {code, headers, body} 或 {__error, code}；spec: {url, method, headers, body, timeout} */
    private String httpBinding(Object[] args) {
        JSONObject spec;
        try {
            spec = new JSONObject(args.length > 0 ? String.valueOf(args[0]) : "{}");
        } catch (Exception e) {
            return jsonError("请求参数不是合法 JSON", 0);
        }
        String url = spec.optString("url", "");
        if (url.isEmpty()) return jsonError("url 为空", 0);
        String method = spec.optString("method", "GET").toUpperCase();
        int timeout = Math.max(1000, spec.optInt("timeout", 15000));
        try {
            Request.Builder builder = new Request.Builder().url(url);
            JSONObject headers = spec.optJSONObject("headers");
            if (headers != null) {
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    String value = String.valueOf(headers.opt(key));
                    if (!key.isEmpty() && !"null".equals(value)) builder.header(key, value);
                }
            }
            if (!builder.build().headers().names().contains("User-Agent")) {
                builder.header("User-Agent", "Mozilla/5.0 (Linux; Android 13) PeanutMov");
            }
            String body = spec.optString("body", null);
            if ("POST".equals(method) || body != null) {
                builder.post(RequestBody.create(body == null ? "" : body,
                        MediaType.parse("application/x-www-form-urlencoded")));
            } else if (!"GET".equals(method)) {
                builder.method(method, null);
            }
            OkHttpClient client = http.newBuilder()
                    .connectTimeout(timeout, TimeUnit.MILLISECONDS)
                    .readTimeout(timeout, TimeUnit.MILLISECONDS)
                    .build();
            try (Response response = client.newCall(builder.build()).execute()) {
                Map<String, String> responseHeaders = new HashMap<>();
                for (Map.Entry<String, List<String>> entry : response.headers().toMultimap().entrySet()) {
                    if (!entry.getValue().isEmpty() && entry.getValue().get(0) != null) {
                        responseHeaders.put(entry.getKey(), entry.getValue().get(0));
                    }
                }
                String responseBody = "";
                if (response.body() != null) {
                    String raw = response.body().string();
                    responseBody = raw.length() > MAX_HTML_LENGTH ? raw.substring(0, MAX_HTML_LENGTH) : raw;
                }
                JSONObject out = new JSONObject();
                out.put("code", response.code());
                out.put("headers", new JSONObject(responseHeaders));
                out.put("body", responseBody);
                return out.toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "req failed: " + url, e);
            return jsonError(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), 0);
        }
    }

    /**
     * __domSelect(html, selector, mode, attr) -> JSON 字符串数组
     * mode: text | html | outerHtml | attr（attr 时用第 4 参指定属性名）
     */
    private String domSelectBinding(Object[] args) {
        String html = args.length > 0 && args[0] != null ? String.valueOf(args[0]) : "";
        String selector = args.length > 1 && args[1] != null ? String.valueOf(args[1]) : "";
        String mode = args.length > 2 && args[2] != null ? String.valueOf(args[2]) : "outerHtml";
        String attr = args.length > 3 && args[3] != null ? String.valueOf(args[3]) : null;
        JSONArray out = new JSONArray();
        try {
            if (html.length() > MAX_HTML_LENGTH) {
                html = html.substring(0, MAX_HTML_LENGTH);
            }
            Elements elements = selector.trim().isEmpty()
                    ? new Elements(org.jsoup.nodes.Document.class.cast(Jsoup.parse(html)).body())
                    : Jsoup.parse(html).select(selector);
            for (Element el : elements) {
                String value;
                switch (mode) {
                    case "text":
                        value = el.text();
                        break;
                    case "html":
                        value = el.html();
                        break;
                    case "attr":
                        value = attr != null && el.hasAttr(attr) ? el.attr(attr) : "";
                        break;
                    case "outerHtml":
                    default:
                        value = el.outerHtml();
                        break;
                }
                out.put(value);
                if (out.length() >= 500) break; // 防御：规则选择器过宽时限制结果量
            }
        } catch (Exception e) {
            Log.w(TAG, "domSelect failed: " + selector, e);
        }
        return out.toString();
    }

    private void addLog(String message) {
        synchronized (logs) {
            if (logs.size() >= 200) logs.poll();
            logs.add(message);
        }
        SpiderApi.get().getDebug().log("[drpy] " + message);
    }

    private void loadLocalStore() {
        if (!localFile.exists()) return;
        try (FileInputStream in = new FileInputStream(localFile)) {
            byte[] buffer = new byte[(int) Math.min(localFile.length(), 1024 * 1024)];
            int read = in.read(buffer);
            JSONObject obj = new JSONObject(new String(buffer, 0, Math.max(read, 0), StandardCharsets.UTF_8));
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                localStore.put(key, obj.optString(key, ""));
            }
        } catch (Exception e) {
            Log.w(TAG, "load local store failed", e);
        }
    }

    private void persistLocalStore() {
        try {
            File dir = localFile.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) return;
            try (FileOutputStream out = new FileOutputStream(localFile)) {
                out.write(new JSONObject(localStore).toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.w(TAG, "persist local store failed", e);
        }
    }

    private static String jsonError(String message, int code) {
        try {
            return new JSONObject().put("__error", message == null ? "unknown" : message).put("code", code).toString();
        } catch (Exception e) {
            return "{\"__error\":\"unknown\",\"code\":0}";
        }
    }

    private static String md5(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
