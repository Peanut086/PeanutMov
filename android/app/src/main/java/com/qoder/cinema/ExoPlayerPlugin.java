package com.qoder.cinema;

import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.Rational;
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

                // P0-7: 续播位置随 prepare 下发（毫秒），0 或负数视为从头播放
                long startPositionMs = call.getLong("startPositionMs", 0L);

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
            if (playerView != null) playerView.setPlayer(null);
            if (overlay != null) overlay.setVisibility(View.GONE);
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
        // v1.8 修复：surface 放到 WebView 之下（z 序最低），HTML 控件叠在视频之上
        // WebView 背景透明后，视频从下层透出；控件/字幕/弹幕在 WebView 里渲染，自然可见
        ViewGroup parent = (ViewGroup) getBridge().getWebView().getParent();
        parent.addView(overlay, 0);
    }
}
