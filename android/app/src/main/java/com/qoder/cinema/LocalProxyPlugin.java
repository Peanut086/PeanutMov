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

    private final Map<String, Target> targets = new ConcurrentHashMap<>();
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
                Log.w(TAG, "accept failed", e);
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
            String token = path.startsWith("/p/") ? path.substring(3) : "";
            Target target = token.isEmpty() ? null : targets.get(token);
            if (target == null) {
                writeSimple(c, 404, "not found");
                return;
            }
            forward(c, target, range);
        } catch (Exception e) {
            Log.w(TAG, "proxy connection failed", e);
        }
    }

    private void forward(Socket client, Target target, String range) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(target.url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
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
        int status = conn.getResponseCode();
        OutputStream out = client.getOutputStream();
        StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(" ")
                .append(conn.getResponseMessage() == null ? "" : conn.getResponseMessage())
                .append("\r\n");
        boolean hasLength = false;
        for (Map.Entry<String, java.util.List<String>> entry : conn.getHeaderFields().entrySet()) {
            String name = entry.getKey();
            if (name == null) continue; // 状态行
            String lower = name.toLowerCase();
            if (lower.equals("transfer-encoding") || lower.equals("connection")) continue;
            for (String value : entry.getValue()) {
                head.append(name).append(": ").append(value).append("\r\n");
                if (lower.equals("content-length")) hasLength = true;
            }
        }
        if (!hasLength) {
            head.append("Connection: close\r\n");
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        try (InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
            if (in != null) {
                byte[] buffer = new byte[32 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
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
