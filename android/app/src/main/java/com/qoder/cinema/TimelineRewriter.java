package com.qoder.cinema;

/**
 * P1-1：时间轴重写的纯计算（不依赖 Android 框架，可直接 JVM 单测）。
 *
 * 三个量全部统一到 µs：MediaExtractor 解封装时已把容器 timescale 归一成 µs
 * （`getSampleTime()` 与 `KEY_DURATION` 同一单位），所以这里不存在再乘 timescale 的换算，
 * 也不与 MP4 内部标度混用——写进 muxer 的每个数字都是 µs。
 *
 * 两类「PTS 回退」含义完全不同，必须分开处置（旧实现在同一支棘轮里把它们混为一谈，
 * 这正是真机 B 帧流产物「时间轴损坏、ExoPlayer READY 后永不推进」的成因）：
 *
 * 1. **小回退（≤ {@link #PTS_REORDER_WINDOW_US}）出现在视频轨 = B 帧重排。**
 *    MediaExtractor 按解码序吐样本，含 B 帧的比特流里解码序的 PTS 天然不单调——这不是故障。
 *    但 MediaMuxer 唯一的时间输入是严格递增的 presentationTimeUs，没有任何通道表达
 *    「解码序 + 合成偏移（ctts）」：把回退压平等于把解码序画成呈现序，整段帧距被涂改。
 *    平台 API 无法可靠表达这种流的时序时，诚实的处置是报告「能力不支持」，保留可播输入。
 * 2. **大回退（&gt; 窗口）= 分片边界的真 discontinuity / 33bit 回绕。**
 *    按回退幅度整体前移，并记成**两条轨共用的偏移量**：音视频减同一个原点、加同一个偏移，
 *    相对关系全程不被单独涂改；另一条轨随后走到同一边界时，它的候选值已经含着这次
 *    偏移，不会再各自补一次把音画差拉大。
 *
 * 单调递增的样本直接照写；某条轨的首个写入样本若低于共同原点（流头音画起点差一帧），
 * 钳到 0 而不产生偏移——首帧前的量差不该推动整条时间轴。
 *
 * @author xyp
 */
final class TimelineRewriter {

    /**
     * B 帧重排与真 discontinuity 的判别窗口（µs）。
     *
     * 依据：正常 GOP 的重排深度 ≤ 几个帧距（25fps 下 &lt;200ms），40 帧深度的病态 GOP 也到不了
     * 1 秒；分片重置/回绕至少是秒级。取 1 秒，误判只会落在保守侧——把真 discontinuity 说成
     * B 帧是放弃转封装保留 .ts，反过来（把 B 帧当边界压平）才会造出坏件。
     * 该窗口值的正式校准需要按 P1-1 验收做 ffprobe `-show_packets` 样本差分，未经实测不再改动。
     */
    static final long PTS_REORDER_WINDOW_US = 1_000_000L;

    /** 一次重写的三态结果 */
    static final int OK = 0;
    static final int BFRAME_REORDER = 1;
    static final int BOUNDARY_SHIFT = 2;

    /** 共同 PTS 原点（µs）：两轨首个写入样本里最早的那个 */
    private long firstPtsUs = Long.MIN_VALUE;
    /** 两轨共用的累计偏移（µs）：只在真 discontinuity 上增长 */
    private long shiftUs = 0L;
    private long lastVideoUs = -1L;
    private long lastAudioUs = -1L;

    /** 真 discontinuity 次数与累计前移量（µs） */
    long boundaryShifts;
    long boundaryShiftUs;
    /** 观测到的视频小回退最大幅度（B 帧深度证据，µs） */
    long maxVideoReorderUs;
    /** 各轨原始 PTS 首末读数（µs，未重写口径，供与 ffprobe 对照） */
    long videoFirstPtsUs = -1L;
    long videoLastPtsUs = -1L;
    long audioFirstPtsUs = -1L;
    long audioLastPtsUs = -1L;

    /**
     * 重写一个样本的呈现时间。
     *
     * @param isVideo   true = 视频轨
     * @param ptsUs     样本原始 PTS（µs，调用方已把负值归 0）
     * @param candidateOut 长度 1 的出参：OK/BOUNDARY_SHIFT 时为应写入 muxer 的时间（µs）；
     *                     BFRAME_REORDER 时为回退到的候选值本身（供日志）
     * @return {@link #OK} / {@link #BFRAME_REORDER} / {@link #BOUNDARY_SHIFT}
     */
    int rewrite(boolean isVideo, long ptsUs, long[] candidateOut) {
        if (isVideo) {
            if (videoFirstPtsUs < 0) videoFirstPtsUs = ptsUs;
            videoLastPtsUs = ptsUs;
        } else {
            if (audioFirstPtsUs < 0) audioFirstPtsUs = ptsUs;
            audioLastPtsUs = ptsUs;
        }
        if (firstPtsUs == Long.MIN_VALUE) firstPtsUs = ptsUs;

        long candidate = ptsUs - firstPtsUs + shiftUs;
        long lastWritten = isVideo ? lastVideoUs : lastAudioUs;
        int verdict = OK;
        if (lastWritten < 0) {
            // 该轨首个写入样本：低于共同原点就钳到 0，不产生全轴偏移
            candidate = Math.max(candidate, 0L);
        } else if (candidate <= lastWritten) {
            long regression = lastWritten - candidate;
            if (isVideo && regression <= PTS_REORDER_WINDOW_US) {
                maxVideoReorderUs = Math.max(maxVideoReorderUs, regression);
                candidateOut[0] = candidate;
                return BFRAME_REORDER;
            }
            long delta = regression + 1;
            shiftUs += delta;
            boundaryShifts += 1;
            boundaryShiftUs += delta;
            candidate = lastWritten + 1;
            verdict = BOUNDARY_SHIFT;
        }
        if (isVideo) lastVideoUs = candidate;
        else lastAudioUs = candidate;
        candidateOut[0] = candidate;
        return verdict;
    }

    /** 已写出的最大样本时间（µs）：进度与产物时长都按它计 */
    long processedUs() {
        return Math.max(lastVideoUs, lastAudioUs);
    }

    long lastVideoUs() {
        return lastVideoUs;
    }

    long lastAudioUs() {
        return lastAudioUs;
    }

    /** 音画起点差（µs，原始 PTS 口径，视频首样 − 音频首样）：为正表示音频比视频先出现 */
    long avOriginGapUs() {
        if (videoFirstPtsUs < 0 || audioFirstPtsUs < 0) return 0L;
        return videoFirstPtsUs - audioFirstPtsUs;
    }
}
