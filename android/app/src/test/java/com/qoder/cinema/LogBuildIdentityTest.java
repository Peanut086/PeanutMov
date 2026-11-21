package com.qoder.cinema;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;

import org.junit.Test;

/**
 * 导出包的构建标识头（P1-5）。
 *
 * <p>此前两份真机日志的第一行都是 {@code ===== spider-2026-11-16.log =====}：拿到日志的人
 * 不知道这是哪个版本、哪台机器、哪一份 jar 跑出来的，也无法判断某个修复究竟进没进这轮包
 * ——同一个 jar 的文件名不变，行内容就一模一样，只有版本号能把两轮区分开。
 *
 * <p>只测 {@link LogBuildIdentity#format}（纯格式化），Context 相关部分留给真机导出核验。
 */
public class LogBuildIdentityTest {

    private static LogBuildIdentity.Info sample() {
        LogBuildIdentity.Info i = new LogBuildIdentity.Info();
        i.scope = "all";
        i.exportedAt = "2026-11-20 15:30:00";
        i.pid = 4321;
        i.packageId = "com.qoder.cinema";
        i.versionName = "0.1.0";
        i.versionCode = "100";
        i.debug = true;
        i.model = "DCO-AL00";
        i.manufacturer = "HUAWEI";
        i.hardware = "kirin9000";
        i.release = "12";
        i.sdk = 31;
        i.jars = Arrays.asList("6407140d2845839980771d49913bdcdc.jar size=2345678");
        i.droppedNoisy = 12;
        i.droppedKey = 0;
        return i;
    }

    @Test
    public void headerCarriesPidVersionDeviceAndJarFingerprint() {
        String out = LogBuildIdentity.format(sample());
        assertTrue("PID：崩溃行与日志行要靠它串起来", out.contains("pid=4321"));
        assertTrue(out.contains("versionName=0.1.0"));
        assertTrue(out.contains("versionCode=100"));
        assertTrue(out.contains("buildType=debug"));
        assertTrue(out.contains("HUAWEI/DCO-AL00"));
        assertTrue(out.contains("sdk=31"));
        assertTrue("构件指纹＝jar 文件名（md5 of URL），与 CrashExit 行的 jarHash 对得上",
                out.contains("6407140d2845839980771d49913bdcdc.jar"));
        assertTrue(out.contains("scope=all"));
    }

    @Test
    public void releaseBuildIsToldApartFromDebugBuild() {
        LogBuildIdentity.Info i = sample();
        i.debug = false;
        assertTrue(LogBuildIdentity.format(i).contains("buildType=release"));
    }

    @Test
    public void noJarMeansSaysSoInsteadOfSilence() {
        LogBuildIdentity.Info i = sample();
        i.jars = java.util.Collections.emptyList();
        assertTrue(LogBuildIdentity.format(i).contains("无"));
    }

    @Test
    public void queueDropsAreStatedAndKeyLossIsCalledOut() {
        String out = LogBuildIdentity.format(sample());
        assertTrue(out.contains("noisy=12"));
        assertTrue("key=0 也要写出来——『没丢过』本身是结论", out.contains("key=0"));
        assertTrue(out.contains("关键行也被挤掉过"));
    }

    @Test
    public void headerNeverCarriesJarMtime() {
        // 华为真机上 stat 的 mtime 不可信（此前排查实测），写进去只会把归因带偏
        LogBuildIdentity.Info i = sample();
        i.jars = Arrays.asList("a.jar size=1", "b.jar size=2");
        String out = LogBuildIdentity.format(i);
        assertFalse(out.contains("mtime"));
    }
}
