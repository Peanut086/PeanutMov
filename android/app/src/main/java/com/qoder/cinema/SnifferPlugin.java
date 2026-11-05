package com.qoder.cinema;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Sniffer —— WebView 媒体嗅探（parse=1 / jx 解析器支持）
 *
 * 语义：离屏加载解析页，页面 JS 执行后发起的 m3u8 / mp4 等媒体请求在
 * `shouldInterceptRequest` 里捕获，第一个命中即 resolve 并销毁 WebView。
 * TVBox 的「嗅探」即此法；不做任何页面内容注入或 JS 桥接。
 */
@CapacitorPlugin(name = "Sniffer")
public class SnifferPlugin extends Plugin {

    private static final String TAG = "SnifferPlugin";
    private static final long DEFAULT_TIMEOUT_MS = 15_000;
    private static final long MAX_TIMEOUT_MS = 30_000;

    /**
     * P1-5: 媒体请求特征扩展——覆盖更多格式与 URL 形态
     *
     * 原始只匹配 .m3u8/.mp4/.m4v/.mkv/.flv，真机实测漏掉：
     * - .ts（HLS 分片直链，部分源直接返回 TS 而非清单）
     * - .webm（WebM 格式）
     * - /video/、/stream 等无扩展名但 Content-Type 为媒体的路径
     * - 含 type=video 查询参数的 CDN 地址
     */
    private static final Pattern MEDIA_URL = Pattern.compile(
            "(\\.(m3u8|mp4|m4v|mkv|flv|ts|webm|mov|avi)(\\?|#|$)" +
            "|/video/[^?#]+" +
            "|/stream[^?#]*" +
            "|[?&]type=video" +
            "|[?&]format=(mp4|m3u8|ts|webm))",
            Pattern.CASE_INSENSITIVE);

    /** 响应 响应 拦截的 Content-Type（shouldInterceptRequest 无法读 response header，留作扩展点） */
    private static final Pattern MEDIA_MIME = Pattern.compile(
            "^(video/|application/x-mpegURL|application/vnd\\.apple\\.mpegurl)",
            Pattern.CASE_INSENSITIVE);

    private final Handler main = new Handler(Looper.getMainLooper());

    private static class SniffJob {
        final PluginCall call;
        final WebView webView;
        final AtomicBoolean settled = new AtomicBoolean(false);
        final Runnable timeoutTask;

        SniffJob(PluginCall call, WebView webView, Runnable timeoutTask) {
            this.call = call;
            this.webView = webView;
            this.timeoutTask = timeoutTask;
        }
    }

    private final Map<String, SniffJob> jobs = new ConcurrentHashMap<>();
    private int jobSeq = 0;

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void sniff(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Map<String, String> headers = toStringMap(call.getObject("headers", null));
        long requestedTimeoutMs = call.getLong("timeoutMs", DEFAULT_TIMEOUT_MS);
        final long timeoutMs =
                requestedTimeoutMs <= 0 || requestedTimeoutMs > MAX_TIMEOUT_MS
                        ? DEFAULT_TIMEOUT_MS
                        : requestedTimeoutMs;

        final String jobId = "sniff-" + (++jobSeq);
        main.post(() -> {
            try {
                startSniff(call, jobId, url, headers, timeoutMs);
            } catch (Exception e) {
                jobs.remove(jobId);
                Log.w(TAG, "sniff setup failed", e);
                call.reject("嗅探启动失败: " + e.getMessage());
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void startSniff(PluginCall call, String jobId, String url,
                            Map<String, String> headers, long timeoutMs) {
        WebView webView = new WebView(getContext());
        Runnable timeoutTask = () -> finish(jobId, null);
        SniffJob job = new SniffJob(call, webView, timeoutTask);
        jobs.put(jobId, job);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setBlockNetworkImage(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        String ua = headers != null ? headers.get("User-Agent") : null;
        if (ua == null || ua.isEmpty()) {
            ua = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile Safari/537.36";
        }
        settings.setUserAgentString(ua);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                if (!target.equals(url) && MEDIA_URL.matcher(target).find()) {
                    finish(jobId, target);
                }
                return null;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // 解析页证书质量参差；嗅探只读不提交任何数据，放行以换取可用性
                handler.proceed();
            }

            @Override
            public void onPageStarted(WebView view, String target, Bitmap favicon) {
                // 页面 302 直接跳到媒体地址的情形：onPageStarted 里也能捕获
                if (!target.equals(url) && MEDIA_URL.matcher(target).find()) {
                    finish(jobId, target);
                }
            }
        });

        if (headers != null && !headers.isEmpty()) {
            webView.loadUrl(url, headers);
        } else {
            webView.loadUrl(url);
        }
        main.postDelayed(timeoutTask, timeoutMs);
    }

    /** 命中（mediaUrl 非 null）或超时（null）：统一 resolve，销毁 WebView */
    private void finish(String jobId, String mediaUrl) {
        SniffJob job = jobs.remove(jobId);
        if (job == null) return;
        if (!job.settled.compareAndSet(false, true)) return;
        main.removeCallbacks(job.timeoutTask);
        main.post(() -> {
            try {
                job.webView.stopLoading();
                job.webView.destroy();
            } catch (Exception ignored) {
            }
            JSObject ret = new JSObject();
            ret.put("url", mediaUrl);
            job.call.resolve(ret);
        });
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
        for (Map.Entry<String, SniffJob> entry : jobs.entrySet()) {
            SniffJob job = entry.getValue();
            if (!job.settled.compareAndSet(false, true)) continue;
            main.removeCallbacks(job.timeoutTask);
            main.post(() -> {
                try {
                    job.webView.destroy();
                } catch (Exception ignored) {
                }
            });
        }
        jobs.clear();
    }
}
