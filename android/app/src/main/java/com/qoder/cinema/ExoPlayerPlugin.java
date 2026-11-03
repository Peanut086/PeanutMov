package com.qoder.cinema;

import android.app.PictureInPictureParams;
import android.graphics.Color;
import android.os.Build;
import android.util.Rational;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.common.Format;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.Tracks;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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

    private ExoPlayer player;
    private PlayerView playerView;
    private FrameLayout overlay;
    /** v1.8/CHG-25：本次会话累计丢帧（AnalyticsListener 累加，progress() 上报 AC-125 采样） */
    private long droppedFrames = 0;
    /** v1.8 优化：视频轨列表（清晰度切换） */
    private java.util.List<JSObject> videoTracks = new java.util.ArrayList<>();
    /** v1.8 优化：字幕轨列表 */
    private java.util.List<JSObject> textTracks = new java.util.ArrayList<>();
    /** v1.8 优化：播放质量指标 */
    private long bufferEvents = 0;
    private long bufferDurationMs = 0;
    private int currentBitrate = 0;
    private String decoderName = "";

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
        getBridge().executeOnMainThread(() -> {
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

                DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                        .setAllowCrossProtocolRedirects(true)
                        .setConnectTimeoutMs(15_000)
                        .setReadTimeoutMs(30_000);
                if (!headers.isEmpty()) {
                    httpFactory.setDefaultRequestProperties(headers);
                }

                boolean isHls = url.contains(".m3u8");
                DefaultMediaSourceFactory factory = new DefaultMediaSourceFactory(httpFactory);
                if (isHls) factory.setDataSourceFactory(httpFactory);

                player = new ExoPlayer.Builder(getContext())
                        .setMediaSourceFactory(factory)
                        .build();
                player.setMediaItem(MediaItem.fromUri(url));
                player.addListener(new Player.Listener() {
                    @Override
                    public void onPlaybackStateChanged(int playbackState) {
                        JSObject data = new JSObject();
                        if (playbackState == Player.STATE_READY) {
                            data.put("state", "ready");
                            data.put("duration", player.getDuration());
                            notifyListeners("exostate", data);
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
                        for (TrackGroup group : tracks.getGroups()) {
                            Format format = group.getTrackFormat(0);
                            if (format.sampleMimeType != null) {
                                if (format.sampleMimeType.startsWith("video/")) {
                                    for (int i = 0; i < group.length; i++) {
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
                                } else if (format.sampleMimeType.startsWith("text/") ||
                                          format.sampleMimeType.equals("application/x-subtitle-rip") ||
                                          format.sampleMimeType.equals("application/ttml+xml")) {
                                    for (int i = 0; i < group.length; i++) {
                                        Format f = group.getTrackFormat(i);
                                        JSObject track = new JSObject();
                                        track.put("id", textTracks.size());
                                        track.put("label", f.language != null ? f.language : "字幕 " + (textTracks.size() + 1));
                                        track.put("mimeType", f.sampleMimeType);
                                        textTracks.add(track);
                                    }
                                }
                            }
                        }
                        // 通知 JS 侧清晰度列表更新
                        JSObject data = new JSObject();
                        data.put("state", "qualities");
                        data.put("qualities", new JSArray(videoTracks));
                        notifyListeners("exostate", data);
                        // 通知 JS 侧字幕列表更新
                        JSObject subData = new JSObject();
                        subData.put("state", "textTracks");
                        subData.put("textTracks", new JSArray(textTracks));
                        notifyListeners("exostate", subData);
                    }
                });
                // v1.8/CHG-25：丢帧计数（AC-125 转正门槛的量化指标）
                player.addAnalyticsListener(new AnalyticsListener() {
                    @Override
                    public void onDroppedVideoFrames(AnalyticsListener.EventTime eventTime, int droppedFrames, long droppedToKeyframes) {
                        ExoPlayerPlugin.this.droppedFrames += droppedFrames;
                    }

                    @Override
                    public void onBufferingStateChanged(AnalyticsListener.EventTime eventTime, boolean isLoading) {
                        if (isLoading) {
                            bufferEvents++;
                        }
                    }

                    @Override
                    public void onDownstreamFormatChanged(AnalyticsListener.EventTime eventTime, androidx.media3.exoplayer.source.MediaLoadData eventData) {
                        currentBitrate = eventData.bitrate;
                    }

                    @Override
                    public void onDecoderInitialized(AnalyticsListener.EventTime eventTime, int trackType, androidx.media3.exoplayer.DecoderInitializationException decoderInitializationException) {
                        if (eventTime.trackFormat != null && eventTime.trackFormat.decoderName != null) {
                            decoderName = eventTime.trackFormat.decoderName;
                        }
                    }
                });

                playerView.setPlayer(player);
                player.prepare();
                // v1.8 修复：WebView 背景透明，让下层 surface 透出
                getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
                call.resolve();
            } catch (Exception e) {
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
            if (player != null) player.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (player != null) player.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double positionMs = call.getDouble("positionMs");
        getBridge().executeOnMainThread(() -> {
            if (player != null && positionMs != null) player.seekTo(positionMs.longValue());
            call.resolve();
        });
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

    /** v1.8 优化：获取字幕轨列表 */
    @PluginMethod
    public void getTextTracks(PluginCall call) {
        JSObject result = new JSObject();
        result.put("textTracks", new JSArray(textTracks));
        call.resolve(result);
    }

    /** v1.8 优化：切换字幕轨（-1 表示关闭） */
    @PluginMethod
    public void setTextTrack(PluginCall call) {
        Integer id = call.getInt("id");
        getBridge().executeOnMainThread(() -> {
            if (player != null) {
                androidx.media3.common.TrackSelectionParameters params = player.getTrackSelectionParameters()
                        .buildUpon()
                        .setTextTrackTypeIds(id != null && id >= 0 ? new int[]{androidx.media3.common.C.TRACK_TYPE_TEXT} : new int[]{})
                        .build();
                player.setTrackSelectionParameters(params);
            }
            call.resolve();
        });
    }

    /** v1.8 优化：获取播放质量指标 */
    @PluginMethod
    public void getPlaybackStats(PluginCall call) {
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
    }

    /** v1.8 优化：进入画中画模式 */
    @PluginMethod
    public void enterPip(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().executeOnMainThread(() -> {
                try {
                    Rational aspectRatio = new Rational(16, 9);
                    PictureInPictureParams params = new PictureInPictureParams.Builder()
                            .setAspectRatio(aspectRatio)
                            .build();
                    getActivity().enterPictureInPictureMode(params);
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

    @PluginMethod
    public void release(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            releasePlayerQuietly();
            if (playerView != null) playerView.setPlayer(null);
            if (overlay != null) overlay.setVisibility(View.GONE);
            // v1.8 修复：恢复 WebView 不透明背景
            getBridge().getWebView().setBackgroundColor(Color.WHITE);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        releasePlayerQuietly();
        super.handleOnDestroy();
    }

    private void releasePlayerQuietly() {
        if (player != null) {
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
    }

    private void ensureOverlay() {
        if (overlay != null) {
            overlay.setVisibility(View.VISIBLE);
            return;
        }
        overlay = new FrameLayout(getContext());
        PlayerView view = new PlayerView(getContext());
        view.setUseController(false);
        // v1.8 优化：使用 TextureView 替代 SurfaceView，透明合成更稳
        TextureView textureView = new TextureView(getContext());
        view.setVideoTextureView(textureView);
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
