package com.qoder.cinema;

import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 本地代理服务（TVBox 约定端口 9978）
 *
 * 壳子系爬虫（AppTT 等）在 playerContent 内部会同步请求
 * `http://127.0.0.1:9978/proxy?do=...`（ProxyOrigin.getUrl），由宿主的本地代理
 * 路由到 spider.proxy(Map) 换取直链/内容。宿主没有这个服务时该请求
 * ECONNREFUSED，爬虫只能降级返回中转地址（真机实证 2026-11-03）。
 *
 * 自愈（真机实证 2026-11-03 Mate 50 / EMUI 14.2）：地址必须用字面量 "127.0.0.1" ——
 * 该设备 `InetAddress.getLoopbackAddress()` 返回 IPv6 回环 ::1，绑上去之后爬虫的
 * okhttp 连 127.0.0.1（IPv4）永远 ECONNREFUSED，且日志看不出差异（曾硬编码假地址
 * 隐瞒了真相）。同时保留功能性探测 + 重绑自愈：任何情况下端口失活（线程被杀、
 * fd 被收）都能在下一次爬虫任务前恢复，不依赖根因假设。
 *
 * 语义对齐 catvod Proxy：结果 [0] 是 http(s) 地址 → 302；是 JSON {url:...} → 302；
 * 其余按内容 200 返回（#EXTM3U 补 mpegurl 类型）；null/空 → 404。
 * 只绑 127.0.0.1，不对外网暴露。
 */
public final class SpiderProxyServer {
    private static final String TAG = "SpiderProxyServer";
    public static final int PORT = 9978;
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int SOCKET_TIMEOUT_MS = 10_000;
    /** 探测结果缓存：健康判定后短时间内不重复探测 */
    private static final int PROBE_CACHE_MS = 3_000;
    /** watchdog 心跳超过该时长视为被冻结，重新拉起 */
    private static final int WATCHDOG_STALE_MS = 20_000;
    /** 探测专用 do，routeProxy 优先短路返回，避免遍历全部爬虫 */
    public static final String PROBE_DO = "__ping";
    /** m3u8 行内 URI 属性（#EXT-X-KEY/MEDIA/MAP 等） */
    private static final java.util.regex.Pattern URI_ATTR =
            java.util.regex.Pattern.compile("(URI=\")([^\"]*)(\")");

    /** 由 SpiderPlugin 提供：遍历已加载爬虫调 proxy(Map)，无结果返回 null */
    public interface Handler {
        Object[] proxy(Map<String, String> params);
    }

    private static final AtomicBoolean STARTED = new AtomicBoolean(false);
    private static volatile Handler handler;
    private static volatile ServerSocket bound;
    private static volatile long lastHealthyAt;
    private static volatile long watchdogBeatAt;
    private static final Object REVIVE_LOCK = new Object();

    /** passthrough 清单短缓存：并发解析/hls.js 重取主清单不再重复打上游 */
    private static final long PASSTHROUGH_CACHE_MS = 30_000;
    private static final int PASSTHROUGH_CACHE_MAX = 8;
    private static final java.util.concurrent.ConcurrentHashMap<String, PassEntry> PASS_CACHE =
            new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, Object> PASS_INFLIGHT =
            new java.util.concurrent.ConcurrentHashMap<>();

    private static final class PassEntry {
        final Object[] payload;
        final long at;
        PassEntry(Object[] payload, long at) {
            this.payload = payload;
            this.at = at;
        }
    }

    private SpiderProxyServer() {
    }

    /** 幂等启动 */
    public static void start(Handler h) {
        handler = h;
        STARTED.set(true);
        ensureAlive();
    }

    public static void stop() {
        STARTED.set(false);
    }

    /**
     * 确保端口功能可用，爬虫任务执行前同步调用（健康时仅一次回环 HTTP 探测，
     * ~1ms 且有 3 秒缓存）。冻结/死亡都走 revive 重绑。
     */
    public static void ensureAlive() {
        if (!STARTED.get()) return;
        long now = SystemClockNow();
        if (now - lastHealthyAt < PROBE_CACHE_MS) return;
        if (probeHealthy()) {
            lastHealthyAt = SystemClockNow();
            return;
        }
        revive("ensureAlive");
        ensureWatchdog();
    }

    private static long SystemClockNow() {
        return android.os.SystemClock.uptimeMillis();
    }

    /** 功能性探测：回环 TCP + HTTP 请求 + 收到任意 HTTP 响应行才算健康。
     *  监听线程被冻（socket 还开着）时连接能建立但永远等不到响应，靠读超时识别。 */
    private static boolean probeHealthy() {
        try (Socket probe = new Socket()) {
            probe.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 800);
            probe.setSoTimeout(800);
            OutputStream out = probe.getOutputStream();
            out.write(("GET /proxy?do=" + PROBE_DO + " HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    + "Connection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(probe.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = reader.readLine();
            return line != null && line.startsWith("HTTP/1.");
        } catch (Throwable e) {
            Log.w(TAG, "probe failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return false;
        }
    }

    /** 关旧 socket（可能还占着端口）→ 拉起新 accept 线程 → 探测确认 */
    private static void revive(String why) {
        synchronized (REVIVE_LOCK) {
            if (probeHealthy()) {
                lastHealthyAt = SystemClockNow();
                return;
            }
            Log.w(TAG, "reviving proxy server (" + why + ")");
            ServerSocket old = bound;
            if (old != null) {
                try {
                    old.close();
                } catch (IOException ignored) {
                    // fd 可能已被系统回收
                }
                bound = null;
            }
            Thread fresh = new Thread(SpiderProxyServer::serveLoop, "spider-proxy-accept");
            fresh.setDaemon(true);
            fresh.start();
            // 给新线程一点绑定时间再确认；确认结果写进 lastHealthyAt
            for (int i = 0; i < 20 && !probeHealthy(); i++) {
                try {
                    Thread.sleep(50);
                } catch (InterruptedException ie) {
                    return;
                }
            }
            if (probeHealthy()) {
                lastHealthyAt = SystemClockNow();
                Log.i(TAG, "proxy server revived and verified");
            } else {
                Log.w(TAG, "proxy server revive NOT verified (bind may be failing)");
            }
        }
    }

    /**
     * 自愈式 accept 循环：socket 被关/绑定失败都会重试。
     * 连续绑定失败（端口被其它线程持有，如僵尸复活线程）最多 5 次后退出，
     * 由 revive 按需重新拉起，避免僵尸线程无限刷日志。
     */
    private static void serveLoop() {
        int bindFailures = 0;
        while (STARTED.get()) {
            try (ServerSocket server = new ServerSocket()) {
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 64);
                bindFailures = 0;
                bound = server;
                lastHealthyAt = SystemClockNow();
                Log.i(TAG, "local proxy listening on " + server.getInetAddress() + ":" + PORT);
                while (true) {
                    Socket socket = server.accept();
                    Thread worker = new Thread(() -> handle(socket), "spider-proxy-conn");
                    worker.setDaemon(true);
                    worker.start();
                }
            } catch (Throwable e) {
                if (!STARTED.get()) return;
                Log.w(TAG, "proxy loop exited: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            } finally {
                bound = null;
            }
            if (!STARTED.get()) return;
            if (++bindFailures > 5) {
                Log.w(TAG, "bind kept failing, giving up this loop thread");
                return;
            }
            try {
                Thread.sleep(1_000);
            } catch (InterruptedException ie) {
                return;
            }
            Log.i(TAG, "proxy loop rebinding");
        }
    }

    /** watchdog：周期功能探测 + 自动复活；自身被冻时由 ensureAlive 重新拉起 */
    private static void ensureWatchdog() {
        if (SystemClockNow() - watchdogBeatAt < WATCHDOG_STALE_MS) return;
        synchronized (REVIVE_LOCK) {
            if (SystemClockNow() - watchdogBeatAt < WATCHDOG_STALE_MS) return;
            Thread fresh = new Thread(SpiderProxyServer::watchdogLoop, "spider-proxy-watchdog");
            fresh.setDaemon(true);
            fresh.start();
        }
    }

    private static void watchdogLoop() {
        while (STARTED.get()) {
            watchdogBeatAt = SystemClockNow();
            try {
                Thread.sleep(5_000);
            } catch (InterruptedException ie) {
                return;
            }
            if (!STARTED.get()) return;
            if (SystemClockNow() - lastHealthyAt < PROBE_CACHE_MS) continue;
            if (!probeHealthy()) {
                revive("watchdog");
            }
        }
    }

    private static void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(SOCKET_TIMEOUT_MS);
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;
            lastHealthyAt = SystemClockNow();
            if (requestLine.contains("do=" + PROBE_DO)) {
                respond(s, 200, "text/plain; charset=utf-8", "pong".getBytes(StandardCharsets.UTF_8), null);
                return;
            }
            Log.i(TAG, "req " + requestLine);
            int headerBytes = requestLine.length() + 2;
            String line;
            long contentLength = 0;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                headerBytes += line.length() + 2;
                if (headerBytes > MAX_HEADER_BYTES) return;
                String lower = line.toLowerCase();
                if (lower.startsWith("content-length:")) {
                    contentLength = parseLongOr(line.substring(15).trim(), 0);
                }
            }
            // 请求体（若有）读完即弃：代理只看查询参数
            if (contentLength > 0) {
                long skipped = 0;
                while (skipped < contentLength) {
                    long n = s.getInputStream().skip(contentLength - skipped);
                    if (n <= 0) break;
                    skipped += n;
                }
            }

            Map<String, String> params = parseQuery(requestLine);
            String doParam = params.get("do");
            // TVBox 壳级探活约定：爬虫 adjustPort 发 do=ck，壳直接 200 即视为端口可用
            // （真机实证：404 会让爬虫以为端口死了，扫遍 9978-9999 后降级）
            if ("ck".equals(doParam)) {
                respond(s, 200, "text/plain; charset=utf-8", "ok".getBytes(StandardCharsets.UTF_8), null);
                return;
            }
            Object[] result = handler != null ? handler.proxy(params) : null;
            // 壳级兜底：爬虫返回 do=m3u8&url=... 而没有任何爬虫 proxy 认领时，直取转发
            if (result == null || result.length == 0 || result[0] == null
                    || String.valueOf(result[0]).trim().isEmpty()) {
                result = passThrough(params);
            }

            if (result == null || result.length == 0 || result[0] == null
                    || String.valueOf(result[0]).trim().isEmpty()) {
                Log.w(TAG, "res 404 (no handler) do=" + doParam);
                respond(s, 404, "text/plain; charset=utf-8", "no proxy handler".getBytes(StandardCharsets.UTF_8),
                        null);
                return;
            }

            String first = String.valueOf(result[0]).trim();
            @SuppressWarnings("unchecked")
            Map<String, String> extraHeaders = result.length > 1 && result[1] instanceof Map
                    ? (Map<String, String>) result[1]
                    : null;

            if (first.startsWith("http://") || first.startsWith("https://")) {
                Log.i(TAG, "res 302 " + first);
                respond(s, 302, null, new byte[0], first);
                return;
            }
            if (first.startsWith("{")) {
                String url = jsonUrlOf(first);
                if (url != null) {
                    Log.i(TAG, "res 302 (json) " + url);
                    respond(s, 302, null, new byte[0], url);
                    return;
                }
            }

            String contentType = extraHeaders != null && extraHeaders.get("Content-Type") != null
                    ? extraHeaders.get("Content-Type")
                    : null;
            if (contentType == null) {
                contentType = first.startsWith("#EXTM3U")
                        ? "application/vnd.apple.mpegurl"
                        : "text/plain; charset=utf-8";
            }
            Log.i(TAG, "res 200 ct=" + contentType + " len=" + first.length());
            respond(s, 200, contentType, first.getBytes(StandardCharsets.UTF_8), null);
        } catch (SocketTimeoutException ignored) {
            // 客户端超时/断开：连接自然关闭
        } catch (Exception e) {
            Log.w(TAG, "proxy request failed: " + e);
        }
    }

    /**
     * 壳级兜底（TVBox 本地代理常规行为）：`do=m3u8&url=<绝对地址>` 且无爬虫认领时，
     * 直取该地址并相对化改写为绝对 URI（hls.js 会以本代理 URL 为基解析相对分段，
     * 不改写则二级清单/分段全部 404）。非 m3u8 或地址非法返回 null 走 404。
     *
     * 带 30s 短缓存 + 并发合并：真机实证（2026-11-03）冷启动首抓 CDN 要 ~7s，
     * 失败换线会并发发起两路同一清单的解析，第二路在 8s 客户端超时下必败并引发
     * 错误的错误回退；合并后只打一次上游，hls.js 重取主清单也直接命中缓存。
     */
    private static Object[] passThrough(Map<String, String> params) {
        if (!"m3u8".equals(params.get("do"))) return null;
        String url = params.get("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return null;

        PassEntry hit = PASS_CACHE.get(url);
        if (hit != null && SystemClockNow() - hit.at < PASSTHROUGH_CACHE_MS) {
            Log.i(TAG, "passthrough cache len=" + ((String) hit.payload[0]).length() + " url=" + url);
            return hit.payload;
        }
        Object lock = PASS_INFLIGHT.computeIfAbsent(url, k -> new Object());
        if (PASS_INFLIGHT.size() > 32) PASS_INFLIGHT.clear();
        synchronized (lock) {
            hit = PASS_CACHE.get(url);
            if (hit != null && SystemClockNow() - hit.at < PASSTHROUGH_CACHE_MS) return hit.payload;
            try {
                Object[] result = fetchPassthrough(url);
                if (result != null) {
                    if (PASS_CACHE.size() >= PASSTHROUGH_CACHE_MAX) PASS_CACHE.clear();
                    PASS_CACHE.put(url, new PassEntry(result, SystemClockNow()));
                }
                return result;
            } finally {
                PASS_INFLIGHT.remove(url, lock);
            }
        }
    }

    private static Object[] fetchPassthrough(String url) {
        try {
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(8_000);
            conn.setReadTimeout(8_000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                Log.w(TAG, "passthrough upstream " + status + " url=" + url);
                return null;
            }
            java.io.InputStream in = status >= 200 && status < 400 ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            String body = new String(buf.toByteArray(), StandardCharsets.UTF_8);
            Map<String, String> headers = new LinkedHashMap<>();
            String rewritten = body;
            if (body.stripLeading().startsWith("#EXTM3U")) {
                headers.put("Content-Type", "application/vnd.apple.mpegurl");
                rewritten = absolutize(body, url);
            } else {
                headers.put("Content-Type", "text/plain; charset=utf-8");
            }
            Log.i(TAG, "passthrough " + status + " len=" + rewritten.length() + " url=" + url);
            return new Object[]{rewritten, headers};
        } catch (Exception e) {
            Log.w(TAG, "passthrough failed: " + e + " url=" + url);
            return null;
        }
    }

    /** m3u8 相对地址 → 绝对地址（行级：非 # 行为地址，# 行重写 URI="..." 属性） */
    private static String absolutize(String playlist, String base) {
        java.net.URI baseUri;
        try {
            baseUri = java.net.URI.create(base);
        } catch (Exception e) {
            return playlist;
        }
        StringBuilder out = new StringBuilder(playlist.length() + 512);
        for (String line : playlist.split("\r?\n", -1)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                out.append(line).append('\n');
                continue;
            }
            if (trimmed.charAt(0) == '#') {
                java.util.regex.Matcher m = URI_ATTR.matcher(trimmed);
                StringBuffer sb = new StringBuffer();
                while (m.find()) {
                    String resolved = resolveQuiet(baseUri, m.group(2));
                    m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(m.group(1) + resolved + "\""));
                }
                m.appendTail(sb);
                out.append(sb).append('\n');
            } else {
                out.append(resolveQuiet(baseUri, trimmed)).append('\n');
            }
        }
        return out.toString();
    }

    private static String resolveQuiet(java.net.URI base, String ref) {
        try {
            return base.resolve(ref).toString();
        } catch (Exception e) {
            return ref;
        }
    }

    /** 请求行 `GET /proxy?do=x&url=y HTTP/1.1` → 查询参数（保持顺序，重复键取后者） */
    private static Map<String, String> parseQuery(String requestLine) {
        Map<String, String> out = new LinkedHashMap<>();
        int queryStart = requestLine.indexOf('?');
        if (queryStart < 0) return out;
        int queryEnd = requestLine.lastIndexOf(' ');
        if (queryEnd < queryStart) queryEnd = requestLine.length();
        String query = requestLine.substring(queryStart + 1, queryEnd);
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String key = eq >= 0 ? pair.substring(0, eq) : pair;
            String value = eq >= 0 ? pair.substring(eq + 1) : "";
            try {
                out.put(URLDecoder.decode(key, "UTF-8"), URLDecoder.decode(value, "UTF-8"));
            } catch (Exception ignored) {
                out.put(key, value);
            }
        }
        return out;
    }

    /** JSON 字符串里提取 url 字段（防御性：不是合法 JSON 或没有 url → null） */
    private static String jsonUrlOf(String json) {
        try {
            org.json.JSONObject obj = new org.json.JSONObject(json);
            String url = obj.optString("url", null);
            return url != null && (url.startsWith("http://") || url.startsWith("https://")) ? url : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void respond(Socket socket, int status, String contentType, byte[] body, String location)
            throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ')
                .append(status == 200 ? "OK" : status == 302 ? "Found" : "Not Found").append("\r\n");
        if (location != null) head.append("Location: ").append(location).append("\r\n");
        if (contentType != null) head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        head.append("Connection: close\r\n\r\n");
        OutputStream out = socket.getOutputStream();
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (body.length > 0) out.write(body);
        out.flush();
    }

    private static long parseLongOr(String value, long fallback) {
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
