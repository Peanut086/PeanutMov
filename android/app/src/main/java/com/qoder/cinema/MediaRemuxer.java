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
 * 时间轴处理（P1-1 重写）：分片拼接的 TS 在边界出现 PTS 重置/回绕，而含 B 帧的流在解码序里
 * PTS 本来就不单调。两者由 {@link TimelineRewriter} 分开处置——真 discontinuity 补两轨共用的
 * 整体偏移，B 帧重排则因 MediaMuxer 无法表达合成偏移（ctts）而整条流明确跳过、保留可播 `.ts`。
 * 旧实现的逐轨棘轮会把 B 帧流压成 1µs 帧距，产出的正是真机「时间轴损坏、点了没反应」的坏件。
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
    /** P0-3：发布件复检不合格（容器打不开 / 无有效轨道 / 时长对不上 / 首中尾定位失败） */
    public static final String REASON_VERIFY_FAILED = "verify-failed";
    public static final String REASON_OUTPUT_EMPTY = "output-empty";
    public static final String REASON_TIMEOUT = "timeout";
    public static final String REASON_CANCELED = "canceled";
    /**
     * P1-1：含 B 帧的视频流——MediaMuxer 只能吃单调递增的呈现时间，无法表达解码序与
     * 合成偏移（ctts），照写会压平时间轴、跳过才是诚实口径。以 skipped 形态返回，
     * 调用方按"保留可播 .ts"处理（与 no-video-track 同一形状）。
     */
    public static final String REASON_BFRAMES_UNSUPPORTED = "bframes-not-expressible";
    /** P0-1：音频轨时间轴自检不通过（跨度/粒度异常），调用方按"保留 .ts"处理 */
    public static final String REASON_AUDIO_TIMELINE = "audio-timeline-mismatch";
    public static final String REASON_AUDIO_GRANULARITY = "audio-sample-granularity";

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
    /** 自检最小样本量：太短的片段统计没有意义 */
    private static final long VERIFY_MIN_SAMPLES = 200;
    /** 音轨时长下限（相对视频）：坏件音频只铺到 52:41 而视频 1:28:13，比值 0.60 */
    private static final double VERIFY_MIN_AUDIO_DURATION_RATIO = 0.90;
    /**
     * 音频样本粒度上限：一个 MP4 音频样本应按 `1024/samplerate` 推进。
     *
     * TS 的 PES 会把多帧 ADTS 打包成一个样本，棘轮后每个样本被记成 7 帧的时间
     * （162.5ms vs 23.2ms）→ 比值 6.9。1.5 足够宽容正常抖动，又能拦住整段粒度错。
     */
    private static final double VERIFY_MAX_AUDIO_SPAN_FACTOR = 1.5;
    /** 失败归因日志开关：产物只在 media-remux 线程写几行，不需要独立设置项 */
    private static final boolean VERBOSE = true;

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
        /**
         * P0-3：交付前复检结论。`pass`=发布件重新打开并通过容器/轨道/时长/首中尾定位；
         * 其余为具体失败项（`fail:*`）；`not-probed`=复检能力不可用（旧机型异常路径），
         * 此时按保守口径处理：不删输入。
         */
        public String probeVerdict = "not-probed";
        /** P0-3：输入文件是否还在。复检未通过或未做时为 true——交付可回滚的前提 */
        public boolean inputRetained = true;
        public final List<Track> tracks = new ArrayList<>();
    }

    /**
     * 执行转封装。
     *
     * @param input        已存在的 TS 文件（调用方负责校验存在与可读）
     * @param output       目标 MP4 路径；内部写 `{output}.part` 后原子 rename
     * @param deleteInput  复检通过并交付后是否删除输入文件（P0-3：调用方传 false，
     *                     由 JS 侧在下载记录落库成功后再删，保证交付可回滚）
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
            // MPEG2TS 嗅探完成后游标并不落在首个样本上，需显式定位；放在 selectTrack
            // 之后（官方要求选择轨道先于 seek）。
            TrackSelection selection = selectTracks(extractor);
            if (selection.videoFormat == null) {
                // 无视频轨不是错误：按 skipped 交回调用方（API-17「响应（跳过）」）
                result.skipped = true;
                result.reason = REASON_NO_VIDEO;
                return result;
            }
            if (VERBOSE) {
                AppLog.i(TAG, "tracks=" + extractor.getTrackCount() + " video=" + describe(selection.videoFormat)
                        + " audio=" + describe(selection.audioFormat));
            }
            // 真机现象：一条轨都不 select 时，tracks / duration 全读得到，但
            // readSampleData 立刻返回 -1（等于空文件）。MPEG2TS 源只对已选择轨道吐样本。
            extractor.selectTrack(selection.videoTrack);
            if (selection.audioTrack >= 0) extractor.selectTrack(selection.audioTrack);
            extractor.seekTo(0, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

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
                if (VERBOSE) {
                    AppLog.i(TAG, "no-samples detail: written=" + stats.writtenSamples
                            + " video=" + stats.videoSamples + " audio=" + stats.audioSamples
                            + " preSyncDropped=" + stats.preSyncDropped + " sawSync=" + stats.sawSync
                            + " lastVideoUs=" + stats.durationUs);
                }
                throw new RemuxFailure(CODE_UNSUPPORTED, REASON_NO_SAMPLES);
            }

            // P1-1：结构完整 ≠ 能播。B 帧流在拷贝循环里就已按 skipped 收口；
            // 这里剩下的否决项都在音频轴（跨度/粒度）——`.part` 由 finally 删除，
            // 输入 .ts 保留，播放回落到原生引擎直接解封装 TS。
            String timelineIssue = inspectTimeline(stats);
            if (timelineIssue != null) {
                AppLog.w(TAG, "remux output rejected by timeline check: " + timelineIssue
                        + " audioUs=" + stats.audioSpanUs + "/" + stats.audioSamples
                        + " videoUs=" + stats.videoSpanUs + "/" + stats.videoSamples
                        + " boundaryShifts=" + stats.timeline.boundaryShifts);
                throw new RemuxFailure(CODE_UNSUPPORTED, timelineIssue);
            }

            if (VERBOSE) {
                TimelineRewriter t = stats.timeline;
                AppLog.i(TAG, "remux timeline ok timeBaseUs=1000000"
                        + " video=" + stats.videoSamples + " audio=" + stats.audioSamples
                        + " syncSamples=" + stats.syncSamples
                        + " ptsVideoUs=[" + t.videoFirstPtsUs + ".." + t.videoLastPtsUs + "]"
                        + " ptsAudioUs=[" + t.audioFirstPtsUs + ".." + t.audioLastPtsUs + "]"
                        + " avOriginGapUs=" + t.avOriginGapUs()
                        + " boundaryShifts=" + t.boundaryShifts + "/" + t.boundaryShiftUs + "us"
                        + " spanUs=" + stats.durationUs);
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

            /*
             * P0-3：发布之后、删输入之前，把交付件重新打开验一遍。
             * 复检不合格就撤下发布件、留住输入 `.ts`——"转封装失败"与"转封装把一个能播的
             * 文件换成一个不能播的"是两回事，后者过去无法回滚（输入已删，只能整集重下）。
             */
            String probeIssue = probePublished(output, stats.durationUs);
            result.probeVerdict = probeIssue == null ? "pass" : probeIssue;
            if (probeIssue != null) {
                AppLog.w(TAG, "remux published but rejected by probe: " + probeIssue
                        + " file=" + output.getName());
                deleteQuietly(output);
                result.inputRetained = true;
                throw new RemuxFailure(CODE_UNSUPPORTED, REASON_VERIFY_FAILED + ":" + probeIssue);
            }

            result.ok = true;
            result.outputPath = output.getAbsolutePath();
            result.outputBytes = output.length();
            result.durationUs = stats.durationUs;
            result.elapsedMs = SystemClock.elapsedRealtime() - startedAt;
            result.container = "mp4";

            if (deleteInput) {
                // AC-142：复检通过后才删除原 .ts；删除失败不影响转封装结果（回调里已提示）
                if (!input.delete() && input.exists()) {
                    AppLog.w(TAG, "remux done but input delete failed: " + input.getName());
                    result.inputRetained = true;
                } else {
                    result.inputRetained = false;
                }
            }
            return result;
        } catch (RemuxFailure f) {
            if (f.skip) {
                // P1-1：能力形态（B 帧流）与失败形态分开——skipped=true、不带错误码，
                // 与 no-video-track 同形，JS 侧 decideRemuxDelivery 直接记成 skipped
                result.skipped = true;
                result.reason = f.reason;
                result.elapsedMs = SystemClock.elapsedRealtime() - startedAt;
                return result;
            }
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

    // ========== 交付件复检（P0-3） ==========

    /** 复检时长容差：MP4 轨时长应落在拷贝跨度与"跨度 + 一帧"之间，留 10%/20% 双边余量 */
    private static final double VERIFY_MIN_DURATION_RATIO = 0.90;
    private static final double VERIFY_MAX_DURATION_RATIO = 1.20;

    /** 复检里尾点与结尾的距离：最后一秒内必须能定位到一个真实样本 */
    private static final long VERIFY_TAIL_BACKOFF_US = 1_000_000L;

    /**
     * 把已经发布（或已经存在于盘上）的 MP4 重新打开验一遍：容器可解析、有有效视频轨、
     * 时长与拷贝跨度对得上、首/中/尾三处都能定位到真实样本。
     *
     * 返回 null = 通过；否则返回失败项（调用方写进 `probeVerdict`）。
     * 任何异常都归成失败项而不外抛——复检的语义是"不确定就别删原件"。
     */
    public static String probePublished(File file, long expectedDurationUs) {
        if (file == null || !file.isFile() || file.length() <= 0) return "missing-output";
        MediaExtractor extractor = null;
        try {
            extractor = new MediaExtractor();
            extractor.setDataSource(file.getAbsolutePath());
            int trackCount = extractor.getTrackCount();
            if (trackCount <= 0) return "no-tracks";
            int videoTrack = -1;
            MediaFormat videoFormat = null;
            for (int i = 0; i < trackCount; i += 1) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    videoTrack = i;
                    videoFormat = format;
                    break;
                }
            }
            if (videoTrack < 0) return "no-video-track";
            if (intOrZero(videoFormat, MediaFormat.KEY_WIDTH) <= 0
                    || intOrZero(videoFormat, MediaFormat.KEY_HEIGHT) <= 0) {
                return "invalid-dimensions";
            }
            long durationUs = longOrZero(videoFormat, MediaFormat.KEY_DURATION);
            if (durationUs <= 0) return "no-duration";
            if (expectedDurationUs > 0) {
                double ratio = (double) durationUs / (double) expectedDurationUs;
                if (ratio < VERIFY_MIN_DURATION_RATIO || ratio > VERIFY_MAX_DURATION_RATIO) {
                    return "duration-drift-" + Math.round(ratio * 100);
                }
            }
            extractor.selectTrack(videoTrack);
            ByteBuffer buffer = ByteBuffer.allocateDirect(1024 * 1024);
            long[] points = new long[] {
                    0L,
                    durationUs / 2L,
                    Math.max(0L, durationUs - VERIFY_TAIL_BACKOFF_US),
            };
            for (int i = 0; i < points.length; i += 1) {
                long point = points[i];
                extractor.seekTo(point, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
                buffer.clear();
                int size = extractor.readSampleData(buffer, 0);
                long sampleTime = extractor.getSampleTime();
                if (size <= 0 || sampleTime < 0) {
                    // P1-1 验收字段：seekResult（命中的样本时间与请求点之差）与读取规模
                    AppLog.w(TAG, "probe seek miss pointUs=" + point + " sampleUs=" + sampleTime
                            + " positionDeltaUs=" + (sampleTime < 0 ? -1 : sampleTime - point)
                            + " size=" + size + " file=" + file.getName());
                    return (i == 0 ? "head-" : i == 1 ? "middle-" : "tail-") + "seek-miss";
                }
            }
            return null;
        } catch (Exception e) {
            return "probe-error-" + e.getClass().getSimpleName();
        } finally {
            if (extractor != null) {
                try {
                    extractor.release();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /** 复检入口（开机对账 / 手动自检）：没有参考跨度时只验结构 */
    public static String probePublished(File file) {
        return probePublished(file, 0L);
    }

    // ========== 样本拷贝 ==========

    private static final class CopyStats {
        long writtenSamples;
        long videoSamples;
        long audioSamples;
        long preSyncDropped;
        /** P1-1：时间轴重写器（µs 口径的首末 PTS、discontinuity 偏移都在它身上） */
        final TimelineRewriter timeline = new TimelineRewriter();
        /** 写入的关键帧样本数（stss 规模，与 ffprobe 的 sync 计数对照） */
        long syncSamples;
        /** P0-1：音频轨"实际写出的时间跨度"对应的每样本间隔（µs），用于粒度判定 */
        long audioSpanUs;
        long audioFrameUs;
        /** 视频/音频轨最后写出的样本时间（µs），即各自在产物里占据的时间跨度 */
        long videoSpanUs;
        boolean sawSync;
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

        final TimelineRewriter timeline = stats.timeline;
        final long[] candidateUs = new long[1];
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

            // 先读样本、再问归属：MediaExtractor 在第一次 readSampleData 之前不会填充
            // 当前样本，直接 getSampleTrackIndex() 只会拿到 -1，于是整条流被当成空
            // （Google 官方转封装示例同样以 readSampleData 作为循环驱动条件）。
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

            int sampleTrack = extractor.getSampleTrackIndex();
            if (sampleTrack < 0) break; // 未选择任何有效轨

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
                    stats.preSyncDropped++;
                    if (!extractor.advance()) break;
                    continue;
                }
                videoSyncSeen = true;
                stats.sawSync = true;
            }

            long sampleTimeUs = extractor.getSampleTime();
            if (sampleTimeUs < 0) sampleTimeUs = 0;
            int verdict = timeline.rewrite(isVideo, sampleTimeUs, candidateUs);
            if (verdict == TimelineRewriter.BFRAME_REORDER) {
                // 解码序里出现 ≤1s 的视频回退 = B 帧重排。平台封装无法表达这种流的时序，
                // 在首个 GOP 附近就收口（成本几十字节），不写一份"完整但播不动"的 MP4。
                throw new RemuxFailure(CODE_UNSUPPORTED, REASON_BFRAMES_UNSUPPORTED
                        + ":depthUs=" + timeline.maxVideoReorderUs + "@videoSample" + stats.videoSamples, true);
            }
            long candidate = candidateUs[0];

            // Extractor 的 flag 与 MediaCodec.BufferInfo 的 flag 只是"看起来能直接抄"：
            // PARTIAL_FRAME(4) 会被 muxer 读成 END_OF_STREAM、ENCRYPTED(2) 读成 CODEC_CONFIG，
            // 于是大量正常样本被当成流尾/编解码配置写进 MP4（真机坏件的次要成因）。
            // 只有同步样本这一位语义一致，单独映射成关键帧标志。
            int muxerFlags = (extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0
                    ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
            info.set(0, size, candidate, muxerFlags);
            muxer.writeSampleData(outTrack, buffer, info);
            stats.writtenSamples++;
            if (muxerFlags != 0 && isVideo) stats.syncSamples++;
            if (isVideo) stats.videoSamples++; else stats.audioSamples++;

            long processedUs = timeline.processedUs();
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

        stats.durationUs = timeline.processedUs();
        if (stats.durationUs <= 0 && selection.durationUs > 0) {
            stats.durationUs = selection.durationUs;
        }
        stats.videoSpanUs = Math.max(0L, timeline.lastVideoUs());
        stats.audioSpanUs = Math.max(0L, timeline.lastAudioUs());
        stats.audioFrameUs = aacFrameDurationUs(selection.audioFormat);
        return stats;
    }

    /**
     * AAC 单帧时长（µs）：一帧固定 1024 个采样点。
     *
     * 非 AAC 音频返回 0，表示"这条判据不适用"，不做无依据的否决。
     */
    private static long aacFrameDurationUs(MediaFormat audioFormat) {
        if (audioFormat == null) return 0L;
        String mime = audioFormat.containsKey(MediaFormat.KEY_MIME)
                ? audioFormat.getString(MediaFormat.KEY_MIME) : null;
        if (mime == null || !mime.contains("aac")) return 0L;
        long sampleRate = intOrZero(audioFormat, MediaFormat.KEY_SAMPLE_RATE);
        if (sampleRate <= 0) return 0L;
        return 1024L * 1_000_000L / sampleRate;
    }

    /**
     * P1-1：时间轴自检（在写出产物之后、交付之前）。
     *
     * 旧实现这里的"棘轮占比"判据已经删除：那一档误伤的全部来源（B 帧重排被压成 1µs 间距）
     * 现在在拷贝循环里就被分类，直接按 `bframes-not-expressible` 跳过，不再产出待否决的坏件。
     * 留下来的判据全部只看音频轴，且把 discontinuity 的整体偏移扣掉后再比：
     * - 音轨跨度：音频时间跨度显著短于视频（真机坏件 0.60，阈值 0.90）；
     * - 音频粒度：每样本平均跨度远超一帧 AAC（真机坏件 6.9×，阈值 1.5×）。
     *
     * 任一命中都说明这份 MP4 的结构虽然完整、时间轴却不可信：ExoPlayer 会
     * READY + 出首帧然后永不推进（华为视频这类宽容播放器却能播）。此时宁可
     * 交回 .ts 让原生引擎自己解封装，也绝不交付一份"点了没反应"的文件。
     */
    private static String inspectTimeline(CopyStats stats) {
        // discontinuity 偏移是为"接住回绕"整体加上去的，不参与粒度判定
        long audioContentUs = Math.max(0L, stats.audioSpanUs - stats.timeline.boundaryShiftUs);
        if (stats.audioSamples >= VERIFY_MIN_SAMPLES && stats.videoSpanUs > 0
                && stats.audioSpanUs < stats.videoSpanUs * VERIFY_MIN_AUDIO_DURATION_RATIO) {
            return REASON_AUDIO_TIMELINE + ":audioUs=" + stats.audioSpanUs
                    + "/videoUs=" + stats.videoSpanUs;
        }
        long expectedAudioUs = stats.audioFrameUs > 0 ? stats.audioFrameUs * stats.audioSamples : 0L;
        if (expectedAudioUs > 0 && audioContentUs > expectedAudioUs * VERIFY_MAX_AUDIO_SPAN_FACTOR) {
            return REASON_AUDIO_GRANULARITY + ":span=" + audioContentUs
                    + "/expected=" + expectedAudioUs;
        }
        return null;
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

    /** 归因日志用的一行格式摘要：mime + 尺寸/采样率 + 时长，取不到的键留空 */
    private static String describe(MediaFormat format) {
        if (format == null) return "none";
        StringBuilder sb = new StringBuilder();
        sb.append(format.containsKey(MediaFormat.KEY_MIME) ? format.getString(MediaFormat.KEY_MIME) : "?");
        sb.append(' ').append(intOrZero(format, MediaFormat.KEY_WIDTH)).append('x')
                .append(intOrZero(format, MediaFormat.KEY_HEIGHT));
        sb.append(" sr=").append(intOrZero(format, MediaFormat.KEY_SAMPLE_RATE));
        sb.append(" durUs=").append(longOrZero(format, MediaFormat.KEY_DURATION));
        return sb.toString();
    }

    private static long longOrZero(MediaFormat format, String key) {
        try {
            return format != null && format.containsKey(key) ? format.getLong(key) : 0L;
        } catch (RuntimeException ignored) {
            return 0L;
        }
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

    /** 内部中断信号（取消/超时/格式不支持/能力跳过），不对外暴露 */
    private static final class RemuxFailure extends Exception {
        final String code;
        final String reason;
        /** true = 能力形态的跳过（skipped=true、无错误码），false = 失败形态 */
        final boolean skip;

        RemuxFailure(String code, String reason) {
            this(code, reason, false);
        }

        RemuxFailure(String code, String reason, boolean skip) {
            super(code + ": " + reason);
            this.code = code;
            this.reason = reason;
            this.skip = skip;
        }
    }
}
