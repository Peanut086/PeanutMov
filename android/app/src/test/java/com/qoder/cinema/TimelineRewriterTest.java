package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * P1-1：时间轴重写纯计算单测。
 *
 * 场景形态取自真机：一条 1080p B 帧电影（25fps、解码序 PTS 回退 40–120ms，旧实现棘轮
 * 121,787/246,820 次）与一条 988 分片、跨分片 PTS 重置/回绕的拼接流。三类输入
 * （单调、B 帧、真 discontinuity）的处置必须各自锁死：单调照写、B 帧报不支持、
 * 重置补**两轨共用**的偏移且不改变音画相对差。
 */
public class TimelineRewriterTest {

    private final long[] out = new long[1];

    @Test
    public void monotonicStreamNormalizesBySharedOrigin() {
        TimelineRewriter t = new TimelineRewriter();
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 10_000_000L, out));
        assertEquals(0L, out[0]);
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 10_040_000L, out));
        assertEquals(40_000L, out[0]);
        assertEquals(TimelineRewriter.OK, t.rewrite(false, 10_020_000L, out));
        assertEquals(20_000L, out[0]);
        assertEquals(0L, t.boundaryShifts);
        assertEquals("视频原点比音频首样晚 20ms → 差值取原点减首样", -20_000L, t.avOriginGapUs());
    }

    @Test
    public void bFrameReorderIsFlaggedInsteadOfFlattened() {
        // IBBBP 之类 GOP：解码序里 P 帧 pts 先到 120ms，B 帧回退 80ms——这是正常形态
        TimelineRewriter t = new TimelineRewriter();
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 0L, out));
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 120_000L, out));
        assertEquals(TimelineRewriter.BFRAME_REORDER, t.rewrite(true, 40_000L, out));
        assertEquals("回退深度按候选值报出，供 reason 字符串", 40_000L, out[0]);
        assertEquals(80_000L, t.maxVideoReorderUs);
        assertEquals("B 帧不得产生任何整体偏移", 0L, t.boundaryShifts);
        // 报出后调用方即停手；这里继续喂下一样本验证状态没有被悄悄涂改
        assertEquals(TimelineRewriter.BFRAME_REORDER, t.rewrite(true, 80_000L, out));
        assertEquals(120_000L, t.lastVideoUs());
    }

    @Test
    public void realDiscontinuityShiftsBothTracksOnCommonBase() {
        TimelineRewriter t = new TimelineRewriter();
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 4_000_000L, out)); // 原点
        assertEquals(0L, out[0]);
        assertEquals(TimelineRewriter.OK, t.rewrite(false, 4_020_000L, out));
        assertEquals(20_000L, out[0]);
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 4_040_000L, out));
        assertEquals(40_000L, out[0]);

        // 分片边界：PTS 回绕，下一片段从 2s 处重来（回退 2s，远超窗口）
        assertEquals(TimelineRewriter.BOUNDARY_SHIFT, t.rewrite(true, 2_000_000L, out));
        assertEquals(40_001L, out[0]);
        assertEquals(1L, t.boundaryShifts);

        // 音频走到同一边界：候选值已含共用偏移，不应再触发第二次回退补偿
        assertEquals(TimelineRewriter.OK, t.rewrite(false, 2_020_000L, out));
        assertEquals(60_001L, out[0]);
        assertEquals("共用偏移下音画差保持 20ms 不变", 20_000L, out[0] - 40_001L);
        assertEquals(1L, t.boundaryShifts);

        assertEquals(2_040_001L, t.boundaryShiftUs);
    }

    @Test
    public void firstSampleBelowOriginClampsToZeroWithoutShift() {
        // 视频首关键帧先立原点，音频起点比它早一帧（30ms）：钳 0，不推动整条时间轴
        TimelineRewriter t = new TimelineRewriter();
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 1_000_000L, out));
        assertEquals(0L, out[0]);
        assertEquals(TimelineRewriter.OK, t.rewrite(false, 970_000L, out));
        assertEquals(0L, out[0]);
        assertEquals(0L, t.boundaryShifts);
        assertEquals(30_000L, t.avOriginGapUs());
    }

    @Test
    public void audioRegressionAlwaysCountsAsBoundaryNotReorder() {
        // AAC 没有 B 帧：音频侧的回退按真 discontinuity/重复时间戳处理，绝不静默丢弃
        TimelineRewriter t = new TimelineRewriter();
        assertEquals(TimelineRewriter.OK, t.rewrite(true, 0L, out));
        assertEquals(TimelineRewriter.OK, t.rewrite(false, 100_000L, out));
        assertEquals(100_000L, out[0]);
        assertEquals(TimelineRewriter.BOUNDARY_SHIFT, t.rewrite(false, 100_000L, out));
        assertEquals(100_001L, out[0]);
        assertNotEquals(TimelineRewriter.BFRAME_REORDER, t.rewrite(false, 90_000L, new long[1]));
        assertEquals("两次音频回退都记成边界", 2L, t.boundaryShifts);
    }

    @Test
    public void windowBoundarySeparatesReorderFromReset() {
        TimelineRewriter t = new TimelineRewriter();
        long origin = TimelineRewriter.PTS_REORDER_WINDOW_US + 500_000L;
        assertEquals(TimelineRewriter.OK, t.rewrite(true, origin, out));
        // 回退恰好等于窗口：按 B 帧（保守侧——最多放弃一次转封装，不会压坏时间轴）
        assertEquals(TimelineRewriter.BFRAME_REORDER, t.rewrite(true, origin - TimelineRewriter.PTS_REORDER_WINDOW_US, out));
        // 超出窗口 1µs：按真 discontinuity 补偏移
        assertEquals(TimelineRewriter.BOUNDARY_SHIFT, t.rewrite(true, origin - TimelineRewriter.PTS_REORDER_WINDOW_US - 1L, out));
        assertTrue(t.boundaryShiftUs > TimelineRewriter.PTS_REORDER_WINDOW_US);
    }

    @Test
    public void rawPtsAndSpansAreTrackedForForensics() {
        TimelineRewriter t = new TimelineRewriter();
        t.rewrite(true, 90_000_000L, out);
        t.rewrite(true, 90_040_000L, out);
        t.rewrite(false, 90_020_000L, out);
        assertEquals(90_000_000L, t.videoFirstPtsUs);
        assertEquals(90_040_000L, t.videoLastPtsUs);
        assertEquals(90_020_000L, t.audioFirstPtsUs);
        assertEquals("processedUs 是归一到共同原点后的写入口径（µs）", 40_000L, t.processedUs());
        assertEquals(90_040_000L - 90_000_000L, t.lastVideoUs());
    }
}
