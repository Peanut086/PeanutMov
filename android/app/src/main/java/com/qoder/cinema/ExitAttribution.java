package com.qoder.cinema;

import android.app.ApplicationExitInfo;

/**
 * 进程上次退出方式的归因判定（G1 / G2）。
 *
 * 崩溃哨兵只能证明「进程死亡时某操作在途」，证明不了「该操作导致了死亡」。国产 ROM 的
 * 后台清理与低内存杀进程同样会留下未清除的哨兵——华为真机实证：某次会话 8 条主进程退出
 * 记录里 0 条真崩溃（5 条 `iAwareF[SystemManager]` force-stop + 3 条 `AK-LowMem`
 * SIGKILL），但连续两次把在途的爬虫源当崩溃源给隔离掉了。所以隔离前必须先分清
 * 「崩了」和「被杀了」。
 *
 * 本类只做纯计算：入参是 int/String，判定表可以在 JVM 单测里跑全（见 ExitAttributionTest）。
 */
public final class ExitAttribution {

    /** 崩溃（Java / native / 崩溃信号）——可以归因到在途高危操作 */
    public static final int CRASH = 1;
    /**
     * 非崩溃退出：被系统或用户强杀、低内存、ANR、资源超限、应用自己退出。
     * 这一类不得用于隔离爬虫或累加崩溃计数。
     */
    public static final int NON_CRASH_EXIT = 2;
    /** 无从判定（系统没给原因，描述里也读不出是谁杀的）——调用方按崩溃保守处理 */
    public static final int UNKNOWN = 0;

    /**
     * reason=UNKNOWN 时 description 是唯一线索。真机见过的系统清理描述形如
     * `iAwareF[AK-LowMem-L2](service) 340815ms`、`stop com.qoder.cinema due to from pid 2950 …`。
     */
    private static final String[] SYSTEM_KILL_HINTS = {
            "iaware", "lmkd", "lowmem", "force stop", "force-stop", "isolate", "cached", "empty",
    };

    private ExitAttribution() {}

    /**
     * 判定一次退出属于崩溃 / 非崩溃 / 未知。
     *
     * @param reason      {@link ApplicationExitInfo#getReason()}
     * @param status      {@link ApplicationExitInfo#getStatus()}，仅 REASON_SIGNALED 时有意义
     * @param description {@link ApplicationExitInfo#getDescription()}，可为 null
     */
    public static int classify(int reason, int status, String description) {
        switch (reason) {
            case ApplicationExitInfo.REASON_CRASH:
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return CRASH;
            case ApplicationExitInfo.REASON_SIGNALED:
                // 被杀与崩在信号上分得开：SIGKILL(9)/SIGTERM(15) 是外部终止，
                // SIGSEGV(11)/SIGABRT(6) 才是进程自己倒下。
                return isCrashSignal(status) ? CRASH : NON_CRASH_EXIT;
            case ApplicationExitInfo.REASON_UNKNOWN:
                return looksLikeSystemKill(description) ? NON_CRASH_EXIT : UNKNOWN;
            default:
                // EXIT_SELF / LOW_MEMORY / ANR / EXCESSIVE_RESOURCE_USAGE / USER_REQUESTED /
                // USER_STOPPED / DEPENDENCY_DIED / OTHER / FREEZER / PACKAGE_STATE_CHANGE /
                // PACKAGE_UPDATED … 全都不是「代码把进程搞崩了」。
                return NON_CRASH_EXIT;
        }
    }

    /** bionic/Linux 信号号里属于「进程内部崩溃」的那一组 */
    public static boolean isCrashSignal(int signal) {
        switch (signal) {
            case 4:  // SIGILL
            case 5:  // SIGTRAP
            case 6:  // SIGABRT
            case 7:  // SIGBUS
            case 8:  // SIGFPE
            case 11: // SIGSEGV
            case 16: // SIGSTKFLT
            case 24: // SIGXCPU
            case 25: // SIGXFSZ
            case 31: // SIGSYS
                return true;
            default:
                return false;
        }
    }

    static boolean looksLikeSystemKill(String description) {
        if (description == null) return false;
        String lower = description.toLowerCase();
        for (String hint : SYSTEM_KILL_HINTS) {
            if (lower.contains(hint)) return true;
        }
        return false;
    }

    public static String kindName(int kind) {
        switch (kind) {
            case CRASH:
                return "crash";
            case NON_CRASH_EXIT:
                return "non-crash exit";
            default:
                return "unknown";
        }
    }

    /** 给日志用的原因名（reason 只有数字时，日志页读不出含义） */
    public static String reasonName(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_UNKNOWN:
                return "UNKNOWN";
            case ApplicationExitInfo.REASON_EXIT_SELF:
                return "EXIT_SELF";
            case ApplicationExitInfo.REASON_SIGNALED:
                return "SIGNALED";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "LOW_MEMORY";
            case ApplicationExitInfo.REASON_CRASH:
                return "CRASH";
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "CRASH_NATIVE";
            case ApplicationExitInfo.REASON_ANR:
                return "ANR";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:
                return "INITIALIZATION_FAILURE";
            case ApplicationExitInfo.REASON_PERMISSION_CHANGE:
                return "PERMISSION_CHANGE";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return "EXCESSIVE_RESOURCE_USAGE";
            case ApplicationExitInfo.REASON_USER_REQUESTED:
                return "USER_REQUESTED";
            case ApplicationExitInfo.REASON_USER_STOPPED:
                return "USER_STOPPED";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED:
                return "DEPENDENCY_DIED";
            case ApplicationExitInfo.REASON_OTHER:
                return "OTHER";
            case ApplicationExitInfo.REASON_FREEZER:
                return "FREEZER";
            case ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE:
                return "PACKAGE_STATE_CHANGE";
            case ApplicationExitInfo.REASON_PACKAGE_UPDATED:
                return "PACKAGE_UPDATED";
            default:
                return "REASON_" + reason;
        }
    }

    /**
     * 进程被杀当时的重要性档位（{@code ActivityManager.RunningAppProcessInfo.importance}）。
     * 400=CACHED 意味着「已经不在前台了才被清」，是区分「用着用着崩了」和「切后台被清」的关键字段。
     */
    public static String importanceName(int importance) {
        switch (importance) {
            case 100:
                return "FOREGROUND";
            case 125:
                return "FOREGROUND_SERVICE";
            case 200:
                return "VISIBLE";
            case 210:
                return "PERCEPTIBLE_LOW";
            case 220:
                return "TRANSIENT";
            case 230:
                return "PERCEPTIBLE";
            case 300:
                return "SERVICE";
            case 400:
                return "CACHED";
            case 500:
                return "GONE";
            case 1000:
                return "NONEXISTENT";
            default:
                return "IMPORTANCE_" + importance;
        }
    }

    /** 单行摘要，直接进 App 内日志页（华为屏蔽第三方 logcat，只能靠文件日志取证） */
    public static String summary(ApplicationExitInfo info) {
        StringBuilder sb = new StringBuilder();
        sb.append("kind=").append(kindName(classify(info.getReason(), info.getStatus(), info.getDescription())))
                .append(" reason=").append(info.getReason()).append(' ').append(reasonName(info.getReason()))
                .append(" status=").append(info.getStatus())
                .append(" pid=").append(info.getPid())
                .append(" importance=").append(info.getImportance())
                .append(' ').append(importanceName(info.getImportance()))
                .append(" pss=").append(info.getPss() / (1024L * 1024L)).append("MB")
                .append(" at=").append(info.getTimestamp())
                .append(" process=").append(info.getProcessName())
                .append(" description=").append(info.getDescription());
        return sb.toString();
    }
}
