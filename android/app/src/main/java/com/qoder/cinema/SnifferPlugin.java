package com.qoder.cinema;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
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
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
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
            "|(m3u8|mp4)(\\?|#|$|/)" +
            "|/video/[^?#]+" +
            "|/play/[^?#]+" +
            "|/vodplay/[^?#]+" +
            "|/stream[^?#]*" +
            "|[?&]type=video" +
            "|[?&]format=(mp4|m3u8|ts|webm))",
            Pattern.CASE_INSENSITIVE);

    /** 静态资源后缀：video.src 上报时排除，避免把播放器脚本/封面当媒体 */
    private static final Pattern ASSET_URL = Pattern.compile(
            "\\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|json)(\\?|#|$)",
            Pattern.CASE_INSENSITIVE);

    /**
     * 页面注入脚本：hook fetch/XHR/媒体 src setter，并轮询 video/audio/source 标签。
     * Guard 源常见无扩展名直链、靠 JS 给 video.src 赋值的播放器，仅靠请求 URL 特征会漏嗅。
     * media() 为权威上报（播放器自己认定的地址），request() 仍按 MEDIA_URL 过滤防 JSON 误报。
     */
    private static final String INJECT_JS =
            "(function(){" +
            "if(window.__pnSniff)return;window.__pnSniff=true;" +
            "var B=window.PeanutSniffer;if(!B)return;" +
            "function media(u){try{if(u&&/^https?:/i.test(u))B.media(String(u));}catch(e){}}" +
            "function req(u){try{if(u&&/^https?:/i.test(u))B.request(String(u));}catch(e){}}" +
            "var d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');" +
            "if(d&&d.set)Object.defineProperty(HTMLMediaElement.prototype,'src',{" +
            "configurable:true,get:d.get,set:function(v){media(v);return d.set.call(this,v);}});" +
            "var of=window.fetch;if(of)window.fetch=function(i){try{req(typeof i==='string'?i:(i&&i.url));}catch(e){}return of.apply(this,arguments);};" +
            "var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){req(u);return oo.apply(this,arguments);};" +
            "setInterval(function(){var els=document.querySelectorAll('video,audio,source');" +
            "for(var i=0;i<els.length;i++){var e=els[i];media(e.currentSrc||e.src);}},500);" +
            "})();";

    /** 响应 响应 拦截的 Content-Type（shouldInterceptRequest 无法读 response header，留作扩展点） */
    private static final Pattern MEDIA_MIME = Pattern.compile(
            "^(video/|application/x-mpegURL|application/vnd\\.apple\\.mpegurl)",
            Pattern.CASE_INSENSITIVE);

    private final Handler main = new Handler(Looper.getMainLooper());

    private static class SniffJob {
        final PluginCall call;
        final WebView webView;
        final String pageUrl;
        final AtomicBoolean settled = new AtomicBoolean(false);
        final Runnable timeoutTask;

        SniffJob(PluginCall call, WebView webView, String pageUrl, Runnable timeoutTask) {
            this.call = call;
            this.webView = webView;
            this.pageUrl = pageUrl;
            this.timeoutTask = timeoutTask;
        }
    }

    /** 页面 JS → 原生上报桥；只接受 http(s)，权威上报排除静态资源后缀 */
    private class SniffBridge {
        private final String jobId;

        SniffBridge(String jobId) {
            this.jobId = jobId;
        }

        @android.webkit.JavascriptInterface
        public void media(String url) {
            main.post(() -> consider(jobId, url, true));
        }

        @android.webkit.JavascriptInterface
        public void request(String url) {
            main.post(() -> consider(jobId, url, false));
        }
    }

    private void consider(String jobId, String url, boolean authoritative) {
        if (url == null || url.isEmpty()) return;
        SniffJob job = jobs.get(jobId);
        if (job == null || job.settled.get()) return;
        if (url.equals(job.pageUrl)) return;
        if (authoritative) {
            if (ASSET_URL.matcher(url).find()) return;
            finish(jobId, url);
        } else if (MEDIA_URL.matcher(url).find()) {
            finish(jobId, url);
        }
    }

    private final Map<String, SniffJob> jobs = new ConcurrentHashMap<>();
    private int jobSeq = 0;
    // OPT-18: 并发嗅探上限 2 个 WebView（每个数十 MB，防 OOM）
    private static final int MAX_CONCURRENT_SNIFF = 2;
    private final Semaphore sniffSemaphore = new Semaphore(MAX_CONCURRENT_SNIFF);

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

        // OPT-18: 并发上限，超限则排队等待（最多等 5s）
        try {
            if (!sniffSemaphore.tryAcquire(5, TimeUnit.SECONDS)) {
                call.reject("嗅探并发已满（上限 " + MAX_CONCURRENT_SNIFF + "），请稍后重试");
                return;
            }
        } catch (InterruptedException e) {
            call.reject("嗅探等待被中断");
            return;
        }

        final String jobId = "sniff-" + (++jobSeq);
        main.post(() -> {
            try {
                startSniff(call, jobId, url, headers, timeoutMs);
            } catch (Exception e) {
                jobs.remove(jobId);
                sniffSemaphore.release(); // OPT-18: 启动失败释放信号量
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
        SniffJob job = new SniffJob(call, webView, url, timeoutTask);
        jobs.put(jobId, job);
        webView.addJavascriptInterface(new SniffBridge(jobId), "PeanutSniffer");

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
                view.evaluateJavascript(INJECT_JS, null);
            }

            @Override
            public void onPageFinished(WebView view, String target) {
                // 主文档就绪后再注入一次（幂等），覆盖 onPageStarted 时 document 未就绪的情形
                view.evaluateJavascript(INJECT_JS, null);
            }
        });

        // 页面 JS 弹窗：登记后吞掉（P1-2）。这块 WebView 从不挂进视图树，但它的 context 是
        // Activity，页面里的 `alert('本接口免费使用…')` 默认实现照样会在当前窗口上弹真对话框——
        // 文字来自解析页，既不在我们的代码里、也不在任何日志里，看上去就是「凭空冒出来的一句」，
        // 而且点掉之前页面 JS 一直阻塞着。记下来源再取消，用户不再看到无法处置的弹窗。
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String pageUrl, String message, JsResult result) {
                notePageDialog(jobId, "alert", pageUrl, message, result);
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String pageUrl, String message, JsResult result) {
                notePageDialog(jobId, "confirm", pageUrl, message, result);
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String pageUrl, String message,
                                      String defaultValue, JsPromptResult result) {
                // 用 cancel 而不是 confirm(value)：不把页面要的值喂回去，嗅探只读不提交
                notePageDialog(jobId, "prompt", pageUrl, message, result);
                return true;
            }
        });

        if (headers != null && !headers.isEmpty()) {
            webView.loadUrl(url, headers);
        } else {
            webView.loadUrl(url);
        }
        main.postDelayed(timeoutTask, timeoutMs);
    }

    /**
     * 登记并吞掉解析页的 JS 弹窗（P1-2「提示来源」里 WebView 页面这一档）。
     *
     * 字段与 JS 侧 {@code recordUpstreamNotice} 对齐（requestId / noticeOrigin / operation / text），
     * 导出日志里两处能一起 grep；{@code jobId} 用来把它和同一次嗅探调用串起来。
     * 页面 URL 与文案先过 {@link LogRedactor}：解析页常把带签名的直链写进 alert 正文里。
     * {@code result.cancel()} 让页面 JS 立刻解除阻塞——弹窗不会再出现，也不回传任何值。
     */
    private void notePageDialog(String jobId, String kind, String pageUrl,
                                String message, JsResult result) {
        try {
            result.cancel();
        } catch (Exception ignored) {
            // result 已被处理过（页面重入）会抛；登记不能因此失败
        }
        String text = message == null ? "" : message.trim().replace('\n', ' ');
        if (text.length() > 300) text = text.substring(0, 300);
        String requestId = "n-" + Long.toString(System.currentTimeMillis(), 36) + "-"
                + Integer.toHexString((jobId + "|" + kind + "|" + text).hashCode() & 0x7fffffff);
        AppLog.i(TAG, "上游提示登记 requestId=" + requestId
                + " noticeOrigin=webview_page originLabel=WebView页面 kind=" + kind
                + " operation=sniff jobId=" + jobId
                + " pageUrl=" + LogRedactor.redact(pageUrl == null ? "" : pageUrl)
                + " text=" + LogRedactor.redact(text));
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
            // OPT-18: 释放信号量，允许下一个嗅探任务启动
            sniffSemaphore.release();
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
