package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * 崩溃签名单测（F2' / G2）。
 *
 * 签名决定了熔断会不会触发，判错方向的代价不对称：
 * 严格签名漏判 = 同一个原生崩溃反复发生却永不降级预热；
 * 宽松签名过敏 = 预热被串行化 24h（慢，但任何源都不受影响）。
 * 因此两路都必须能用纯字符串用例钉死，不依赖 xcrash 解析。
 */
public class CrashSignatureTest {

    /** 真实现场形态：前几帧恒是 ART 跳板，第三方库在更深处 */
    private static final String BT_ART_THEN_THIRD_PARTY = String.join("\n",
            "    #00 pc 0000000000085bbc  /apex/com.android.runtime/lib64/bionic/libc.so (abort+164)",
            "    #01 pc 00000000002a1234  /apex/com.android.art/lib64/libart.so (art::CheckReferenceResult+8)",
            "    #02 pc 00000000002b5678  /apex/com.android.art/lib64/libart.so (artQuickGenericJniEndTrampoline+24)",
            "    #03 pc 0000000000011223  /data/data/com.qoder.cinema/files/spiders/libjiagu.so (Java_com_dodola_mirror_url_Init_init+320)");

    /** 只有运行时帧：真凶库拿不到（本次两份日志的 top-15 就是这个形态） */
    private static final String BT_RUNTIME_ONLY = String.join("\n",
            "    #00 pc 00000000002a1234  /apex/com.android.art/lib64/libart.so (art::CheckReferenceResult+8)",
            "    #01 pc 00000000002b5678  /apex/com.android.art/lib64/libart.so (artQuickGenericJniEndTrampoline+24)",
            "    #02 pc 00000000000c99aa  /system/lib64/libnativehelper.so (_ZN7JNI_GetCreatedJavaVMsEP7JavaVMiPS_+4)");

    @Test
    public void strictSignatureUsesFaultAddrPlusFirstSoFrame() {
        assertEquals("0x7461642f|libc.so",
                CrashNative.strictSignature("0x7461642f", BT_ART_THEN_THIRD_PARTY));
    }

    @Test
    public void looseSignatureSkipsRuntimeFramesToReachCulpritLib() {
        assertEquals("11(sigsegv)|1(segv_maperr)|libjiagu.so|spider-worker",
                CrashNative.looseSignature("11 (SIGSEGV)", "1 (SEGV_MAPERR)",
                        BT_ART_THEN_THIRD_PARTY, "spider-worker"));
    }

    /** G2 的立论本身：fault addr 漂移时严格签名互不相同，宽松签名必须相同 */
    @Test
    public void looseSignatureSurvivesFaultAddrDrift() {
        String strictA = CrashNative.strictSignature("0x7461642f", BT_RUNTIME_ONLY);
        String strictB = CrashNative.strictSignature("0xdeadbeef", BT_RUNTIME_ONLY);
        assertNotEquals(strictA, strictB);

        String looseA = CrashNative.looseSignature("11 (SIGSEGV)", "1 (SEGV_MAPERR)", BT_RUNTIME_ONLY, "spider-worker-3");
        String looseB = CrashNative.looseSignature("11 (SIGSEGV)", "1 (SEGV_MAPERR)", BT_RUNTIME_ONLY, "spider-worker-9");
        assertEquals(looseA, looseB);
        assertEquals("11(sigsegv)|1(segv_maperr)|nolib|spider-worker", looseA);
    }

    /** 线程名带编号（worker 池）不能把同一根因拆成多个签名 */
    @Test
    public void threadIndexIsNormalizedAway() {
        assertEquals(
                CrashNative.looseSignature("11 (SIGSEGV)", "1", BT_ART_THEN_THIRD_PARTY, "pool-2-thread_11"),
                CrashNative.looseSignature("11 (SIGSEGV)", "1", BT_ART_THEN_THIRD_PARTY, "pool-2-thread_12"));
    }

    @Test
    public void emptyBacktraceYieldsNoSignature() {
        assertNull(CrashNative.strictSignature("0x0", ""));
        assertNull(CrashNative.looseSignature("11 (SIGSEGV)", "1", "   ", "main"));
    }

    @Test
    public void missingThreadNameFallsBackToUnknown() {
        assertEquals("6(sigabrt)|6|libjiagu.so|unknown",
                CrashNative.looseSignature("6 (SIGABRT)", "6", BT_ART_THEN_THIRD_PARTY, null));
    }
}
