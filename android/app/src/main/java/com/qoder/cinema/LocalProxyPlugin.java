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
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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

    private final Map<String, Target> targets = new java.util.LinkedHashMap<String, Target>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Target> eldest) {
            return size() > 100; // P0-8: LRU，最多保留 100 个 token
        }
    };
    // P0-8: 302 跳转目标缓存（原始 URL → 最终 URL）
    private final Map<String, String> redirectCache = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newCachedThreadPool();
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
            io.execute(this::acceptLoop);
            Log.i(TAG, "local proxy started on 127.0.0.1:" + port);
        }
    }

    private void acceptLoop() {
        ServerSocket socket = server;
        if (socket == null) return;
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                io.execute(() -> handle(client));
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
                writeSimple(c, 404, "not found");
                return;
            }
            // 如果是分片请求，用分片 URL；否则用原 URL
            Target actualTarget = segmentUrl != null ? new Target(segmentUrl, target.headers) : target;
            forward(c, actualTarget, range);
        } catch (Exception e) {
            com.qoder.cinema.AppLog.w(TAG, "proxy connection failed", e);
        }
    }

    private static HttpURLConnection openConnection(Target target, String url, String range) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(false);
        for (Map.Entry<String, String> entry : target.headers.entrySet()) {
            String name = entry.getKey();
            boolean hop = false;
            for (String h : HOP_HEADERS) {
                if (h.equalsIgnoreCase(name)) {
                    hop = true;
                    break;
                }
            }
            if (!hop) conn.setRequestProperty(name, entry.getValue());
        }
        if (range != null && !range.isEmpty()) {
            conn.setRequestProperty("Range", range);
        }
        if (conn.getRequestProperty("User-Agent") == null) {
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile Safari/537.36");
        }
        return conn;
    }

    private void forward(Socket client, Target target, String range) throws Exception {
        // 手动跟跳转：分片常 302 到 https 图片 CDN，而 HttpURLConnection 的
        // setInstanceFollowRedirects 不会跨协议（http→https）跟随，3xx 会原样
        // 冒到 CapacitorHttp 触发 "statusCode can't be in the [300, 399] range"。
        String url = target.url;

        // P0-8: 302 跳转目标缓存
        String cachedRedirect = redirectCache.get(url);
        if (cachedRedirect != null) {
            url = cachedRedirect;
        }

        HttpURLConnection conn = openConnection(target, url, range);
        int status = conn.getResponseCode();
        for (int hop = 0; hop < MAX_REDIRECTS && status >= 300 && status < 400; hop++) {
            String location = conn.getHeaderField("Location");
            if (location == null || location.isEmpty()) break;
            String next = new URL(new URL(url), location).toString();
            conn.disconnect();
            url = next;
            conn = openConnection(target, url, range);
            status = conn.getResponseCode();
        }

        // P0-8: 缓存跳转结果
        if (!url.equals(target.url)) {
            redirectCache.put(target.url, url);
        }

        OutputStream out = client.getOutputStream();
        StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(" ")
                .append(conn.getResponseMessage() == null ? "" : conn.getResponseMessage())
                .append("\r\n");
        boolean hasLength = false;
        boolean isM3u8 = target.url.toLowerCase().contains(".m3u8");
        StringBuilder body = null;
        for (Map.Entry<String, java.util.List<String>> entry : conn.getHeaderFields().entrySet()) {
            String name = entry.getKey();
            if (name == null) continue; // 状态行
            String lower = name.toLowerCase();
            if (lower.equals("transfer-encoding") || lower.equals("connection")) continue;
            // P0-8: m3u8 重写时删 Content-Length（长度会变）
            if (isM3u8 && lower.equals("content-length")) continue;
            for (String value : entry.getValue()) {
                head.append(name).append(": ").append(value).append("\r\n");
                if (lower.equals("content-length")) hasLength = true;
            }
        }
        // v1.8 优化：所有代理响应补 ACAO 头，解决 WebView CORS 限制
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Access-Control-Allow-Methods: GET, HEAD, Range\r\n");
        head.append("Access-Control-Allow-Headers: *\r\n");
        if (!hasLength) {
            head.append("Connection: close\r\n");
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        try (InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
            if (in != null) {
                // v1.8 优化：m3u8 清单需要重写相对 URL 为代理 URL
                if (isM3u8 && status < 400) {
                    body = new StringBuilder();
                    byte[] buffer = new byte[32 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        body.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
                    }
                    String rewritten = rewriteM3u8(body.toString(), target.url, getTokenFromUrl(target.url));
                    out.write(rewritten.getBytes(StandardCharsets.UTF_8));
                } else {
                    byte[] buffer = new byte[32 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }
            }
        } finally {
            out.flush();
            conn.disconnect();
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
                    // 处理 #EXT-X-MAP 等带 URI= 的标签
                    if (trimmed.startsWith("#EXT-X-MAP:URI=\"")) {
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

    private String getTokenFromUrl(String url) {
        // 从 targets 中找到对应的 token
        for (Map.Entry<String, Target> entry : targets.entrySet()) {
            if (entry.getValue().url.equals(url)) {
                return entry.getKey();
            }
        }
        return UUID.randomUUID().toString().replace("-", "");
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
