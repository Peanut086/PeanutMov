package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * P0-1：崩溃处置分级的判定表。
 *
 * 用例全部来自导出日志 peanutmov-logs-20261118-223945（OPPO PJH110 / API 35）里读到的真实组合，
 * 不是凭空构造：EXIT_SELF+同 pid tombstone（11-16 23:54）、status=11 无 tombstone（11-16 13:40、
 * 11-18 19:16/19:27/22:37）、同一 jar 换 api 复发（11-18 19:27→22:37）。
 */
public class CrashResponseTest {

    @Test
    public void nonCrashReadIsExcusedOnlyUntilTombstoneCorroborates() {
        // ROM 把原生 abort 报成 EXIT_SELF：单看读数会被判「不是崩溃」，那个 jar 一次都没被隔离过
        assertFalse(CrashResponse.isCrash(ExitAttribution.NON_CRASH_EXIT, false));
        assertTrue(CrashResponse.isCrash(ExitAttribution.NON_CRASH_EXIT, true));
        assertTrue(CrashResponse.isCrash(ExitAttribution.CRASH, false));
        // 读不出原因时保持「按崩溃处理」的保守口径
        assertTrue(CrashResponse.isCrash(ExitAttribution.UNKNOWN, false));
    }

    @Test
    public void singleSuspiciousSpiderCrashCoolsDownInsteadOfABan() {
        // 11-18 19:16：`found 1 uncleared sentinels` + SIGNALED status=11 + FOREGROUND，
        // 全程没有 tombstone。旧逻辑这里直接隔离 7 天。
        assertEquals(CrashResponse.TIER_COOLDOWN,
                CrashResponse.responseTier(true, false, 1, 0));
    }

    @Test
    public void repeatOfTheSameApiEscalatesToSignatureQuarantine() {
        // 第 4 个参数是「同一个 jar 上【别的】 api 崩过几次」，不是 jar 总数：
        // 按总数传（jar 必然 ≥ 本 api）会让这一档永远升不上去，只会一路顶到 jar 级。
        assertEquals(CrashResponse.TIER_QUARANTINE,
                CrashResponse.responseTier(true, false, 2, 0));
        assertEquals(CrashResponse.TIER_QUARANTINE,
                CrashResponse.responseTier(true, false, 3, 0));
    }

    @Test
    public void sameJarUnderDifferentApiEscalatesToJarQuarantine() {
        // 11-18 19:27 崩 csp_PanWebShare123、22:37 崩 csp_PanWebShare（同一 jarMd5）：
        // api 级各自只有 1 次，只有按 jar 计数才升得了级。
        assertEquals(CrashResponse.TIER_QUARANTINE_JAR,
                CrashResponse.responseTier(true, false, 1, 1));
    }

    @Test
    public void tombstoneProofWinsOverEveryReading() {
        assertEquals(CrashResponse.TIER_QUARANTINE_JAR,
                CrashResponse.responseTier(true, true, 1, 0));
        // 非爬虫现场（exoplayer 哨兵）没有 jar 维度，实锤也只按签名档处置
        assertEquals(CrashResponse.TIER_QUARANTINE,
                CrashResponse.responseTier(false, true, 1, 0));
    }

    @Test
    public void nonSpiderSingleHitIsLeftAlone() {
        // 播放崩溃更可能与具体内容相关：维持原有「24h 内 2 次才处置」
        assertEquals(CrashResponse.TIER_NONE, CrashResponse.responseTier(false, false, 1, 0));
        assertEquals(CrashResponse.TIER_QUARANTINE, CrashResponse.responseTier(false, false, 2, 0));
    }

    @Test
    public void cooldownDurationBreaksTheCrashLoopWithoutBeingAWeekLongBan() {
        // 冷却要长到打断「每次冷启都撞一次」，又要比 7 天隔离轻一个量级
        assertEquals(30 * 60 * 1000L, CrashResponse.SPIDER_COOLDOWN_MS);
        assertTrue(CrashResponse.SPIDER_COOLDOWN_MS < 24 * 60 * 60 * 1000L);
    }

    @Test
    public void threadClassComparisonIsNumericSuffixInsensitive() {
        assertTrue(CrashResponse.sameCrashThread("spider-worker", "spider-worker-3"));
        assertTrue(CrashResponse.sameCrashThread(" Spider-Worker-2 ", "spider-worker"));
        // jar 的 worker 线程与 drpy 的 python 线程不是一回事
        assertFalse(CrashResponse.sameCrashThread("spider-worker", "spider-python-lo"));
        // 读不到线程名时判不匹配：后果只是不升级处置，比误禁一批源轻
        assertFalse(CrashResponse.sameCrashThread("", "spider-worker"));
        assertFalse(CrashResponse.sameCrashThread(null, null));
    }

    @Test
    public void tierNamesAreForLogsOnly() {
        assertEquals("cooldown", CrashResponse.tierName(CrashResponse.TIER_COOLDOWN));
        assertEquals("quarantine", CrashResponse.tierName(CrashResponse.TIER_QUARANTINE));
        assertEquals("quarantine-jar", CrashResponse.tierName(CrashResponse.TIER_QUARANTINE_JAR));
        assertEquals("none", CrashResponse.tierName(CrashResponse.TIER_NONE));
    }
}
