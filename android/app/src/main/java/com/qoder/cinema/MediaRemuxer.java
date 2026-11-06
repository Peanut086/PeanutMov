package com.qoder.cinema;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.os.StatFs;
import android.os.SystemClock;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/**
 * MPEG-TS → MP4 纯转封装（FR-60 / D-01 / Q-09=A）
 *
 * 设计要点：
 * - **只做解复用 + 复用**：用 {@link MediaExtractor} 逐样本读出，原样写入 {@link MediaMuxer}。
 *   全程不创建 {@link android.media.MediaCodec} 编解码器，编码/分辨率/码率/帧率与源一致
 *   （§8.3.6 硬约束）。
 * - **流式拷贝**：单样本缓冲区（初始 256KB，最大 16MB），内存峰值与文件大小无关
 *   （§6.5 ≤128MB），500MB 输入只受 I/O 限制。
 * - **原子性**：输出先写 `{output}.part`，`stop()` + `fsync` 成功后再原子 rename；
 *   任何失败/取消/超时都会删除 `.part`，绝不留下半截 MP4（AC-143）。
 * - **结果即数据**：不抛业务异常，统一返回 {@link Result}（ok / skipped / code + 统计），
 *   调用方（{@code MediaToolPlugin}）据此回退 `.ts`，避免"半失败"语义扩散。
 *
 * 边界（已知限制，见技术方案 R-01）：
 * - MediaExtractor 对部分 TS（HEVC 变体、AC3/EAC3、坏包）解复用失败 → {@code E_UNSUPPORTED_FORMAT}，调用方保留 `.ts`；
 * - 多音轨只封装第一条音频轨（保持源编码，不做码流切换）；本类不写文本轨（tx3g 不支持，FR-64 走外挂字幕）。
 *
 * 时间轴处理：HLS 分片拼接出来的 TS 常在分片边界出现 PTS 回绕/重置。这里按轨记录偏移量，
 * 一旦归一化后的 PTS 回退就把偏移量补回去（而不是把后续样本也压平），保证时长与音画同步不塌陷。
 *
 * @author xyp
 */
public final class MediaRemuxer {

    private static final String TAG = "MediaRemuxer";

    // ========== 错误码（与技术方案 API-17 错误码表一致，不新增） ==========
    public static final String CODE_INVALID_INPUT = "E_INVALID_INPUT";
    public static final String CODE_FILE_MISSING = "E_FILE_MISSING";
    public static final String CODE_UNSUPPORTED = "E_UNSUPPORTED_FORMAT";
    public static final String CODE_STORAGE = "E_STORAGE_QUOTA";
    public static final String CODE_TIMEOUT = "E_TIMEOUT";
    public static final String CODE_CANCELED = "E_CANCELED";

    // ========== skipped / 细节 reason（不新增错误码，reason 承载细分语义） ==========
    public static final String REASON_NO_VIDEO = "no-video-track";
    public static final String REASON_NO_SAMPLES = "no-samples";
    public static final String REASON_UNSUPPORTED_CODEC = "unsupported-codec";
    public static final String REASON_SAMPLE_TOO_LARGE = "sample-too-large";
    public static final String REASON_INSUFFICIENT_SPACE = "insufficient-space";
    public static final String REASON_RENAME_FAILED = "rename-failed";
    public static final String REASON_OUTPUT_EMPTY = "output-empty";
    public static final String REASON_TIMEOUT = "timeout";
    public static final String REASON_CANCELED = "canceled";

    /** 临时文件后缀；最终交付名形如 `ep3.mp4` → `ep3.mp4.part`（AC-143 "无 `.mp4.part` 残留"） */
    public static final String PART_SUFFIX = ".part";

    public static final long DEFAULT_TIMEOUT_MS = 120_000L;

    /** 样本缓冲初始容量：覆盖绝大多数 H.264 关键帧 */
    private static final int INITIAL_SAMPLE_BUFFER = 256 * 1024;
    private static final int MAX_SAMPLE_BUFFER = 16 * 1024 * 1024;

    /** 进度回调节流（AC/§3.1.6：≤2 次/秒） */
    private static final long PROGRESS_INTERVAL_MS = 500L;
    /** 每 N 个样本检查一次取消/超时，避免每样本调用系统时钟 */
    private static final int CANCELLATION_CHECK_INTERVAL = 64;
    /** 预留空间下限：小于此值即使输入很小也判定写不下 */
    private static final long MIN_FREE_SPACE_MARGIN = 8L * 1024 * 1024;

    private MediaRemuxer() {}

    /** 进度回调；参数为已写入的媒体时间（µs）与总时长（µs，未知时为 0） */
    public interface ProgressListener {
        void onProgress(long processedUs, long durationUs);
    }

    /** 取消信号；返回 true 表示调用方要求中止 */
    public interface CancelSignal {
        boolean isCanceled();
    }

    /** 单条已封装轨道（回传给 JS 的 `tracks` 数组） */
    public static final class Track {
        public final String type;
        public final String mime;
        public final int width;
        public final int height;
        public final int channels;
        public final int sampleRate;

        Track(String type, String mime, int width, int height, int channels, int sampleRate) {
            this.type = type;
            this.mime = mime;
            this.width = width;
            this.height = height;
            this.channels = channels;
            this.sampleRate = sampleRate;
        }
    }

    /** 转封装结果：成功 / 跳过 / 失败三种形态，均由调用方映射成 JS 响应 */
    public static final class Result {
        public boolean ok;
        public boolean skipped;
        public String reason;
        public String code;
        /** 成功时为目标文件绝对路径；失败/跳过为 null */
        public String outputPath;
        public long inputBytes;
        public long outputBytes;
        public long durationUs;
        public long elapsedMs;
        /** 成功为 mp4；失败/跳过为 ts（产物仍是原 TS） */
        public String container = "ts";
        public final List<Track> tracks = new ArrayList<>();
    }

    /**
     * 执行转封装。
     *
     * @param input        已存在的 TS 文件（调用方负责校验存在与可读）
     * @param output       目标 MP4 路径；内部写 `{output}.part` 后原子 rename
     * @param deleteInput  成功后是否删除输入文件
     * @param timeoutMs    超时（≤0 时用默认 120s）
     * @param listener     进度回调，可为 null
     * @param cancelSignal 取消信号，可为 null
     */
    public static Result remux(File input, File output, boolean deleteInput, long timeoutMs,
                               ProgressListener listener, CancelSignal cancelSignal) {
        final long startedAt = SystemClock.elapsedRealtime();
        final long effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        final Result result = new Result();

        if (input == null || output == null) {
            return failure(result, CODE_INVALID_INPUT, "null-path", startedAt);
        }

        result.inputBytes = input.length();
        if (!input.isFile() || result.inputBytes <= 0) {
            return failure(result, CODE_FILE_MISSING, "input-missing", startedAt);
        }

        final File part = new File(output.getPath() + PART_SUFFIX);
        File parent = part.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            return failure(result, CODE_STORAGE, "output-dir-unwritable", startedAt);
        }
        if (part.exists() && !part.delete()) {
            return failure(result, CODE_STORAGE, "stale-part-undeletable", startedAt);
        }
        if (!hasEnoughSpace(parent != null ? parent : output, result.inputBytes)) {
            return failure(result, CODE_STORAGE, REASON_INSUFFICIENT_SPACE, startedAt);
        }

        MediaExtractor extractor = null;
        MediaMuxer muxer = null;
        boolean muxerStarted = false;
        try {
            extractor = new MediaExtractor();
            try {
                extractor.setDataSource(input.getAbsolutePath());
            } catch (IOException e) {
                throw new RemuxFailure(codeForIo(e), "extractor-open");
            }

            TrackSelection selection = selectTracks(extractor);
            if (selection.videoFormat == null) {
                // 无视频轨不是错误：按 skipped 交回调用方（API-17「响应（跳过）」）
                result.skipped = true;
                result.reason = REASON_NO_VIDEO;
                return result;
            }

            result.tracks.add(toTrack("video", selection.videoFormat));
            if (selection.audioFormat != null) {
                result.tracks.add(toTrack("audio", selection.audioFormat));
            }

            try {
                muxer = new MediaMuxer(part.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            } catch (IOException e) {
                throw new RemuxFailure(CODE_STORAGE, "muxer-create");
            }

            int videoOut;
            int audioOut = -1;
            try {
                videoOut = muxer.addTrack(selection.videoFormat);
                if (selection.audioFormat != null) {
                    audioOut = muxer.addTrack(selection.audioFormat);
                }
            } catch (IllegalArgumentException e) {
                // 不支持的编码组合（典型：H.264 + AC3/EAC3）→ 回退 .ts，绝不丢音轨硬转
                throw new RemuxFailure(CODE_UNSUPPORTED, REASON_UNSUPPORTED_CODEC);
            }
            applyRotationHint(muxer, selection.videoFormat);

            muxer.start();
            muxerStarted = true;

            CopyStats stats = copySamples(extractor, muxer, selection, videoOut, audioOut,
                    SystemClock.elapsedRealtime() + effectiveTimeoutMs, listener, cancelSignal);

            if (stats.writtenSamples == 0 || stats.videoSamples == 0) {
                // 没有任何视频样本（含"始终找不到关键帧"）视为不可封装
                throw new RemuxFailure(CODE_UNSUPPORTED, REASON_NO_SAMPLES);
            }

            // stop() 会把 MP4 的 moov 写完；失败（含 0 样本）由外层 catch 收口
            muxer.stop();
            muxerStarted = false;
            muxer.release();
            muxer = null;

            extractor.release();
            extractor = null;

            if (part.length() <= 0) {
                throw new RemuxFailure(CODE_STORAGE, REASON_OUTPUT_EMPTY);
            }
            syncFile(part);
            if (!moveInto(part, output)) {
                throw new RemuxFailure(CODE_STORAGE, REASON_RENAME_FAILED);
            }

            result.ok = true;
            result.outputPath = output.getAbsolutePath();
            result.outputBytes = output.length();
            result.durationUs = stats.durationUs;
            result.elapsedMs = SystemClock.elapsedRealtime() - startedAt;
            result.container = "mp4";

            if (deleteInput) {
                // AC-142：成功后删除原 .ts；删除失败不影响转封装结果（回调里已提示）
                if (!input.delete() && input.exists()) {
                    AppLog.w(TAG, "remux done but input delete failed: " + input.getName());
                }
            }
            return result;
        } catch (RemuxFailure f) {
            return failure(result, f.code, f.reason, startedAt);
        } catch (IllegalArgumentException e) {
            // MediaMuxer/MediaExtractor 对编码或样本不兼容统一抛 IllegalArgumentException
            AppLog.w(TAG, "remux rejected by platform: " + e.getMessage());
            return failure(result, CODE_UNSUPPORTED, REASON_UNSUPPORTED_CODEC, startedAt);
        } catch (RuntimeException e) {
            AppLog.e(TAG, "remux runtime failure", e);
            return failure(result, CODE_UNSUPPORTED, "platform-error", startedAt);
        } finally {
            if (muxer != null) {
                try {
                    if (muxerStarted) muxer.stop();
                } catch (Exception ignored) {
                    // stop 失败说明封装未完成，part 会在下面被删除
                }
                try {
                    muxer.release();
                } catch (Exception ignored) {
                }
            }
            if (extractor != null) {
                try {
                    extractor.release();
                } catch (Exception ignored) {
                }
            }
            if (!result.ok) {
                deleteQuietly(part);
            }
        }
    }

    // ========== 样本拷贝 ==========

    private static final class CopyStats {
        long writtenSamples;
        long videoSamples;
        long durationUs;
    }

    /**
     * 逐样本拷贝：不缓冲整片，不触碰解码器。
     * 每 {@link #CANCELLATION_CHECK_INTERVAL} 个样本检查一次取消与超时。
     */
    private static CopyStats copySamples(MediaExtractor extractor, MediaMuxer muxer,
                                         TrackSelection selection, int videoOut, int audioOut,
                                         long deadlineAt, ProgressListener listener,
                                         CancelSignal cancelSignal) throws RemuxFailure {
        CopyStats stats = new CopyStats();
        ByteBuffer buffer = ByteBuffer.allocateDirect(INITIAL_SAMPLE_BUFFER);
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        long firstPtsUs = Long.MIN_VALUE;
        long videoOffsetUs = 0L;
        long audioOffsetUs = 0L;
        long lastVideoUs = -1L;
        long lastAudioUs = -1L;
        long lastProgressAt = 0L;
        long progressTotalUs = selection.durationUs;
        boolean videoSyncSeen = false;
        int sinceCheck = 0;

        while (true) {
            if (++sinceCheck >= CANCELLATION_CHECK_INTERVAL) {
                sinceCheck = 0;
                if (cancelSignal != null && cancelSignal.isCanceled()) {
                    throw new RemuxFailure(CODE_CANCELED, REASON_CANCELED);
                }
                if (SystemClock.elapsedRealtime() > deadlineAt) {
                    throw new RemuxFailure(CODE_TIMEOUT, REASON_TIMEOUT);
                }
            }

            int sampleTrack = extractor.getSampleTrackIndex();
            if (sampleTrack < 0) break; // 读到文件尾

            int outTrack = sampleTrack == selection.videoTrack
                    ? videoOut
                    : (sampleTrack == selection.audioTrack ? audioOut : -1);
            if (outTrack < 0) {
                // 未选中的轨（字幕 / 第二音轨 / 数据轨）直接丢弃，但不能漏 advance
                if (!extractor.advance()) break;
                continue;
            }

            boolean isVideo = outTrack == videoOut;
            if (isVideo && !videoSyncSeen) {
                int flags = extractor.getSampleFlags();
                if ((flags & MediaExtractor.SAMPLE_FLAG_SYNC) == 0) {
                    // 丢掉首个关键帧之前的视频样本：HLS 拼接流通常从关键帧开始，
                    // 例外情况直接封装会让产物开头花屏（音频样本不受影响）
                    if (!extractor.advance()) break;
                    continue;
                }
                videoSyncSeen = true;
            }

            int size;
            while (true) {
                try {
                    size = extractor.readSampleData(buffer, 0);
                    break;
                } catch (IllegalArgumentException tooSmall) {
                    int nextCapacity = buffer.capacity() * 2;
                    if (nextCapacity > MAX_SAMPLE_BUFFER) {
                        throw new RemuxFailure(CODE_UNSUPPORTED, REASON_SAMPLE_TOO_LARGE);
                    }
                    buffer = ByteBuffer.allocateDirect(nextCapacity);
                }
            }
            if (size < 0) break;

            long sampleTimeUs = extractor.getSampleTime();
            if (sampleTimeUs < 0) sampleTimeUs = 0;
            if (firstPtsUs == Long.MIN_VALUE) firstPtsUs = sampleTimeUs;

            long offset = isVideo ? videoOffsetUs : audioOffsetUs;
            long lastWritten = isVideo ? lastVideoUs : lastAudioUs;
            long candidate = sampleTimeUs - firstPtsUs + offset;
            if (candidate <= lastWritten) {
                // PTS 回绕 / 分片边界重置：补偏移量而不是压平时间轴，否则整段时长会塌陷
                offset += (lastWritten - candidate) + 1;
                candidate = lastWritten + 1;
            }
            if (isVideo) {
                videoOffsetUs = offset;
                lastVideoUs = candidate;
            } else {
                audioOffsetUs = offset;
                lastAudioUs = candidate;
            }

            info.set(0, size, candidate, extractor.getSampleFlags());
            muxer.writeSampleData(outTrack, buffer, info);
            stats.writtenSamples++;
            if (isVideo) stats.videoSamples++;

            long processedUs = Math.max(lastVideoUs, lastAudioUs);
            long now = SystemClock.elapsedRealtime();
            if (listener != null && now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                lastProgressAt = now;
                try {
                    listener.onProgress(processedUs, progressTotalUs);
                } catch (RuntimeException ignored) {
                    // 进度回调异常不得中断转封装
                }
            }

            if (!extractor.advance()) break;
        }

        stats.durationUs = Math.max(lastVideoUs, lastAudioUs);
        if (stats.durationUs <= 0 && selection.durationUs > 0) {
            stats.durationUs = selection.durationUs;
        }
        return stats;
    }

    // ========== 轨道选择 / 格式读取 ==========

    private static final class TrackSelection {
        int videoTrack = -1;
        int audioTrack = -1;
        MediaFormat videoFormat;
        MediaFormat audioFormat;
        long durationUs;
    }

    private static TrackSelection selectTracks(MediaExtractor extractor) {
        TrackSelection selection = new TrackSelection();
        int trackCount = extractor.getTrackCount();
        for (int i = 0; i < trackCount; i++) {
            MediaFormat format = extractor.getTrackFormat(i);
            String mime = format.containsKey(MediaFormat.KEY_MIME) ? format.getString(MediaFormat.KEY_MIME) : null;
            if (mime == null) continue;
            if (selection.videoTrack < 0 && mime.startsWith("video/")) {
                selection.videoTrack = i;
                selection.videoFormat = format;
            } else if (selection.audioTrack < 0 && mime.startsWith("audio/")) {
                selection.audioTrack = i;
                selection.audioFormat = format;
            }
        }
        if (selection.videoFormat != null && selection.videoFormat.containsKey(MediaFormat.KEY_DURATION)) {
            try {
                selection.durationUs = Math.max(0L, selection.videoFormat.getLong(MediaFormat.KEY_DURATION));
            } catch (RuntimeException ignored) {
                selection.durationUs = 0L;
            }
        }
        return selection;
    }

    private static Track toTrack(String type, MediaFormat format) {
        String mime = format.containsKey(MediaFormat.KEY_MIME) ? format.getString(MediaFormat.KEY_MIME) : "";
        return new Track(
                type,
                mime,
                intOrZero(format, MediaFormat.KEY_WIDTH),
                intOrZero(format, MediaFormat.KEY_HEIGHT),
                intOrZero(format, MediaFormat.KEY_CHANNEL_COUNT),
                intOrZero(format, MediaFormat.KEY_SAMPLE_RATE));
    }

    private static int intOrZero(MediaFormat format, String key) {
        try {
            if (format == null || !format.containsKey(key)) return 0;
            return Math.max(0, format.getInteger(key));
        } catch (RuntimeException ignored) {
            return 0;
        }
    }

    private static void applyRotationHint(MediaMuxer muxer, MediaFormat videoFormat) {
        try {
            if (videoFormat != null && videoFormat.containsKey(MediaFormat.KEY_ROTATION)) {
                muxer.setOrientationHint(videoFormat.getInteger(MediaFormat.KEY_ROTATION));
            }
        } catch (RuntimeException ignored) {
            // 旋转元数据不是必需项
        }
    }

    // ========== 文件系统 ==========

    private static boolean hasEnoughSpace(File dir, long inputBytes) {
        try {
            StatFs statFs = new StatFs(dir.getAbsolutePath());
            long free = statFs.getAvailableBytes();
            // 输出体积与输入同量级（MP4 略小），因此按输入体积预留 + 最小下限
            return free >= Math.max(inputBytes, MIN_FREE_SPACE_MARGIN);
        } catch (RuntimeException e) {
            // 无法探测时不阻断：真实写失败会以 E_STORAGE_QUOTA 落地
            return true;
        }
    }

    private static void syncFile(File file) {
        try (FileOutputStream fos = new FileOutputStream(file, true)) {
            fos.getFD().sync();
        } catch (Exception e) {
            AppLog.w(TAG, "fsync failed (continue): " + e.getMessage());
        }
    }

    /** 同目录原子 rename；跨设备/文件系统不支持时逐级降级，全部失败才返回 false */
    private static boolean moveInto(File part, File target) {
        try {
            Files.move(part.toPath(), target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (Exception atomicFailed) {
            if (part.renameTo(target)) return true;
            if (target.exists() && target.delete()) return part.renameTo(target);
            AppLog.w(TAG, "atomic move failed: " + atomicFailed.getClass().getSimpleName());
            return false;
        }
    }

    static boolean deleteQuietly(File file) {
        if (file == null) return true;
        try {
            return !file.exists() || file.delete();
        } catch (RuntimeException e) {
            return false;
        }
    }

    // ========== 内部工具 ==========

    private static Result failure(Result result, String code, String reason, long startedAt) {
        result.ok = false;
        result.skipped = false;
        result.code = code;
        result.reason = reason;
        result.elapsedMs = SystemClock.elapsedRealtime() - startedAt;
        return result;
    }

    /** IO 错误细分：ENOSPC → 配额；其余（解析失败、坏包）→ 格式不支持 */
    private static String codeForIo(IOException e) {
        String message = e.getMessage() == null ? "" : e.getMessage();
        if (message.contains("ENOSPC") || message.contains("No space")) return CODE_STORAGE;
        return CODE_UNSUPPORTED;
    }

    /** 内部中断信号（取消/超时/格式不支持），不对外暴露 */
    private static final class RemuxFailure extends Exception {
        final String code;
        final String reason;

        RemuxFailure(String code, String reason) {
            super(code + ": " + reason);
            this.code = code;
            this.reason = reason;
        }
    }
}
