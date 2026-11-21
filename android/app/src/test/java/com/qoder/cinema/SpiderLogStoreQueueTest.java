package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

/**
 * 队列溢出时丢哪一行（P1-5）。
 *
 * <p>要钉住的是取舍方向，不是实现细节：旧实现 {@code queue.poll()} 直接丢队首，于是
 * 一轮批量预热把 2048 格缓冲灌满时，最先被挤出去的恰好是最前面那批崩溃归因、隔离判定、
 * 交付改指——真机 63200 行里 {@code CatVodSpider} 与 {@code JS} 两个 tag 占 47553 行（75%），
 * 它们全在队首排队等死。现在只允许丢「调试/信息级的爬虫内部与 JS 转发行」。
 */
public class SpiderLogStoreQueueTest {

    /** 行格式与 SpiderLogStore.formatLine 一致：23 字符时间戳 + 空格 + 等级 + [线程] + tag */
    private static String line(char level, String tag, String text) {
        return "2026-11-20 09:00:00.000 " + level + " [spider-worker] " + tag + ": " + text;
    }

    @Test
    public void onlyDebugAndInfoSpiderOrJsLinesCountAsNoisy() {
        assertTrue(SpiderLogStore.isNoisyLine(line('D', "CatVodSpider", "raw response header")));
        assertTrue(SpiderLogStore.isNoisyLine(line('I', "JS", "上游提示登记 requestId=n-1")));
        assertFalse("W/E/F 级无论谁写的都算关键",
                SpiderLogStore.isNoisyLine(line('W', "JS", "交付改指失败")));
        assertFalse("爬虫的错误不能当噪音",
                SpiderLogStore.isNoisyLine(line('E', "CatVodSpider", "spider crashed")));
        assertFalse("播放器行不在噪音名单里",
                SpiderLogStore.isNoisyLine(line('D', "ExoPlayerPlugin", "timeline ratchet")));
        assertFalse("认不出的形态一律按关键行保住", SpiderLogStore.isNoisyLine("garbage"));
        assertFalse(SpiderLogStore.isNoisyLine(null));
    }

    @Test
    public void overflowDropsTheOldestNoisyLineAndKeepsEveryKeyLine() {
        List<String> queue = new ArrayList<>(Arrays.asList(
                line('D', "CatVodSpider", "预热 1/40"),
                line('W', "CrashExit", "崩溃归因=jar 级隔离"),
                line('D', "CatVodSpider", "预热 2/40"),
                line('E', "SpiderPlugin", "MP4 复检不过")));
        assertEquals("先丢最旧的那条爬虫内部行，而不是队首之后的崩溃行",
                0, SpiderLogStore.pickVictimIndex(queue));
        queue.remove(0);
        assertEquals("崩溃行顶上来的位置不再是噪音，继续往后找到那条预热行",
                1, SpiderLogStore.pickVictimIndex(queue));
    }

    @Test
    public void whenNothingIsNoisyTheOldestLineIsStillSacrificed() {
        // 全队都是关键行时没有更好的选择：保持旧行为丢队首，但计数会记成 key 丢弃，导出头部看得见
        List<String> queue = Arrays.asList(
                line('W', "CrashExit", "上一轮归因"),
                line('E', "MediaTool", "verify failed"));
        assertEquals(0, SpiderLogStore.pickVictimIndex(queue));
    }
}
