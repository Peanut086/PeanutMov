package com.qoder.cinema;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;

/**
 * 离线文件抽帧（A 批次·A-03 进度条胶片预览）
 *
 * 职责边界：给一串时间戳，回一串 JPEG data URL。调度、缓存、降级都在 JS 侧，
 * 这里不读设置、不认识"播放页"。
 *
 * 取帧用 {@code OPTION_CLOSEST} 而不是 {@code OPTION_CLOSEST_SYNC}：胶片要贴着用户
 * 拖到的位置，落在上一个关键帧会让整条预览滞后半秒以上，看起来就是"对不上"。
 * 缩放交给 {@code getScaledFrameAtTime}（API 27）在解码器内完成：4K 关键帧原图约
 * 33MB，先解全图再缩会把峰值内存顶上去。个别机型仍会返回略大的帧（对齐粒度），
 * 所以 {@link #scaleToFit} 作为最后一道兜底保留。
 *
 * 失败按帧隔离：单帧取不到就跳过，绝不因为一帧让整条胶片陪葬；连文件都打不开时
 * 返回空数组，前端据此退回时间气泡。
 */
final class SeekFrameExtractor {

    private static final String TAG = "SeekFrameExtractor";
    private static final String DATA_URL_PREFIX = "data:image/jpeg;base64,";

    static final int DEFAULT_MAX_EDGE = 128;
    static final int DEFAULT_QUALITY = 60;

    private SeekFrameExtractor() {
    }

    /** 一次抽取的结果；{@code urls} 与请求下标的映射由 {@link Frame#index} 携带 */
    static final class Frame {
        final int index;
        final long timeMs;
        final String dataUrl;

        Frame(int index, long timeMs, String dataUrl) {
            this.index = index;
            this.timeMs = timeMs;
            this.dataUrl = dataUrl;
        }
    }

    /**
     * 按 {@code timesMs} 逐帧抽取。返回的数组只包含成功的帧（顺序与请求一致），
     * 全部失败时为空数组——调用方不需要区分"文件坏了"和"这一帧取不到"。
     */
    static Frame[] extract(File file, long[] timesMs, int maxEdge, int quality) {
        Frame[] scratch = new Frame[timesMs.length];
        int ok = 0;
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getAbsolutePath());
        } catch (RuntimeException e) {
            AppLog.w(TAG, "open failed: " + file.getName() + " -> " + e);
            releaseQuietly(retriever);
            return new Frame[0];
        }

        try {
            for (int i = 0; i < timesMs.length; i++) {
                // 线程被 shutdownNow 打断时尽早收工，不为没人等的结果继续解码
                if (Thread.currentThread().isInterrupted()) break;
                String url = frameAt(retriever, timesMs[i], maxEdge, quality);
                if (url == null) continue;
                scratch[i] = new Frame(i, timesMs[i], url);
                ok++;
            }
        } finally {
            releaseQuietly(retriever);
        }

        if (ok == 0) return new Frame[0];
        Frame[] frames = new Frame[ok];
        int cursor = 0;
        for (Frame frame : scratch) {
            if (frame != null) frames[cursor++] = frame;
        }
        return frames;
    }

    /** 抽一帧；解码或编码失败返回 null */
    private static String frameAt(MediaMetadataRetriever retriever, long timeMs, int maxEdge, int quality) {
        Bitmap decoded = null;
        Bitmap scaled = null;
        try {
            // 缩放在解码器内完成：4K 关键帧原图解出来约 33MB，先解全图再缩会把峰值内存顶上去
            decoded = retriever.getScaledFrameAtTime(timeMs * 1000,
                    MediaMetadataRetriever.OPTION_CLOSEST, maxEdge, maxEdge);
            if (decoded == null || decoded.getWidth() <= 0 || decoded.getHeight() <= 0) return null;

            scaled = scaleToFit(decoded, maxEdge);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(12 * 1024);
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, bytes);
            if (bytes.size() == 0) return null;
            return DATA_URL_PREFIX + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } catch (RuntimeException e) {
            AppLog.w(TAG, "frame @" + timeMs + "ms failed: " + e);
            return null;
        } finally {
            if (scaled != null && scaled != decoded) scaled.recycle();
            if (decoded != null) decoded.recycle();
        }
    }

    /**
     * 等比缩进 {@code maxEdge} 方框。解码器给的尺寸只是提示，硬解常按对齐粒度返回
     * 略大的帧，所以这里仍可能要做最后一次精确缩放。
     */
    private static Bitmap scaleToFit(Bitmap source, int maxEdge) {
        int width = source.getWidth();
        int height = source.getHeight();
        double ratio = Math.min((double) maxEdge / Math.max(width, height), 1.0);
        if (ratio >= 1.0) return source;
        int targetWidth = Math.max(1, (int) Math.round(width * ratio));
        int targetHeight = Math.max(1, (int) Math.round(height * ratio));
        return Bitmap.createScaledBitmap(source, targetWidth, targetHeight, true);
    }

    private static void releaseQuietly(MediaMetadataRetriever retriever) {
        try {
            retriever.release();
        } catch (RuntimeException | IOException ignored) {
            // 释放失败没有可恢复动作，也没有可上报价值
        }
    }
}
