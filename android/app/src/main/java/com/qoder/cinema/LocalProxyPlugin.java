package com.qoder.cinema;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * LocalProxy —— 带 Referer/UA 注入的本地回环 HTTP 代理（MP4 防盗链）
 *
 * 背景：Android WebView 的 `<video src>` 由媒体栈直接请求，CapacitorHttp 只补丁
 * fetch/XHR，hls.js 能注入头而直链 mp4 不能；带 Referer 防盗链的源必然失败。
 * 做法：回环地址起一个仅本机可访问的 ServerSocket，`proxy()` 把
 * 「远端 url + 注入头」登记成 token，返回 `http://127.0.0.1:port/p/{token}`，
 * 播放器请求它时本插件带上头转发（含 Range / 206 分段）。
 */
@CapacitorPlugin(name = "LocalProxy")
public class LocalProxyPlugin extends Plugin {

    private static final String TAG = "LocalProxyPlugin";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int MAX_REDIRECTS = 6;
    /** 转发时跳过的逐跳头 */
    private static final String[] HOP_HEADERS = {
            "host", "connection", "accept-encoding", "content-length", "transfer-encoding",
    };

    private static class Target {
        final String url;
        final Map<String, String> headers;

        Target(String url, Map<String, String> headers) {
            this.url = url;
            this.headers = headers;
        }
    }

    // OPT-14: 302 缓存条目（带时间戳，过期后回源）
    private static class RedirectEntry {
        final String url;
        final long cachedAt;

        RedirectEntry(String url) {
            this.url = url;
            this.cachedAt = System.currentTimeMillis();
        }

        boolean isExpired() {
            return System.currentTimeMillis() - cachedAt > REDIRECT_TTL_MS;
        }
    }

    private static final int MAX_TARGETS = 100;
    // OPT-14: 302 缓存容量与 TTL（签名直链过期后回源重新跟跳转）
    private static final int MAX_REDIRECT_CACHE = 200;
    private static final long REDIRECT_TTL_MS = 10 * 60 * 1000L; // 10 min

    /**
     * AND-18：token → 目标表。原实现用裸 LinkedHashMap（accessOrder LRU），
     * proxy() 写入与代理 IO 线程读取并发时可能破坏链表结构（get 会改链表顺序）。
     * 改为 synchronizedMap 包一层，保留 100 条 LRU 上限；所有读写都在锁内，
     * 且不再有跨线程迭代（原 getTokenFromUrl 已删除）。
     */
    private final Map<String, Target> targets = Collections.synchronizedMap(
            new LinkedHashMap<String, Target>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Target> eldest) {
                    return size() > MAX_TARGETS; // P0-8: LRU，最多保留 100 个 token
                }
            });
    // OPT-14: 302 跳转目标缓存（LRU + TTL，替代裸 ConcurrentHashMap）
    private final Map<String, RedirectEntry> redirectCache = Collections.synchronizedMap(
            new LinkedHashMap<String, RedirectEntry>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, RedirectEntry> eldest) {
                    return size() > MAX_REDIRECT_CACHE;
                }
            });
    // OPT-21: 有界线程池（core 2 / max 8 / queue 32），防突发并发线程爆炸
    private final ExecutorService io = new java.util.concurrent.ThreadPoolExecutor(
            2, 8, 60L, java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.LinkedBlockingQueue<>(32),
            r -> {
                Thread t = new Thread(r, "proxy-io");
                t.setDaemon(true);
                return t;
            },
            new java.util.concurrent.ThreadPoolExecutor.AbortPolicy()
    );
    // P2-7: OkHttp 共享连接池（HTTP/2 + keep-alive），替代 HttpURLConnection 逐次建连
    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .followRedirects(false)  // 手动跟跳转，保留缓存逻辑
            .followSslRedirects(true) // 允许 HTTP→HTTPS 跳转
            .build();
    private volatile ServerSocket server;
    private volatile int port = 0;

    /** 登记（url, headers) → 本地代理地址；服务未启动时惰性启动 */
    @PluginMethod
    public void proxy(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Map<String, String> headers = toStringMap(call.getObject("headers", null));
        try {
            ensureServer();
        } catch (Exception e) {
            call.reject("本地代理启动失败: " + e.getMessage());
            return;
        }
        String token = UUID.randomUUID().toString().replace("-", "");
        targets.put(token, new Target(url, headers));
        JSObject ret = new JSObject();
        ret.put("url", "http://127.0.0.1:" + port + "/p/" + token);
        call.resolve(ret);
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        call.resolve(ret);
    }

    /** 双检惰性启动：并发 proxy() 只启动一次 */
    private void ensureServer() throws Exception {
        if (server != null && !server.isClosed()) return;
        synchronized (this) {
            if (server != null && !server.isClosed()) return;
            ServerSocket socket = new ServerSocket(0, 64, java.net.InetAddress.getByName("127.0.0.1"));
            socket.setReuseAddress(true);
            port = socket.getLocalPort();
            server = socket;
            try {
                io.execute(this::acceptLoop);
                Log.i(TAG, "local proxy started on 127.0.0.1:" + port);
            } catch (java.util.concurrent.RejectedExecutionException rex) {
                // OPT-21: 线程池满时启动失败
                Log.w(TAG, "failed to start accept loop (pool full)", rex);
                try { socket.close(); } catch (Exception ignored) {}
                throw rex;
            }
        }
    }

    private void acceptLoop() {
        ServerSocket socket = server;
        if (socket == null) return;
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                try {
                    io.execute(() -> handle(client));
                } catch (java.util.concurrent.RejectedExecutionException rex) {
                    // OPT-21: 线程池满时关闭新连接
                    com.qoder.cinema.AppLog.w(TAG, "rejecting connection (pool full)", rex);
                    try { client.close(); } catch (Exception ignored) {}
                }
            } catch (Exception e) {
                if (socket.isClosed()) return;
                com.qoder.cinema.AppLog.w(TAG, "accept failed", e);
            }
        }
    }

    /** 单连接：解析请求行/Range → 带头转发 → 流式回写 */
    private void handle(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(READ_TIMEOUT_MS);
            String requestLine = readLine(c.getInputStream());
            String range = null;
            // 消费请求头，只留 Range（播放器可能先发 open 再发 range 请求）
            for (;;) {
                String line = readLine(c.getInputStream());
                if (line == null || line.isEmpty()) break;
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim().toLowerCase();
                    if (name.equals("range")) {
                        range = line.substring(colon + 1).trim();
                    }
                }
            }
            String path = requestLine != null ? requestLine.split(" ")[1] : "";
            // v1.8 优化：支持 /p/{token} 和 /p/{token}/{encoded_url} 两种格式
            String token;
            String segmentUrl = null;
            if (path.startsWith("/p/")) {
                String rest = path.substring(3);
                int slash = rest.indexOf('/');
                if (slash > 0) {
                    token = rest.substring(0, slash);
                    String encoded = rest.substring(slash + 1);
                    try {
                        segmentUrl = java.net.URLDecoder.decode(encoded, "UTF-8");
                    } catch (Exception e) {
                        segmentUrl = null;
                    }
                } else {
                    token = rest;
                }
            } else {
                token = "";
            }
            Target target = token.isEmpty() ? null : targets.get(token);
            if (target == null) {
                // AND-18：token 未命中/已过期时明确失败，绝不伪造 token 继续转发
                writeSimple(c, 404, "proxy token not found or expired");
                return;
            }
            // 如果是分片请求，用分片 URL；否则用原 URL
            Target actualTarget = segmentUrl != null ? new Target(segmentUrl, target.headers) : target;
            forward(c, actualTarget, range, token);
        } catch (Exception e) {
            com.qoder.cinema.AppLog.w(TAG, "proxy connection failed", e);
        }
    }

    private static Request.Builder buildRequest(Target target, String url, String range) {
        Request.Builder builder = new Request.Builder().url(url);
        for (Map.Entry<String, String> entry : target.headers.entrySet()) {
            String name = entry.getKey();
            boolean hop = false;
            for (String h : HOP_HEADERS) {
                if (h.equalsIgnoreCase(name)) {
                    hop = true;
                    break;
                }
            }
            if (!hop) builder.addHeader(name, entry.getValue());
        }
        if (range != null && !range.isEmpty()) {
            builder.addHeader("Range", range);
        }
        if (target.headers.get("User-Agent") == null && target.headers.get("user-agent") == null) {
            builder.addHeader("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile Safari/537.36");
        }
        return builder;
    }

    private void forward(Socket client, Target target, String range, String token) throws Exception {
        // 手动跟跳转：分片常 302 到 https 图片 CDN，OkHttp followRedirects=false 时不会自动跟
        String url = target.url;

        // OPT-14: 302 跳转目标缓存（带 TTL 检查，过期则回源）
        RedirectEntry cachedEntry = redirectCache.get(url);
        if (cachedEntry != null && !cachedEntry.isExpired()) {
            url = cachedEntry.url;
        } else if (cachedEntry != null) {
            redirectCache.remove(url);
        }

        Request request = buildRequest(target, url, range).build();
        Response response = httpClient.newCall(request).execute();
        int status = response.code();
        
        for (int hop = 0; hop < MAX_REDIRECTS && status >= 300 && status < 400; hop++) {
            String location = response.header("Location");
            if (location == null || location.isEmpty()) break;
            response.close();
            url = new java.net.URL(new java.net.URL(url), location).toString();
            request = buildRequest(target, url, range).build();
            response = httpClient.newCall(request).execute();
            status = response.code();
        }

        // OPT-14: 缓存跳转结果（带时间戳）
        if (!url.equals(target.url)) {
            redirectCache.put(target.url, new RedirectEntry(url));
        }

        OutputStream out = client.getOutputStream();
        StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(" ")
                .append(response.message() == null ? "" : response.message())
                .append("\r\n");
        boolean hasLength = false;
        // 原始地址或 302 最终地址任一为 .m3u8 都按清单处理
        boolean isM3u8 = url.toLowerCase().contains(".m3u8") || target.url.toLowerCase().contains(".m3u8");
        
        for (String name : response.headers().names()) {
            if (name == null) continue;
            String lower = name.toLowerCase();
            if (lower.equals("transfer-encoding") || lower.equals("connection")) continue;
            // P0-8: m3u8 重写时删 Content-Length
            if (isM3u8 && lower.equals("content-length")) continue;
            for (String value : response.headers(name)) {
                head.append(name).append(": ").append(value).append("\r\n");
                if (lower.equals("content-length")) hasLength = true;
            }
        }
        // v1.8 优化：所有代理响应补 ACAO 头
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Access-Control-Allow-Methods: GET, HEAD, Range\r\n");
        head.append("Access-Control-Allow-Headers: *\r\n");
        if (!hasLength) {
            head.append("Connection: close\r\n");
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        
        try (ResponseBody body = response.body()) {
            if (body != null) {
                // v1.8 优化：m3u8 清单需要重写相对 URL
                if (isM3u8 && status < 400) {
                    StringBuilder m3u8Body = new StringBuilder();
                    byte[] buffer = new byte[32 * 1024];
                    int read;
                    InputStream in = body.byteStream();
                    while ((read = in.read(buffer)) != -1) {
                        m3u8Body.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
                    }
                    String rewritten = rewriteM3u8(m3u8Body.toString(), url, token);
                    out.write(rewritten.getBytes(StandardCharsets.UTF_8));
                } else {
                    byte[] buffer = new byte[32 * 1024];
                    int read;
                    InputStream in = body.byteStream();
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }
            }
        } finally {
            out.flush();
            response.close();
        }
    }

    private static void writeSimple(Socket client, int status, String message) throws Exception {
        String body = message;
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + message + "\r\n"
                + "Content-Type: text/plain\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream out = client.getOutputStream();
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }

    private static String readLine(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
        }
        return sb.length() == 0 && b == -1 ? null : sb.toString();
    }

    private static Map<String, String> toStringMap(JSObject obj) {
        Map<String, String> out = new ConcurrentHashMap<>();
        if (obj == null) return out;
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                Object value = obj.get(key);
                if (value != null) out.put(key, String.valueOf(value));
            } catch (Exception ignored) {
                // 单个键取值失败不影响其余头
            }
        }
        return out;
    }

    /** v1.8 优化：重写 m3u8 清单中的相对 URL 为代理绝对 URL */
    private String rewriteM3u8(String manifest, String baseUrl, String token) {
        try {
            URL base = new URL(baseUrl);
            String baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            StringBuilder result = new StringBuilder();
            String[] lines = manifest.split("\n");
            for (String line : lines) {
                String trimmed = line.trim();
                // 跳过注释和空行
                if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                    // 处理 #EXT-X-MAP / #EXT-X-KEY / #EXT-X-MEDIA 等带 URI= 的标签：
                    // 漏掉 KEY 会让 AES-128 的相对密钥被解析到 127.0.0.1 导致解密失败
                    if (trimmed.startsWith("#EXT-X-") && trimmed.contains("URI=\"")) {
                        int start = trimmed.indexOf("URI=\"") + 5;
                        int end = trimmed.indexOf("\"", start);
                        if (end > start) {
                            String uri = trimmed.substring(start, end);
                            if (!uri.startsWith("http")) {
                                String absolute = resolveUrl(baseDir, uri);
                                String proxyUrl = "http://127.0.0.1:" + port + "/p/" + token + "/" + java.net.URLEncoder.encode(absolute, "UTF-8");
                                result.append(trimmed.substring(0, start)).append(proxyUrl).append(trimmed.substring(end));
                            } else {
                                result.append(line);
                            }
                        } else {
                            result.append(line);
                        }
                    } else {
                        result.append(line);
                    }
                } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                    // 绝对 URL：直接代理
                    String proxyUrl = "http://127.0.0.1:" + port + "/p/" + token + "/" + java.net.URLEncoder.encode(trimmed, "UTF-8");
                    result.append(proxyUrl);
                } else {
                    // 相对 URL：解析为绝对后代理
                    String absolute = resolveUrl(baseDir, trimmed);
                    String proxyUrl = "http://127.0.0.1:" + port + "/p/" + token + "/" + java.net.URLEncoder.encode(absolute, "UTF-8");
                    result.append(proxyUrl);
                }
                result.append("\n");
            }
            return result.toString();
        } catch (Exception e) {
            com.qoder.cinema.AppLog.w(TAG, "rewriteM3u8 failed, returning original", e);
            return manifest;
        }
    }

    private String resolveUrl(String baseDir, String relative) {
        if (relative.startsWith("/")) {
            // 绝对路径：取域名为 base
            try {
                URL base = new URL(baseDir);
                return base.getProtocol() + "://" + base.getHost() + (base.getPort() > 0 ? ":" + base.getPort() : "") + relative;
            } catch (Exception e) {
                return baseDir + relative;
            }
        } else {
            return baseDir + relative;
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (server != null && !server.isClosed()) server.close();
        } catch (Exception ignored) {
        }
        io.shutdownNow();
        targets.clear();
    }
}
