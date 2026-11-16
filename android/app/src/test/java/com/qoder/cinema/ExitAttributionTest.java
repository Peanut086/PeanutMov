package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 退出归因判定表单测（G1 / G2）。
 *
 * 每个用例都对应一条真机实测或 Android 文档定义，改判定表时必须同步改这里：
 * 判错一个 reason 的代价是把好源永久隔离（华为 Mate 50 Pro 曾连续误隔离 2 个源），
 * 或反过来把真崩溃当成系统清理放过。
 */
public class ExitAttributionTest {

    // Android ApplicationExitInfo 的 reason 取值（此处用字面量，避免依赖 android.jar 常量）
    private static final int REASON_UNKNOWN = 0;
    private static final int REASON_EXIT_SELF = 1;
    private static final int REASON_SIGNALED = 2;
    private static final int REASON_LOW_MEMORY = 3;
    private static final int REASON_CRASH = 4;
    private static final int REASON_CRASH_NATIVE = 5;
    private static final int REASON_ANR = 6;
    private static final int REASON_INITIALIZATION_FAILURE = 7;
    private static final int REASON_PERMISSION_CHANGE = 8;
    private static final int REASON_EXCESSIVE_RESOURCE_USAGE = 9;
    private static final int REASON_USER_REQUESTED = 10;
    private static final int REASON_USER_STOPPED = 11;
    private static final int REASON_DEPENDENCY_DIED = 12;
    private static final int REASON_OTHER = 13;
    private static final int REASON_FREEZER = 14;
    private static final int REASON_PACKAGE_STATE_CHANGE = 15;
    private static final int REASON_PACKAGE_UPDATED = 16;

    private static final String IWARE_STOP =
            "stop com.qoder.cinema due to from pid 2950 iAwareF[SystemManager] 265ms";
    private static final String IWARE_LOW_MEM =
            "stop com.qoder.cinema due to from pid 2950 iAwareF[AK-LowMem-L2](service) 340815ms";

    @Test
    public void javaAndNativeCrashAreCrashes() {
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_CRASH, 0, "java exception"));
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_CRASH_NATIVE, 0, "sigsegv"));
    }

    /** 华为真机实测：2026-11-16 15:13:19 的"闪退"就是这一条（reason=10 status=0 importance=400） */
    @Test
    public void managerForceStopIsNotACrash() {
        assertEquals(ExitAttribution.NON_CRASH_EXIT,
                ExitAttribution.classify(REASON_USER_REQUESTED, 0, IWARE_STOP));
    }

    /** 华为 iAware 低内存杀进程在 exit-info 里是 SIGKILL(9)，不是 SIGSEGV/SIGABRT */
    @Test
    public void sigkillFromLowMemKeeperIsNotACrash() {
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_SIGNALED, 9, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_SIGNALED, 15, IWARE_LOW_MEM));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_SIGNALED, 3, "SIGQUIT"));
    }

    @Test
    public void crashSignalsAreCrashes() {
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_SIGNALED, 11, "SIGSEGV"));
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_SIGNALED, 6, "SIGABRT"));
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_SIGNALED, 4, "SIGILL"));
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_SIGNALED, 7, "SIGBUS"));
        assertEquals(ExitAttribution.CRASH, ExitAttribution.classify(REASON_SIGNALED, 8, "SIGFPE"));
    }

    @Test
    public void lowMemAnrAndUserStoppedAreNotCrashes() {
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_LOW_MEMORY, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_ANR, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_USER_STOPPED, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_EXIT_SELF, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_OTHER, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_DEPENDENCY_DIED, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT,
                ExitAttribution.classify(REASON_EXCESSIVE_RESOURCE_USAGE, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_PACKAGE_UPDATED, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_FREEZER, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT,
                ExitAttribution.classify(REASON_INITIALIZATION_FAILURE, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT,
                ExitAttribution.classify(REASON_PERMISSION_CHANGE, 0, null));
        assertEquals(ExitAttribution.NON_CRASH_EXIT,
                ExitAttribution.classify(REASON_PACKAGE_STATE_CHANGE, 0, null));
    }

    /** reason 缺省时只能靠 description 认人：认出管家/低内存字样按被杀处理 */
    @Test
    public void unknownReasonUsesDescriptionHints() {
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_UNKNOWN, 0, IWARE_STOP));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_UNKNOWN, 0, "killed by lmkd"));
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(REASON_UNKNOWN, 0, "force-stop for mem"));
        assertEquals(ExitAttribution.UNKNOWN, ExitAttribution.classify(REASON_UNKNOWN, 0, null));
        assertEquals(ExitAttribution.UNKNOWN, ExitAttribution.classify(REASON_UNKNOWN, 0, ""));
    }

    /** 崩溃是白名单：只有 reason=4/5 和崩溃信号算崩溃，表外的 reason 一律不往代码身上算 */
    @Test
    public void unrecognizedReasonIsNotACrash() {
        assertEquals(ExitAttribution.NON_CRASH_EXIT, ExitAttribution.classify(999, 0, null));
    }

    @Test
    public void crashSignalTable() {
        assertTrue(ExitAttribution.isCrashSignal(6));
        assertTrue(ExitAttribution.isCrashSignal(11));
        assertTrue(ExitAttribution.isCrashSignal(31));
        assertFalse(ExitAttribution.isCrashSignal(9));
        assertFalse(ExitAttribution.isCrashSignal(15));
        assertFalse(ExitAttribution.isCrashSignal(0));
    }

    @Test
    public void hintMatchingIsCaseInsensitive() {
        assertTrue(ExitAttribution.looksLikeSystemKill("IAWAREF[SystemManager]"));
        assertTrue(ExitAttribution.looksLikeSystemKill("state=EMPTY"));
        assertFalse(ExitAttribution.looksLikeSystemKill("java.lang.NullPointerException"));
        assertFalse(ExitAttribution.looksLikeSystemKill(null));
    }

    @Test
    public void namesAreReadable() {
        assertEquals("USER_REQUESTED", ExitAttribution.reasonName(REASON_USER_REQUESTED));
        assertEquals("CRASH_NATIVE", ExitAttribution.reasonName(REASON_CRASH_NATIVE));
        assertEquals("REASON_99", ExitAttribution.reasonName(99));
        assertEquals("CACHED", ExitAttribution.importanceName(400));
        assertEquals("FOREGROUND", ExitAttribution.importanceName(100));
        assertEquals("IMPORTANCE_999", ExitAttribution.importanceName(999));
        assertEquals("non-crash exit", ExitAttribution.kindName(ExitAttribution.NON_CRASH_EXIT));
        assertEquals("crash", ExitAttribution.kindName(ExitAttribution.CRASH));
        assertEquals("unknown", ExitAttribution.kindName(ExitAttribution.UNKNOWN));
    }
}
