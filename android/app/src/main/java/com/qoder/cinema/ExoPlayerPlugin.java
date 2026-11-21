package com.qoder.cinema;

import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.Rational;
import android.view.PixelCopy;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.common.Format;
import androidx.media3.common.Tracks;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import okhttp3.OkHttpClient;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ExoPlayer —— 原生播放引擎 PoC（v1.7 / CHG-21，Spike）
 *
 * 目的：WebView+hls.js 软解在低端盒子上跑不动 4K，用 Media3 硬解验证是否值得转正。
 * 退出标准：MuMu 模拟器 4K HLS 不掉帧、进度/倍速最小集可用（契约变更 v1.7 §2.4）。
 *
 * 集成方式（surface 模式）：插件在 WebView 之上叠一个 `PlayerView` 容器，
 * JS 用 `setRect` 把它对齐到 `<video>` 占位元素的位置（PlayerView 播放时传 rect）。
 * JS 侧开关 `experimentalNativePlayer` 默认关，未启用时本插件零调用。
 *
 * PoC 边界：只覆盖 HLS/MP4 直链播放 + 头注入 + 进度/倍速；字幕、清晰度面板、
 * 手势快进复用 JS 侧事件桥。不达标则整段（本文件 + build.gradle 三行依赖 +
 * src/native/exoPlayerPlugin.ts）移除，不影响主链路。
 */
@CapacitorPlugin(name = "ExoPlayer")
public class ExoPlayerPlugin extends Plugin {

    // P0-5: OkHttpClient 单例——连接池/线程池跨播放复用，避免每次 prepare 重建
    private static final OkHttpClient SHARED_HTTP_CLIENT = new OkHttpClient.Builder()
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build();

    private ExoPlayer player;
    private PlayerView playerView;
    private FrameLayout overlay;
    /** v1.8/CHG-25：本次会话累计丢帧（AnalyticsListener 累加，progress() 上报 AC-125 采样） */
    private long droppedFrames = 0;
    /**
     * P1-b：最近一次 seek 的发起时刻（elapsedRealtime）与目标位置。
     *
     * 只有 seek 置位、首帧渲染后清零，所以初起播的第一帧不会被误记成 seek 耗时。
     * 这个耗时就是用户看到的"时间跳了、画面还没动"的长度。
     */
    private long seekRequestedAtMs = 0L;
    private long seekTargetMs = -1L;
    /** v1.8 优化：视频轨列表（清晰度切换） */
    private java.util.List<JSObject> videoTracks = new java.util.ArrayList<>();
    /** v1.8 优化：字幕轨列表 */
    private java.util.List<JSObject> textTracks = new java.util.ArrayList<>();
    /** EXT-07：音轨列表（语言/名称/声道数） */
    private java.util.List<JSObject> audioTracks = new java.util.ArrayList<>();
    /**
     * EXT-07：轨道选择引用。
     *
     * 上报给 JS 的 `id` 是本列表下标（顺序索引与列表一致）；
     * `TrackSelectionOverride` 需要原始 `TrackGroup` + 组内下标，所以两份都留。
     */
    private java.util.List<TrackRef> textTrackRefs = new java.util.ArrayList<>();
    private java.util.List<TrackRef> audioTrackRefs = new java.util.ArrayList<>();
    /** 当前选中的字幕/音轨 id；-1 = 字幕关闭 / 音轨未知 */
    private int activeTextId = -1;
    private int activeAudioId = -1;

    /** 轨道引用（TrackGroup + 组内下标） */
    private static final class TrackRef {
        final TrackGroup group;
        final int index;

        TrackRef(TrackGroup group, int index) {
            this.group = group;
            this.index = index;
        }
    }
    /** v1.8 优化：播放质量指标 */
    private long bufferEvents = 0;
    private long bufferDurationMs = 0;
    private int currentBitrate = 0;
    private String decoderName = "";

    /**
     * 心跳看门狗：JS 每 500ms 轮询 progress() 即心跳；页面被系统重建（渲染进程
     * 回收，真机实证 2026-11-03）或桥接丢失后心跳停止，超时自动暂停，防止
     * 「离开播放页后声音不停」。正常播放时轮询密集，看门狗永不触发。
     */
    private static final long PROGRESS_WATCHDOG_MS = 6_000;
    private long lastHeartbeatAt = 0;
    /**
     * P0-3：`play()` 早于 `prepare()` 到达时记下的起播意图。
     *
     * 本地大文件的 prepare 与 JS 的 play 之间没有先后保证，旧实现里 player 还是 null
     * 就直接 resolve，起播指令被静默丢弃（真机表现：点了播放却什么都不动）。
     */
    private boolean pendingPlay = false;
    private Runnable watchdogRunnable;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /* ---------- B1/B2：MediaSession / 后台播放 ---------- */

    /** 上一集/下一集自定义命令（系统媒体控件与通知都走这里，JS 负责真正的切集） */
    private static final String CMD_PREVIOUS = "com.qoder.cinema.PREVIOUS_EPISODE";
    private static final String CMD_NEXT = "com.qoder.cinema.NEXT_EPISODE";

    /**
     * 媒体会话：锁屏/通知栏/蓝牙 AVRCP 的元数据与按键入口。
     *
     * 会话不拥有播放器（`MediaSession.release()` 不会 release player），
     * 生命周期与 player 严格一致，见 {@link #releasePlayerQuietly()}。
     */
    private MediaSession mediaSession;
    /**
     * B2：后台继续播放。为真时看门狗不再因 JS 心跳丢失而自动暂停——
     * WebView 切后台后定时器被系统节流，心跳本来就会断。
     */
    private boolean backgroundPlayback = false;
    /** B2：纯音频模式——收起原生 surface，只留声音（画面交还给 WebView 里的海报/UI） */
    private boolean audioOnly = false;
    /** 已上报给 JS 的播放意图，避免重复事件把 UI 状态刷来刷去 */
    private boolean reportedPlaying = false;

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", true);
        call.resolve(result);
    }

    /** 准备播放：创建/复用 overlay + ExoPlayer 实例并加载（不自动播） */
    @OptIn(markerClass = UnstableApi.class)
    @PluginMethod
    public void prepare(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        // REV-24 P2：安全模式下拒绝 ExoPlayer 初始化（高频崩溃路径）
        if (MainApplication.isSafeMode(getContext())) {
            call.reject("safe mode active: native player disabled");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            // REV-24：哨兵包裹 ExoPlayer 初始化——native crash 时下次启动可检测到
            String sourceId = call.getString("sourceId", "");
            String host = "";
            try {
                java.net.URI uri = new java.net.URI(url);
                host = uri.getHost() != null ? uri.getHost() : "";
            } catch (Exception ignored) {}
            String token = null;
            try {
                org.json.JSONObject sentinelDetails = new org.json.JSONObject();
                sentinelDetails.put("sourceId", sourceId);
                sentinelDetails.put("host", host);
                sentinelDetails.put("url", url);
                token = CrashSentinel.begin("exoplayer", sentinelDetails);
            } catch (Exception e) {
                Log.w("ExoPlayerPlugin", "failed to write exoplayer sentinel", e);
            }
            try {
                ensureOverlay();
                // v1.8/CHG-25：切集会再次 prepare——先释放旧实例，避免播放器泄漏
                releasePlayerQuietly();
                droppedFrames = 0;

                Map<String, String> headers = new HashMap<>();
                JSArray headerList = call.getArray("headers");
                if (headerList != null) {
                    for (int i = 0; i < headerList.length(); i++) {
                        JSObject entry = JSObject.fromJSONObject(headerList.getJSONObject(i));
                        headers.put(entry.getString("key", ""), entry.getString("value", ""));
                    }
                }

                // P0-5: 复用单例 OkHttpClient（连接池/线程池不随播放重建）
                OkHttpDataSource.Factory httpFactory = new OkHttpDataSource.Factory(SHARED_HTTP_CLIENT);
                if (!headers.isEmpty()) {
                    httpFactory.setDefaultRequestProperties(headers);
                }

                // DefaultDataSource.Factory 同时支持 http/https（走 OkHttp）和 file://（本地文件），
                // 直接用 OkHttpDataSource.Factory 会导致本地文件无法打开（DEMUXER_ERROR_COULD_NOT_OPEN）
                androidx.media3.datasource.DefaultDataSource.Factory dataSourceFactory =
                        new androidx.media3.datasource.DefaultDataSource.Factory(getContext(), httpFactory);

                // 内容类型必须显式标注：DefaultMediaSourceFactory 只按 URI 路径推断，
                // 中转地址（.m3u8 在 query）与本地代理 hash 地址都会被误判成 progressive，
                // 把 m3u8 当渐进流嗅探 → UnrecognizedInputFormatException（真机实证）。
                String mime = call.getString("mime");
                boolean isHls = androidx.media3.common.MimeTypes.APPLICATION_M3U8.equalsIgnoreCase(mime)
                        || url.contains(".m3u8");
                // B1：锁屏/通知栏/蓝牙的元数据必须随 MediaItem 下发——media3 1.3.1 的
                // MediaSession 没有 setMediaMetadata，会话元数据只取自播放器当前 MediaItem。
                MediaMetadata.Builder metadata = new MediaMetadata.Builder();
                String title = call.getString("title", "");
                if (!title.isEmpty()) metadata.setTitle(title);
                String subtitle = call.getString("subtitle", "");
                if (!subtitle.isEmpty()) metadata.setArtist(subtitle);
                String artworkUrl = call.getString("artworkUrl");
                if (artworkUrl != null && !artworkUrl.isEmpty()) {
                    try {
                        metadata.setArtworkUri(Uri.parse(artworkUrl));
                    } catch (Exception e) {
                        Log.w("ExoPlayerPlugin", "bad artwork uri: " + e.getMessage());
                    }
                }
                MediaItem.Builder itemBuilder = new MediaItem.Builder()
                        .setUri(url)
                        .setMediaMetadata(metadata.build());
                if (isHls) {
                    itemBuilder.setMimeType(androidx.media3.common.MimeTypes.APPLICATION_M3U8);
                }
                MediaItem mediaItem = itemBuilder.build();

                // P0-7: 续播位置随 prepare 下发（毫秒），0 或负数视为从头播放。
                // 必须走 getData().optLong：JS 数字在 org.json 里是 Integer，
                // `call.getLong(key, 0L)` 会当成类型不符返回默认值 0（真机实证 2026-11-17：
                // 桥 methodData 带 15000，handler 读到 0，续播位置整体失效）。
                long startPositionMs = call.getData().optLong("startPositionMs", 0L);

                // P0-6: DefaultLoadControl 首帧优先——缩短起播等待
                LoadControl loadControl = new DefaultLoadControl.Builder()
                        .setBufferDurationsMs(
                                8_000,   // minBuffer: 降低最小缓冲，起播更快
                                30_000,  // maxBuffer: 稳定后缓冲
                                1_000,   // bufferForPlayback: 1s 即播（原 2.5s）
                                3_000    // bufferForPlaybackAfterRebuffer: 卡顿后 3s 即追
                        )
                        .build();

                // P0-4: 短退避重试策略（2 次，500ms/1500ms）
                LoadErrorHandlingPolicy errorPolicy = new DefaultLoadErrorHandlingPolicy(2);

                DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(dataSourceFactory);
                mediaSourceFactory.setLoadErrorHandlingPolicy(errorPolicy);

                player = new ExoPlayer.Builder(getContext())
                        .setMediaSourceFactory(mediaSourceFactory)
                        .setLoadControl(loadControl)
                        .build();
                player.setMediaItem(mediaItem, startPositionMs);
                // B1：声明媒体音频属性并交给 ExoPlayer 托管焦点。
                // handleAudioFocus=true 时播放器自动 request/abandon：来电或别的 App
                // 抢焦点 → playWhenReady 置 false（下面的监听会同步给 JS），恢复后自动续播。
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                        .build(), /* handleAudioFocus= */ true);
                player.addListener(new Player.Listener() {
                    @Override
                    public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                        // 通知栏/线控/音频焦点都可能改播放意图，JS 必须跟着同步，
                        // 否则会出现「画面在播、按钮显示暂停」的双状态源
                        reportPlaying(playWhenReady);
                        PlaybackService.refresh();
                    }

                    @Override
                    public void onIsPlayingChanged(boolean isPlaying) {
                        // 缓冲结束真正出声时刷新通知图标（意图未变，isPlaying 变了）
                        PlaybackService.refresh();
                    }

                    @Override
                    public void onPlaybackStateChanged(int playbackState) {
                        JSObject data = new JSObject();
                        if (playbackState == Player.STATE_READY) {
                            data.put("state", "ready");
                            data.put("duration", player.getDuration());
                            notifyListeners("exostate", data);
                            // P1-b：定位后重新 READY 也算"画面落地"。某些 seek 不触发渲染器重启，
                            // onRenderedFirstFrame 不会再来一次，这里兜底，两者谁先到算谁。
                            reportSeekSettled("ready");
                        } else if (playbackState == Player.STATE_BUFFERING) {
                            // v1.8/CHG-25：等待态（JS 侧 HUD loading）
                            data.put("state", "buffering");
                            notifyListeners("exostate", data);
                        } else if (playbackState == Player.STATE_ENDED) {
                            // v1.8/CHG-25：播完事件（JS 侧自动连播依赖）
                            data.put("state", "ended");
                            notifyListeners("exostate", data);
                        }
                    }

                    @Override
                    public void onPlayerError(PlaybackException error) {
                        JSObject data = new JSObject();
                        data.put("state", "error");
                        data.put("message", error.getMessage());
                        // FIX-PLAY-C1：JS 侧此前只拿到一句 ExoPlayer 文案，靠正则猜
                        // 「网络 vs 解码」——离线文件损坏常被误归成通用 E_DECODE，用户也
                        // 没有可反馈的定位信息。这里补齐错误码名、cause 链与出错位置。
                        data.put("errorCodeName", error.getErrorCodeName());
                        data.put("positionMs", player.getCurrentPosition());
                        StringBuilder causeChain = new StringBuilder();
                        Throwable cause = error.getCause();
                        for (int i = 0; i < 3 && cause != null; i++, cause = cause.getCause()) {
                            if (causeChain.length() > 0) causeChain.append(" ← ");
                            String causeMsg = cause.getMessage();
                            causeChain.append(cause.getClass().getSimpleName())
                                    .append(": ")
                                    .append(causeMsg == null ? "" : causeMsg.replaceAll("\\s+", " "));
                            if (causeChain.length() > 600) break;
                        }
                        data.put("causeChain", causeChain.toString());
                        notifyListeners("exostate", data);
                    }

                    @Override
                    public void onTracksChanged(Tracks tracks) {
                        // v1.8 优化：提取视频轨列表（清晰度切换）
                        videoTracks.clear();
                        textTracks.clear();
                        audioTracks.clear();
                        textTrackRefs.clear();
                        audioTrackRefs.clear();
                        activeTextId = -1;
                        activeAudioId = -1;
                        for (int groupIndex = 0; groupIndex < tracks.getGroups().size(); groupIndex++) {
                            Tracks.Group group = tracks.getGroups().get(groupIndex);
                            int trackType = group.getMediaTrackGroup().type;
                            if (trackType == C.TRACK_TYPE_VIDEO) {
                                for (int i = 0; i < group.length; i++) {
                                    if (group.isTrackSupported(i)) {
                                        Format f = group.getTrackFormat(i);
                                        if (f.height > 0 && f.bitrate > 0) {
                                            JSObject track = new JSObject();
                                            track.put("id", videoTracks.size());
                                            track.put("label", f.height + "p");
                                            track.put("width", f.width);
                                            track.put("height", f.height);
                                            track.put("bitrate", f.bitrate);
                                            videoTracks.add(track);
                                        }
                                    }
                                }
                            } else if (trackType == C.TRACK_TYPE_TEXT) {
                                // EXT-07：字幕轨（语言/名称），id = 顺序下标，切换时原样回传
                                for (int i = 0; i < group.length; i++) {
                                    if (!group.isTrackSupported(i)) continue;
                                    Format f = group.getTrackFormat(i);
                                    boolean selected = group.isTrackSelected(i);
                                    JSObject track = new JSObject();
                                    track.put("id", textTracks.size());
                                    track.put("label", trackLabel(f, textTracks.size(), true));
                                    track.put("language", (Object) f.language);
                                    track.put("mimeType", (Object) f.sampleMimeType);
                                    track.put("selected", selected);
                                    textTracks.add(track);
                                    textTrackRefs.add(new TrackRef(group.getMediaTrackGroup(), i));
                                    if (selected) activeTextId = textTracks.size() - 1;
                                }
                            } else if (trackType == C.TRACK_TYPE_AUDIO) {
                                // EXT-07：音轨（语言/名称/声道数）
                                for (int i = 0; i < group.length; i++) {
                                    if (!group.isTrackSupported(i)) continue;
                                    Format f = group.getTrackFormat(i);
                                    boolean selected = group.isTrackSelected(i);
                                    JSObject track = new JSObject();
                                    track.put("id", audioTracks.size());
                                    track.put("label", trackLabel(f, audioTracks.size(), false));
                                    track.put("language", (Object) f.language);
                                    track.put("mimeType", (Object) f.sampleMimeType);
                                    track.put("channels", f.channelCount);
                                    track.put("selected", selected);
                                    audioTracks.add(track);
                                    audioTrackRefs.add(new TrackRef(group.getMediaTrackGroup(), i));
                                    if (selected) activeAudioId = audioTracks.size() - 1;
                                }
                            }
                        }
                        // 同名轨道加序号：菜单里不允许出现两条一模一样的「中文」
                        dedupeLabels(textTracks);
                        dedupeLabels(audioTracks);
                        // 通知 JS 侧清晰度列表更新
                        JSObject data = new JSObject();
                        data.put("state", "qualities");
                        data.put("qualities", new JSArray(videoTracks));
                        notifyListeners("exostate", data);
                        // 通知 JS 侧字幕列表更新（兼容既有载荷）
                        JSObject subData = new JSObject();
                        subData.put("state", "textTracks");
                        subData.put("textTracks", new JSArray(textTracks));
                        notifyListeners("exostate", subData);
                        // EXT-07：字幕 + 音轨 + 双方选中项一次下发
                        JSObject tracksData = new JSObject();
                        tracksData.put("state", "embeddedTracks");
                        tracksData.put("textTracks", new JSArray(textTracks));
                        tracksData.put("audioTracks", new JSArray(audioTracks));
                        tracksData.put("activeTextId", activeTextId);
                        tracksData.put("activeAudioId", activeAudioId);
                        notifyListeners("exostate", tracksData);
                    }
                });
                // v1.8/CHG-25：丢帧计数（AC-125 转正门槛的量化指标）
                player.addAnalyticsListener(new AnalyticsListener() {
                    @Override
                    public void onDroppedVideoFrames(AnalyticsListener.EventTime eventTime, int droppedFrames, long droppedToKeyframes) {
                        ExoPlayerPlugin.this.droppedFrames += droppedFrames;
                    }

                    @Override
                    public void onRenderedFirstFrame(AnalyticsListener.EventTime eventTime, Object renderingId,
                                                     long elapsedRealtimeEpochMs) {
                        // P1-b：seek → 画面真正落地。JS 侧靠这个事件收口"正在定位"等待态并写历史。
                        reportSeekSettled("first-frame");
                    }
                });

                playerView.setPlayer(player);
                ensureMediaSession();
                // 纯音频模式跨切集保持：ensureOverlay 会把容器置回 VISIBLE
                applyAudioOnly();
                AppLog.i("ExoPlayerPlugin", "prepare startPosition=" + startPositionMs + "ms");
                player.prepare();
                // P0-3：起播意图若在 prepare 之前到达，此刻补上
                if (pendingPlay) {
                    pendingPlay = false;
                    player.setPlayWhenReady(true);
                }
                startWatchdog();
                // v1.8 修复：WebView 背景透明，让下层 surface 透出
                getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
                CrashSentinel.end(token);
                call.resolve();
            } catch (Exception e) {
                CrashSentinel.end(token);
                call.reject("prepare failed: " + e.getMessage());
            }
        });
    }

    /** 把 overlay 对齐到 JS 侧占位元素的 rect（css px × density） */
    @PluginMethod
    public void setRect(PluginCall call) {
        Float x = call.getFloat("x");
        Float y = call.getFloat("y");
        Float width = call.getFloat("width");
        Float height = call.getFloat("height");
        if (overlay == null || x == null || y == null || width == null || height == null) {
            call.resolve();
            return;
        }
        float density = getContext().getResources().getDisplayMetrics().density;
        getBridge().executeOnMainThread(() -> {
            overlay.setX(x * density);
            overlay.setY(y * density);
            overlay.getLayoutParams().width = Math.round(width * density);
            overlay.getLayoutParams().height = Math.round(height * density);
            overlay.requestLayout();
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            // P0-3：player 还没建起来时不能把起播指令丢掉，prepare 里会补执行
            if (player == null) {
                pendingPlay = true;
            } else {
                player.play();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            // 用户主动暂停优先于任何待生效的起播意图
            pendingPlay = false;
            if (player != null) player.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double positionMs = call.getDouble("positionMs");
        getBridge().executeOnMainThread(() -> {
            if (player != null && positionMs != null) {
                // P1-b：登记请求时刻，首帧渲染时换算真实定位耗时（见 onRenderedFirstFrame）
                seekRequestedAtMs = SystemClock.elapsedRealtime();
                seekTargetMs = positionMs.longValue();
                AppLog.i("ExoPlayerPlugin", "seek request target=" + seekTargetMs + "ms");
                player.seekTo(positionMs.longValue());
            }
            call.resolve();
        });
    }

    /**
     * P1-b：结算一次 seek —— 打印"请求 → 画面落地"的耗时并通知 JS。
     *
     * 只有 seek 置位、这里清零，所以初起播不会误报。耗时就是用户看到的
     * "进度条跳了、画面卡住"的长度：MP4 一般几十到几百毫秒，裸 TS 要秒级。
     *
     * @param via 结算来源（first-frame = 渲染出帧，ready = 播放器重新进入 READY）
     */
    private void reportSeekSettled(String via) {
        if (seekRequestedAtMs <= 0) return;
        long latencyMs = SystemClock.elapsedRealtime() - seekRequestedAtMs;
        long targetMs = seekTargetMs;
        seekRequestedAtMs = 0L;
        AppLog.i("ExoPlayerPlugin", "seek settled via=" + via + " in " + latencyMs + "ms (target=" + targetMs + "ms)");
        JSObject data = new JSObject();
        data.put("state", "seeksettled");
        data.put("targetMs", targetMs);
        data.put("latencyMs", latencyMs);
        notifyListeners("exostate", data);
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        Double rate = call.getDouble("rate");
        getBridge().executeOnMainThread(() -> {
            if (player != null && rate != null) {
                player.setPlaybackParameters(new androidx.media3.common.PlaybackParameters(rate.floatValue()));
            }
            call.resolve();
        });
    }

    /** v1.8/CHG-25：音量 0~100（映射 ExoPlayer 0~1） */
    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        getBridge().executeOnMainThread(() -> {
            if (player != null && volume != null) {
                float v = (float) Math.min(100, Math.max(0, volume)) / 100f;
                player.setVolume(v);
            }
            call.resolve();
        });
    }

    /** v1.8 优化：获取视频轨列表（清晰度） */
    @PluginMethod
    public void getQualities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("qualities", new JSArray(videoTracks));
        call.resolve(result);
    }

    /** v1.8 优化：切换视频轨（清晰度） */
    @PluginMethod
    public void setQuality(PluginCall call) {
        Integer id = call.getInt("id");
        getBridge().executeOnMainThread(() -> {
            if (player != null && id != null && id >= 0 && id < videoTracks.size()) {
                JSObject track = videoTracks.get(id);
                int height = track.getInteger("height", 0);
                int bitrate = track.getInteger("bitrate", 0);
                // 设置轨道选择参数：限制最大分辨率和码率
                androidx.media3.common.TrackSelectionParameters params = player.getTrackSelectionParameters()
                        .buildUpon()
                        .setMaxVideoSize(Integer.MAX_VALUE, height)
                        .setMaxVideoBitrate(bitrate)
                        .build();
                player.setTrackSelectionParameters(params);
            }
            call.resolve();
        });
    }

    /** P1 画面比例：contain/cover/fill → Media3 resize_mode */
    @PluginMethod
    public void setResizeMode(PluginCall call) {
        String mode = call.getString("mode", "contain");
        getBridge().executeOnMainThread(() -> {
            if (playerView != null) {
                int resizeMode;
                switch (mode) {
                    case "cover":
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
                        break;
                    case "fill":
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FILL;
                        break;
                    case "contain":
                    default:
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT;
                        break;
                }
                playerView.setResizeMode(resizeMode);
            }
            call.resolve();
        });
    }

    /** v1.8 优化：获取字幕轨列表（EXT-07 追加当前选中项） */
    @PluginMethod
    public void getTextTracks(PluginCall call) {
        JSObject result = new JSObject();
        result.put("textTracks", new JSArray(textTracks));
        result.put("activeTextId", activeTextId);
        call.resolve(result);
    }

    /**
     * EXT-07：切换内嵌字幕轨（-1 = 关闭字幕）。
     *
     * 旧实现用 `setPreferredTextLanguage(label)`：label 是中/英文显示名而非语言码，
     * 且无「关闭」路径。这里改为基于 `TrackGroup` 的精确覆盖选择：
     * - 选中：`setOverrideForType(new TrackSelectionOverride(group, index))` + 重新启用 TEXT 类型
     * - 关闭：`setTrackTypeDisabled(TEXT, true)` + 清空 TEXT 覆盖
     */
    @PluginMethod
    public void setTextTrack(PluginCall call) {
        Integer id = call.getInt("id");
        getBridge().executeOnMainThread(() -> {
            if (player == null || id == null) {
                call.resolve();
                return;
            }
            try {
                TrackSelectionParameters.Builder builder = player.getTrackSelectionParameters().buildUpon();
                builder.clearOverridesOfType(C.TRACK_TYPE_TEXT);
                if (id < 0) {
                    builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
                } else if (id < textTrackRefs.size()) {
                    TrackRef ref = textTrackRefs.get(id);
                    builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
                    builder.setOverrideForType(new TrackSelectionOverride(ref.group, ref.index));
                }
                player.setTrackSelectionParameters(builder.build());
            } catch (Exception e) {
                // 字幕切换失败不影响播放（与旧实现同口径）
                Log.w("ExoPlayerPlugin", "setTextTrack failed: " + e.getMessage());
            }
            call.resolve();
        });
    }

    /** EXT-07：获取音轨列表 + 当前选中项 */
    @PluginMethod
    public void getAudioTracks(PluginCall call) {
        JSObject result = new JSObject();
        result.put("audioTracks", new JSArray(audioTracks));
        result.put("activeAudioId", activeAudioId);
        call.resolve(result);
    }

    /** EXT-07：切换内嵌音轨（基于 TrackGroup 精确覆盖） */
    @PluginMethod
    public void setAudioTrack(PluginCall call) {
        Integer id = call.getInt("id");
        getBridge().executeOnMainThread(() -> {
            if (player == null || id == null) {
                call.resolve();
                return;
            }
            if (id < 0 || id >= audioTrackRefs.size()) {
                call.reject("invalid audio track id: " + id);
                return;
            }
            try {
                TrackRef ref = audioTrackRefs.get(id);
                TrackSelectionParameters.Builder builder = player.getTrackSelectionParameters().buildUpon();
                builder.setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false);
                builder.clearOverridesOfType(C.TRACK_TYPE_AUDIO);
                builder.setOverrideForType(new TrackSelectionOverride(ref.group, ref.index));
                player.setTrackSelectionParameters(builder.build());
                call.resolve();
            } catch (Exception e) {
                call.reject("switch audio track failed: " + e.getMessage());
            }
        });
    }

    /**
     * v1.8 优化：获取播放质量指标。
     *
     * AND-20：ExoPlayer 只能在创建它的主线程访问，从 CapacitorPlugins 线程直接
     * 读 getCurrentPosition()/getDuration()/getPlaybackParameters() 与已知闪退
     * 同因（见 progress() 的真机实证）。这里统一投递到主线程读取，保证统计值
     * 是同一时刻的一致快照，也避免跨线程访问播放器。
     */
    @PluginMethod
    public void getPlaybackStats(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            JSObject result = new JSObject();
            result.put("bufferEvents", bufferEvents);
            result.put("bufferDurationMs", bufferDurationMs);
            result.put("currentBitrate", currentBitrate);
            result.put("decoderName", decoderName);
            result.put("droppedFrames", droppedFrames);
            if (player != null) {
                result.put("currentPosition", player.getCurrentPosition());
                result.put("duration", player.getDuration());
                result.put("playbackSpeed", player.getPlaybackParameters().speed);
            }
            call.resolve(result);
        });
    }

    /** EXT-07：画中画能力探测（Android 8.0+ 且系统声明 FEATURE_PICTURE_IN_PICTURE） */
    @PluginMethod
    public void isPipSupported(PluginCall call) {
        boolean supported = false;
        try {
            supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
                    && getActivity() != null;
        } catch (Exception e) {
            supported = false;
        }
        JSObject result = new JSObject();
        result.put("supported", supported);
        call.resolve(result);
    }

    /** EXT-07：当前 Activity 是否处于画中画（JS 侧轮询该值同步按钮态/退出恢复） */
    @PluginMethod
    public void isPipActive(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            boolean active = false;
            try {
                active = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && getActivity() != null
                        && getActivity().isInPictureInPictureMode();
            } catch (Exception e) {
                active = false;
            }
            JSObject result = new JSObject();
            result.put("active", active);
            call.resolve(result);
        });
    }

    /** v1.8 优化 / EXT-07：进入画中画模式（宽高比按视频尺寸推导并限幅 16:9 / 4:3） */
    @PluginMethod
    public void enterPip(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().executeOnMainThread(() -> {
                try {
                    PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
                    int[] size = currentVideoSize();
                    if (size != null) builder.setAspectRatio(pipAspectRatio(size[0], size[1]));
                    getActivity().enterPictureInPictureMode(builder.build());
                    call.resolve();
                } catch (Exception e) {
                    call.reject("进入画中画失败: " + e.getMessage());
                }
            });
        } else {
            call.reject("设备不支持画中画");
        }
    }

    /** v1.8 优化：退出画中画模式 */
    @PluginMethod
    public void exitPip(PluginCall call) {
        // Android 没有直接的 exitPip API，用户按返回键或切换到其他 App 会自动退出
        call.resolve();
    }

    @PluginMethod
    public void progress(PluginCall call) {
        // ExoPlayer 只能在创建它的主线程访问：在 CapacitorPlugins 线程直接读
        // getCurrentPosition() 会抛 IllegalStateException 并终止进程（真机实证）。
        getBridge().executeOnMainThread(() -> {
            lastHeartbeatAt = SystemClock.elapsedRealtime();
            JSObject result = new JSObject();
            if (player != null) {
                result.put("positionMs", player.getCurrentPosition());
                result.put("durationMs", player.getDuration());
            } else {
                result.put("positionMs", 0);
                result.put("durationMs", 0);
            }
            result.put("droppedFrames", droppedFrames);
            call.resolve(result);
        });
    }

    /* ---------- B1/B2：媒体会话 / 后台播放 / 纯音频 ---------- */

    /** B2：后台继续播放开关（关时看门狗仍会在 JS 心跳丢失后自动暂停） */
    @PluginMethod
    public void setBackgroundPlayback(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        getBridge().executeOnMainThread(() -> {
            backgroundPlayback = enabled != null && enabled;
            AppLog.i("ExoPlayerPlugin", "backgroundPlayback=" + backgroundPlayback);
            call.resolve();
        });
    }

    /**
     * B2：纯音频模式——禁用视频轨并收起原生 surface。
     *
     * 禁轨不只是藏画面：HLS 会因此不再拉视频分片，省电省流量。
     * 画面位置交还给 WebView（JS 侧显示海报），故 overlay 直接 GONE。
     */
    @PluginMethod
    public void setAudioOnly(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        getBridge().executeOnMainThread(() -> {
            audioOnly = enabled != null && enabled;
            applyAudioOnly();
            call.resolve();
        });
    }

    private void applyAudioOnly() {
        if (overlay != null) {
            overlay.setVisibility(audioOnly ? View.GONE : View.VISIBLE);
            // P1-4：GONE 只是隐藏 SurfaceControl，surface 往往还 valid，holder 回调不会来。
            // 取样目标在这一刻已经变了，必须显式换代并回执，否则 JS 会对着藏起来的画面继续轮询。
            bumpSurfaceGeneration();
        }
        if (player == null) return;
        try {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters()
                    .buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, audioOnly)
                    .build());
        } catch (Exception e) {
            Log.w("ExoPlayerPlugin", "applyAudioOnly failed: " + e.getMessage());
        }
    }

    /** 通知栏/线控的「上一集/下一集」交给 JS：剧集列表与换线逻辑都在 JS 侧 */
    private void emitRemote(String command) {
        JSObject data = new JSObject();
        data.put("state", "remote");
        data.put("command", command);
        notifyListeners("exostate", data);
    }

    /** 播放意图变化上报（去重），并在起播时拉起前台服务 */
    private void reportPlaying(boolean playing) {
        if (reportedPlaying == playing) return;
        reportedPlaying = playing;
        JSObject data = new JSObject();
        data.put("state", playing ? "playing" : "paused");
        notifyListeners("exostate", data);
        if (playing && mediaSession != null) {
            PlaybackService.start(getContext(), mediaSession, commandSink);
        }
    }

    private final PlaybackService.CommandSink commandSink = new PlaybackService.CommandSink() {
        @Override
        public void onPlayPause() {
            if (player == null) return;
            if (player.isPlaying()) {
                player.pause();
            } else {
                player.play();
            }
        }

        @Override
        public void onPrevious() {
            emitRemote("previous");
        }

        @Override
        public void onNext() {
            emitRemote("next");
        }

        @Override
        public void onStop() {
            if (player != null) player.pause();
            emitRemote("stop");
            PlaybackService.stop(getContext());
        }
    };

    /**
     * 建会话（必须在主线程，且 player 已就绪）。
     *
     * 会话不拥有播放器：`MediaSession.release()` 只解绑监听与 compat 会话，
     * 播放器仍由本插件 release，避免两处释放同一实例。
     */
    private void ensureMediaSession() {
        releaseMediaSession();
        if (player == null) return;
        try {
            android.content.Intent open = new android.content.Intent(getContext(), MainActivity.class);
            open.setFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
            android.app.PendingIntent sessionActivity = android.app.PendingIntent.getActivity(
                    getContext(), 0, open, android.app.PendingIntent.FLAG_IMMUTABLE);
            mediaSession = new MediaSession.Builder(getContext(), player)
                    .setId("peanutmov-playback")
                    .setSessionActivity(sessionActivity)
                    .setCallback(new MediaSession.Callback() {
                        @Override
                        public ListenableFuture<SessionResult> onCustomCommand(
                                MediaSession session, MediaSession.ControllerInfo controller,
                                SessionCommand customCommand, Bundle args) {
                            String action = customCommand.customAction;
                            if (CMD_PREVIOUS.equals(action)) {
                                emitRemote("previous");
                            } else if (CMD_NEXT.equals(action)) {
                                emitRemote("next");
                            }
                            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
                        }
                    })
                    .build();
            // 单 MediaItem 时间轴下播放器不 advertise SEEK_TO_NEXT/PREVIOUS，
            // 系统媒体控件的上下集按钮只能靠自定义命令补出来
            mediaSession.setCustomLayout(Arrays.asList(
                    new CommandButton.Builder()
                            .setSessionCommand(new SessionCommand(CMD_PREVIOUS, Bundle.EMPTY))
                            .setIconResId(android.R.drawable.ic_media_previous)
                            .setDisplayName("上一集")
                            .build(),
                    new CommandButton.Builder()
                            .setSessionCommand(new SessionCommand(CMD_NEXT, Bundle.EMPTY))
                            .setIconResId(android.R.drawable.ic_media_next)
                            .setDisplayName("下一集")
                            .build()));
        } catch (Exception e) {
            // 会话失败不能连带播放失败：降级为无锁屏控制
            Log.w("ExoPlayerPlugin", "ensureMediaSession failed: " + e.getMessage());
            mediaSession = null;
        }
    }

    private void releaseMediaSession() {
        if (mediaSession == null) return;
        try {
            mediaSession.release();
        } catch (Exception ignored) {
        }
        mediaSession = null;
    }

    @PluginMethod
    public void release(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            releasePlayerQuietly();
            // 弹幕取样的整帧位图按 surface 尺寸分配（1080p 约 8MB），离开播放页必须撤掉
            recycleLumaScratch();
            if (playerView != null) playerView.setPlayer(null);
            if (overlay != null) overlay.setVisibility(View.GONE);
            // P1-4：离开播放页 = 取样目标作废，明确告诉 JS 停轮询（别等它自己数满失败次数）
            bumpSurfaceGeneration();
            // 恢复 WebView 透明：让 CSS 主题背景负责绘制，避免深色主题下闪白
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        releasePlayerQuietly();
        super.handleOnDestroy();
    }

    private void releasePlayerQuietly() {
        cancelWatchdog();
        seekRequestedAtMs = 0L;
        seekTargetMs = -1L;
        // B1：会话持有播放器监听，必须先于 player.release() 解绑；
        // 前台服务随会话一起收，否则离开播放页后通知栏常驻
        releaseMediaSession();
        PlaybackService.stop(getContext());
        reportedPlaying = false;
        // EXT-07：轨道引用指向已释放播放器的 TrackGroup，必须一起清掉
        textTracks.clear();
        audioTracks.clear();
        textTrackRefs.clear();
        audioTrackRefs.clear();
        activeTextId = -1;
        activeAudioId = -1;
        if (player != null) {
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
    }

    /* ---------- EXT-07：轨道显示名 ---------- */

    /** 语言码 → 中文显示名（未收录回落原始码大写；未知/und 返回 null） */
    private static String languageName(String language) {
        if (language == null) return null;
        String key = language.trim().toLowerCase(java.util.Locale.ROOT).replace('_', '-');
        if (key.isEmpty() || "und".equals(key)) return null;
        if (key.length() > 2 && key.charAt(2) == '-') key = key.substring(0, 2);
        switch (key) {
            case "zh": return "中文";
            case "en": return "英语";
            case "ja": return "日语";
            case "ko": return "韩语";
            case "fr": return "法语";
            case "de": return "德语";
            case "es": return "西班牙语";
            case "ru": return "俄语";
            case "it": return "意大利语";
            case "pt": return "葡萄牙语";
            case "th": return "泰语";
            case "vi": return "越南语";
            case "id": return "印尼语";
            case "ms": return "马来语";
            case "ar": return "阿拉伯语";
            case "hi": return "印地语";
            case "tr": return "土耳其语";
            default: return language.trim().toUpperCase(java.util.Locale.ROOT);
        }
    }

    /**
     * 轨道显示名：码流自带 NAME（HLS EXT-X-MEDIA NAME 等）优先，
     * 其次语言中文名，最后「字幕 N / 音轨 N」兜底（异常数据不留空标签）。
     */
    private static String trackLabel(Format format, int index, boolean text) {
        String fallback = (text ? "字幕 " : "音轨 ") + (index + 1);
        if (format.label != null && !format.label.trim().isEmpty()) return format.label.trim();
        String lang = languageName(format.language);
        return lang != null ? lang : fallback;
    }

    /** 同名轨道追加序号，避免菜单里出现两条无法区分的中文轨 */
    private static void dedupeLabels(java.util.List<JSObject> tracks) {
        java.util.Map<String, Integer> seen = new java.util.HashMap<>();
        for (JSObject track : tracks) {
            String label = track.getString("label", "");
            int count = seen.containsKey(label) ? seen.get(label) + 1 : 1;
            seen.put(label, count);
            if (count > 1) track.put("label", label + " " + count);
        }
    }

    /* ---------- EXT-07：画中画比例 ---------- */

    /** 当前选中视频轨的宽高（拿不到返回 null） */
    private int[] currentVideoSize() {
        if (player == null) return null;
        try {
            Tracks tracks = player.getCurrentTracks();
            for (Tracks.Group group : tracks.getGroups()) {
                if (group.getMediaTrackGroup().type != C.TRACK_TYPE_VIDEO) continue;
                for (int i = 0; i < group.length; i++) {
                    if (!group.isTrackSelected(i)) continue;
                    Format f = group.getTrackFormat(i);
                    if (f.width > 0 && f.height > 0) return new int[]{f.width, f.height};
                }
            }
        } catch (Exception e) {
            Log.w("ExoPlayerPlugin", "currentVideoSize failed: " + e.getMessage());
        }
        return null;
    }

    /**
     * PiP 宽高比：四舍五入到最接近的 16:9 / 4:3（系统对 PiP 比例有上下限，
     * 直接传 2.35:1 之类的宽银幕比例会被裁剪），竖屏视频取倒数。
     */
    private static Rational pipAspectRatio(int width, int height) {
        boolean portrait = height > width;
        int longSide = Math.max(width, height);
        int shortSide = Math.min(width, height);
        double aspect = shortSide > 0 ? (double) longSide / shortSide : 16.0 / 9.0;
        boolean fourThree = Math.abs(aspect - 4.0 / 3.0) < Math.abs(aspect - 16.0 / 9.0);
        int rw = fourThree ? 4 : 16;
        int rh = fourThree ? 3 : 9;
        return portrait ? new Rational(rh, rw) : new Rational(rw, rh);
    }

    private void startWatchdog() {
        cancelWatchdog();
        lastHeartbeatAt = SystemClock.elapsedRealtime();
        watchdogRunnable = new Runnable() {
            @Override
            public void run() {
                if (player == null) return;
                // B2：后台播放时 JS 定时器被系统节流，心跳丢失是预期行为，不能据此暂停
                if (!backgroundPlayback
                        && player.isPlaying()
                        && SystemClock.elapsedRealtime() - lastHeartbeatAt > PROGRESS_WATCHDOG_MS) {
                    com.qoder.cinema.AppLog.w("ExoPlayerPlugin", "progress heartbeat lost > " + PROGRESS_WATCHDOG_MS + "ms, auto pause");
                    player.pause();
                }
                mainHandler.postDelayed(this, 2_000);
            }
        };
        mainHandler.postDelayed(watchdogRunnable, 2_000);
    }

    private void cancelWatchdog() {
        if (watchdogRunnable != null) {
            mainHandler.removeCallbacks(watchdogRunnable);
            watchdogRunnable = null;
        }
    }

    /* ---------- 11-17：弹幕智能配色的画面取样 ---------- */

    /**
     * sRGB 8bit → 线性分量查表。
     *
     * 亮度口径必须与 JS 侧（WCAG 2.1 相对亮度）一致，否则同一片雪景在两个引擎下
     * 会判成不同的背景明暗。用均值再查表（先平均后线性化），与 WebView 侧
     * `drawImage` 降采样后再读像素的做法同一口径。
     */
    private static final double[] SRGB_LINEAR = new double[256];

    static {
        for (int i = 0; i < 256; i++) {
            double c = i / 255.0;
            SRGB_LINEAR[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
    }

    /** 每个网格纵向取几条扫描线求均值（一屏只取 1 行会被细横线/字幕条带偏） */
    private static final int LUMA_LINES_PER_ROW = 3;
    /** PixelCopy 兜底超时：框架不保证回调一定来，超时就当本轮没有帧 */
    private static final int LUMA_COPY_TIMEOUT_MS = 1500;

    /** PixelCopy 目标位图：与 surface 同尺寸，跨轮次复用（1080p 约 8MB，每轮新建必然抖内存） */
    private Bitmap lumaFrame;
    /** 逐行读像素的行缓冲，同样复用 */
    private int[] lumaRow;
    /**
     * 取样互斥位。JS 侧本身有 in-flight 闸门，但引擎切换时可能有两个取样方重叠；
     * 复用同一张位图时被并发写入会取到半帧，所以这里直接让后来者拿到"本轮无帧"。
     */
    private boolean lumaBusy = false;
    /** P1-4：已要求回收位图，但还有一帧在飞——等它落地再真的回收 */
    private boolean lumaRetired = false;
    /** 降采样专用线程（惰性创建，单条串行，天然避免两轮同时写同一张位图） */
    private ExecutorService lumaDownsampler;

    /**
     * P1-4：取样目标的代次。surface 建/毁、纯音频收起画面、离开播放页都算换了一代。
     *
     * JS 侧据此做两件事：代次变了就丢掉手里那张旧亮度场（别把上一代画面的配色贴到新画面上），
     * 以及 surface 无效时**停掉轮询**而不是每 333ms 白跑一次桥 + PixelCopy。
     */
    private int surfaceGeneration = 0;

    /** P1-4 取证标签：只走 logcat，不进 SpiderLogStore，免得 3Hz 取样把日志页灌满 */
    private static final String LUMA_TRACE_TAG = "ExoLuma";
    /** 上一条取证属于哪一代 surface */
    private int lumaLogGeneration = -1;
    /** 上一条取证的结论，用于"只有翻转才落一行" */
    private String lumaLogState = "";
    /** sampleFrameLuma 被调起来的累计次数（不是真的截到帧的次数） */
    private long lumaReads = 0;
    /** 上一次取样尝试的时刻，用来识别"静默了 2s 以上又重新开始" */
    private long lumaPrevAttemptAt = 0;
    /** 静默多久算断档：稳态 3Hz（333ms）和恢复探测的 1Hz 都不算，暂停/退后台/引擎释放才跨得过去 */
    private static final int LUMA_QUIET_GAP_MS = 2000;
    /** 本轮 PixelCopy 发起时刻，只用于回执耗时取证 */
    private long lumaCopyStartedAt = 0;

    /**
     * P1-4：取样结论只在**换代、结论翻转或断档后重新开始**时落一行 V 级日志。
     *
     * 稳态（同一代、同一结论、间隔没超过 2s）零输出，所以 3Hz 轮询不会淹掉 logcat；而"重新开始"
     * 这一行本身带时间戳，和上一行一减就是验收要的 resumeMs。
     */
    private void logLumaTransition(String surfaceState, long elapsedMs) {
        long now = SystemClock.elapsedRealtime();
        boolean changed = surfaceGeneration != lumaLogGeneration || !surfaceState.equals(lumaLogState);
        boolean resumed = now - lumaPrevAttemptAt > LUMA_QUIET_GAP_MS;
        lumaPrevAttemptAt = now;
        if (!changed && !resumed) return;
        lumaLogGeneration = surfaceGeneration;
        lumaLogState = surfaceState;
        Log.v(LUMA_TRACE_TAG, "lumaState generation=" + surfaceGeneration
                + " valid=" + surfaceSamplable()
                + " surfaceState=" + surfaceState
                + " reads=" + lumaReads
                + " elapsedMs=" + elapsedMs
                + (resumed && !changed ? " resumed=1" : ""));
    }

    /** 代次推进 + 当前可取样状态一起推给 JS（只在主线程调用） */
    private void bumpSurfaceGeneration() {
        surfaceGeneration += 1;
        Log.v(LUMA_TRACE_TAG, "surfaceBump generation=" + surfaceGeneration + " valid=" + surfaceSamplable());
        JSObject data = new JSObject();
        data.put("state", "surface");
        data.put("generation", surfaceGeneration);
        data.put("valid", surfaceSamplable());
        notifyListeners("exostate", data);
    }

    /**
     * 现在能不能真的截到一帧。
     *
     * `isShown()` 不可省：纯音频只是把 overlay 设成 GONE，SurfaceView 的 surface 往往仍然
     * valid（系统只隐藏 SurfaceControl 不销毁它），只看 `isValid()` 会对着藏起来的画面空转。
     */
    @OptIn(markerClass = UnstableApi.class)
    private boolean surfaceSamplable() {
        if (playerView == null) return false;
        View surface = playerView.getVideoSurfaceView();
        if (!(surface instanceof SurfaceView)) return false;
        SurfaceView view = (SurfaceView) surface;
        return view.isShown()
                && view.getWindowToken() != null
                && view.getHolder().getSurface().isValid()
                && view.getWidth() >= 4
                && view.getHeight() >= 4;
    }

    /** surface 建/毁即换代（Media3 自己也挂了回调，addCallback 是叠加不是替换） */
    @OptIn(markerClass = UnstableApi.class)
    private void watchSurface(PlayerView view) {
        View surface = view.getVideoSurfaceView();
        if (!(surface instanceof SurfaceView)) return;
        ((SurfaceView) surface).getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override
            public void surfaceCreated(SurfaceHolder holder) {
                bumpSurfaceGeneration();
            }

            @Override
            public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
                // 只是尺寸变了：取样位图按尺寸自适应，不算换代
            }

            @Override
            public void surfaceDestroyed(SurfaceHolder holder) {
                bumpSurfaceGeneration();
            }
        });
    }

    @PluginMethod
    @OptIn(markerClass = UnstableApi.class)
    public void sampleFrameLuma(PluginCall call) {
        Integer reqCols = call.getInt("cols");
        Integer reqRows = call.getInt("rows");
        int cols = reqCols == null ? 32 : reqCols;
        int rows = reqRows == null ? 18 : reqRows;
        if (cols <= 0 || rows <= 0 || cols > 128 || rows > 128) {
            call.reject("cols/rows 超出范围");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            lumaReads += 1;
            if (playerView == null) {
                // 还没起播（PlayerView 未创建）：这条路是通的，只是本轮没帧
                logLumaTransition("no-player", 0);
                resolveLumaUnavailable(call);
                return;
            }
            View surface = playerView.getVideoSurfaceView();
            if (!(surface instanceof SurfaceView)) {
                // 纹理渲染 / 未挂播放器：系统没有可截的 surface，永久不通
                logLumaTransition("unsupported", 0);
                JSObject ret = new JSObject();
                ret.put("unsupported", true);
                ret.put("generation", surfaceGeneration);
                call.resolve(ret);
                return;
            }
            // P1-4：surface 无效（未起播、纯音频收起画面、离开播放页、尺寸还没量出来）时
            // 直接回执，不再排 PixelCopy 和 1.5s 兜底定时器——JS 收到这一档就停轮询等恢复。
            if (!surfaceSamplable()) {
                logLumaTransition("surface-invalid", 0);
                resolveLumaSurfaceInvalid(call);
                return;
            }
            if (lumaBusy) {
                logLumaTransition("busy", 0);
                resolveLumaUnavailable(call);
                return;
            }
            SurfaceView surfaceView = (SurfaceView) surface;
            int width = surfaceView.getWidth();
            int height = surfaceView.getHeight();
            if (lumaFrame == null || lumaFrame.getWidth() != width || lumaFrame.getHeight() != height) {
                if (lumaFrame != null) lumaFrame.recycle();
                lumaFrame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                lumaRow = new int[width];
            }
            final Bitmap dest = lumaFrame;
            final int[] row = lumaRow;
            final JSObject box = lumaBoxOf(surfaceView);
            // 抓帧是异步的：回执带上**发起时**的代次，JS 才能认出"这张图属于上一代 surface"
            final int generation = surfaceGeneration;
            // SurfaceView 版 PixelCopy 只有异步回调（Window 版才同步返回状态），框架也不保证
            // 一定会回调，所以这一轮用 settled 收口一次：兜底超时与回调都排在 mainHandler 上，天然串行。
            final boolean[] settled = new boolean[1];
            final Runnable deadline = () -> settleLuma(call, settled, null, null, generation);
            lumaBusy = true;
            lumaCopyStartedAt = SystemClock.elapsedRealtime();
            mainHandler.postDelayed(deadline, LUMA_COPY_TIMEOUT_MS);
            try {
                PixelCopy.request(surfaceView, dest, result -> {
                    mainHandler.removeCallbacks(deadline);
                    if (result != PixelCopy.SUCCESS) {
                        // 超时 / surface 暂无 buffer（切集、进 PiP、纯音频）：本轮无帧
                        settleLuma(call, settled, null, null, generation);
                        return;
                    }
                    // PixelCopy 只能整帧拷贝，逐格求均值放到专用线程，别在播放的主线程上卡出掉帧
                    lumaExecutor().execute(() -> {
                        JSArray computed = null;
                        try {
                            computed = lumaCells(dest, row, cols, rows);
                        } catch (Throwable e) {
                            com.qoder.cinema.AppLog.w("ExoPlayerPlugin", "lumaCells failed: " + e);
                        }
                        final JSArray cells = computed;
                        mainHandler.post(() -> settleLuma(call, settled, cells, box, generation));
                    });
                }, mainHandler);
            } catch (Throwable e) {
                mainHandler.removeCallbacks(deadline);
                com.qoder.cinema.AppLog.w("ExoPlayerPlugin", "sampleFrameLuma failed: " + e);
                settleLuma(call, settled, null, null, generation);
            }
        });
    }

    /**
     * 结束一轮取样：cells 为 null 表示本轮没有帧。
     * 只在主线程调用，所以 settled / lumaBusy 都不需要额外同步。
     */
    private void settleLuma(PluginCall call, boolean[] settled, JSArray cells, JSObject box, int generation) {
        if (settled[0]) return;
        settled[0] = true;
        lumaBusy = false;
        long elapsedMs = SystemClock.elapsedRealtime() - lumaCopyStartedAt;
        // 抓帧期间 surface 换了一代（切集 / 纯音频 / 离开播放页）：这张图属于旧画面，不交出去
        boolean stale = generation != surfaceGeneration;
        if (stale) cells = null;
        if (lumaRetired) disposeLumaScratch();
        if (cells == null || box == null) {
            logLumaTransition(stale ? "stale-generation" : "no-frame", elapsedMs);
            resolveLumaUnavailable(call);
            return;
        }
        logLumaTransition("sampling", elapsedMs);
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("cells", cells);
        ret.put("box", box);
        ret.put("generation", generation);
        call.resolve(ret);
    }

    /** 降采样线程惰性创建；单条串行，所以两轮取样不会同时写同一张位图 */
    private ExecutorService lumaExecutor() {
        if (lumaDownsampler == null || lumaDownsampler.isShutdown()) {
            lumaDownsampler = Executors.newSingleThreadExecutor(r -> new Thread(r, "danmaku-luma"));
        }
        return lumaDownsampler;
    }

    private void resolveLumaUnavailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", false);
        ret.put("generation", surfaceGeneration);
        call.resolve(ret);
    }

    /** P1-4：surface 这一代根本截不到（区别于"这一轮没帧"）——JS 据此停轮询，等 surface 事件恢复 */
    private void resolveLumaSurfaceInvalid(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", false);
        ret.put("surfaceInvalid", true);
        ret.put("generation", surfaceGeneration);
        call.resolve(ret);
    }

    /**
     * surface 在 PlayerView 里的归一化矩形。
     *
     * JS 侧的亮度场要铺满整块弹幕画布，而 surface 只是其中的内容区（contain 时有黑边）。
     * 直接量出来的比按视频长宽重算更准：各向异性像素、cover/fill 拉伸都在这里天然正确。
     */
    @OptIn(markerClass = UnstableApi.class)
    private JSObject lumaBoxOf(View surface) {
        int[] at = new int[2];
        int[] base = new int[2];
        surface.getLocationInWindow(at);
        playerView.getLocationInWindow(base);
        double pw = Math.max(1, playerView.getWidth());
        double ph = Math.max(1, playerView.getHeight());
        JSObject box = new JSObject();
        box.put("left", (at[0] - base[0]) / pw);
        box.put("top", (at[1] - base[1]) / ph);
        box.put("width", Math.max(0, surface.getWidth()) / pw);
        box.put("height", Math.max(0, surface.getHeight()) / ph);
        return box;
    }

    /** 逐格求块内 sRGB 均值，再换算成 0~255 的相对亮度 */
    private static JSArray lumaCells(Bitmap src, int[] row, int cols, int rows) {
        JSArray out = new JSArray();
        int width = src.getWidth();
        int height = src.getHeight();
        for (int r = 0; r < rows; r++) {
            double bandTop = r * (double) height / rows;
            double bandBottom = (r + 1) * (double) height / rows;
            int bandLines = Math.max(1, Math.min(LUMA_LINES_PER_ROW, (int) Math.max(1, bandBottom - bandTop)));
            long[] sumR = new long[cols];
            long[] sumG = new long[cols];
            long[] sumB = new long[cols];
            int[] count = new int[cols];
            for (int li = 0; li < bandLines; li++) {
                int y = (int) Math.min(height - 1, Math.max(0, bandTop + (li + 0.5) * (bandBottom - bandTop) / bandLines));
                src.getPixels(row, 0, width, 0, y, width, 1);
                for (int c = 0; c < cols; c++) {
                    int x0 = (int) (c * (double) width / cols);
                    int x1 = (int) ((c + 1) * (double) width / cols);
                    if (x1 <= x0) x1 = Math.min(width, x0 + 1);
                    for (int x = x0; x < x1 && x < width; x++) {
                        int px = row[x];
                        sumR[c] += (px >> 16) & 0xff;
                        sumG[c] += (px >> 8) & 0xff;
                        sumB[c] += px & 0xff;
                        count[c] += 1;
                    }
                }
            }
            for (int c = 0; c < cols; c++) {
                int n = count[c];
                if (n <= 0) {
                    out.put(0);
                    continue;
                }
                double luma = 0.2126 * SRGB_LINEAR[(int) (sumR[c] / n)]
                        + 0.7152 * SRGB_LINEAR[(int) (sumG[c] / n)]
                        + 0.0722 * SRGB_LINEAR[(int) (sumB[c] / n)];
                out.put((int) Math.round(Math.max(0d, Math.min(1d, luma)) * 255));
            }
        }
        return out;
    }

    /** 离开播放页 / 销毁：把取样用的整帧位图还给系统 */
    private void recycleLumaScratch() {
        lumaRetired = true;
        // 还有一帧在飞（PixelCopy 最长 1.5s 才回执）：此刻抽走目标位图等于让框架往已回收的内存里写。
        // 交给 settleLuma 落地后再回收，兜底定时器保证它一定会来。
        if (lumaBusy) return;
        disposeLumaScratch();
    }

    private void disposeLumaScratch() {
        lumaRetired = false;
        lumaBusy = false;
        if (lumaDownsampler != null) {
            lumaDownsampler.shutdownNow();
            lumaDownsampler = null;
        }
        if (lumaFrame != null) {
            try {
                lumaFrame.recycle();
            } catch (Exception ignored) {
                // 已回收或正被占用：没有可恢复动作
            }
            lumaFrame = null;
        }
        lumaRow = null;
    }

    private void ensureOverlay() {
        if (overlay != null) {
            overlay.setVisibility(View.VISIBLE);
            return;
        }
        overlay = new FrameLayout(getContext());
        // 原生视频容器与 PlayerView 都设黑底：FIT 模式下 letterbox 区域为黑色，
        // 避免透出下层 Activity/WebView 的白色窗口（深色主题下尤为刺眼）
        overlay.setBackgroundColor(Color.BLACK);
        PlayerView view = new PlayerView(getContext());
        view.setUseController(false);
        view.setBackgroundColor(Color.BLACK);
        view.setShutterBackgroundColor(Color.BLACK);
        // v1.8/CHG-25：不消费触摸——事件回落到下层 WebView（手势/HUD 由 JS 层处理）
        view.setClickable(false);
        view.setLongClickable(false);
        view.setFocusable(false);
        overlay.setClickable(false);
        overlay.setFocusable(false);
        overlay.addView(view);
        playerView = view;
        watchSurface(view);
        // v1.8 修复：surface 放到 WebView 之下（z 序最低），HTML 控件叠在视频之上
        // WebView 背景透明后，视频从下层透出；控件/字幕/弹幕在 WebView 里渲染，自然可见
        ViewGroup parent = (ViewGroup) getBridge().getWebView().getParent();
        parent.addView(overlay, 0);
    }
}
