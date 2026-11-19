package com.qoder.cinema;

/**
 * 崩溃现场的处置分级（P0-1）。
 *
 * <p>三条真机读数逼出了这张表（导出日志 peanutmov-logs-20261118-223945，OPPO PJH110 / API 35）：
 * <ul>
 *   <li><b>实锤被读数否掉</b>：11-16 23:54 在途哨兵 pid=18923 `spider.load`，同一 pid 同一
 *       线程（spider-worker）落下 SIGSEGV/SEGV_MAPERR tombstone，但 ROM 把这次死亡报成
 *       `reason=1 EXIT_SELF`→归因判「非崩溃」，那个 jar 一次都没被隔离过（旧代码的 jar 级
 *       隔离要 `crashedFinal` 才跑）。</li>
 *   <li><b>没实锤也第一次就禁 7 天</b>：11-16 13:40、11-18 19:16/19:27/22:37 都是
 *       `status=11 SIGNALED` + FOREGROUND、且当次<b>没有任何 tombstone</b>，旧逻辑对爬虫
 *       首次即隔离 7 天。哨兵只证明「在途」，不证明「因果」，一次可疑读数就拉黑一整周。</li>
 *   <li><b>同一 jar 换 api 反复崩</b>：11-18 19:27 崩在 `csp_PanWebShare123`、22:37 崩在
 *       `csp_PanWebShare`——同一个 jarMd5 `440f930e…` 两个不同 api，只按 api 签名计数永远
 *       累不到阈值。</li>
 * </ul>
 *
 * <p>分级办法：同步阶段（启动主线程，还没有 tombstone 结论）只给「暂定」处置——单次可疑
 * 只做短冷却；同一 api 复发按签名隔离，同一 jar 复发（换 api 也算）按 jar 隔离；后台线程
 * 拿到 tombstone 实锤后直接升级 jar 级。实锤永远优先于读数。
 *
 * <p>为什么复发计数必须独立于 tombstone 也能升级：tombstone 落盘/摄入会滞后好几天——11-16
 * 13:40 那条 maglev 线程的 SIGSEGV，直到 11-19 10:55 的启动才被 {@code CrashNative.ingest}
 * 读到（11-16 13:40:36、23:38 两次启动都没有「found native tombstone」）。把升级完全押在实锤上，
 * 坏源会在实锤到达前一直只吃冷却。而滞后同时带来反噬：旧 tombstone 与当前会话的哨兵 pid 必然
 * 对不上，按 pid 关联正好判不匹配；旧代码在这种「pid 对不上」的分支上是全量兜底（现场所有 jar
 * 一起拉黑），等于拿一次三天前的崩溃处置今天这一批无辜的源。
 *
 * <p>本类只做纯计算，处置表可以在 JVM 单测里跑全（见 CrashResponseTest）。
 */
public final class CrashResponse {

    /** 爬虫可疑但无实锤时的冷却时长：够打断「每次冷启都撞一次」的循环，又不至于冤枉一整周 */
    public static final long SPIDER_COOLDOWN_MS = 30 * 60 * 1000L;

    /** 24h 内同签名/同 jar 复发达到该值即视为确定性坏源，从冷却升级为隔离 */
    public static final int REPEAT_THRESHOLD = 2;

    /** 不处置 */
    public static final int TIER_NONE = 0;
    /** 短时冷却（到点自动放行，不占用隔离名单） */
    public static final int TIER_COOLDOWN = 1;
    /** 按签名（jar+api 粒度）隔离，7 天 */
    public static final int TIER_QUARANTINE = 2;
    /** 按 jar 隔离（该 jar 全部 api），7 天 */
    public static final int TIER_QUARANTINE_JAR = 3;

    private CrashResponse() {}

    /**
     * 这次进程死亡算不算崩溃。
     *
     * @param exitKind              {@link ExitAttribution#classify} 的读数
     * @param tombstoneCorroborated tombstone 已实锤（崩溃信号 + 与在途哨兵同一现场）
     */
    public static boolean isCrash(int exitKind, boolean tombstoneCorroborated) {
        // 实锤优先：ROM 会把 native abort 报成 EXIT_SELF / OTHER，读数不可靠
        if (tombstoneCorroborated) return true;
        return exitKind != ExitAttribution.NON_CRASH_EXIT;
    }

    /**
     * 处置分级。
     *
     * @param spiderInFlight         崩溃现场在途的是爬虫（spider.load / spider.invoke）
     * @param tombstoneCorroborated  是否已有 tombstone 实锤（同步阶段恒为 false）
     * @param sameApiIn24h           同一 `jar+api` 签名 24h 内的崩溃次数（含本次）
     * @param sameJarOtherApiIn24h   同一 jarMd5 但<b>不同 api</b> 24h 内的崩溃次数（不含本签名的那些）
     */
    public static int responseTier(boolean spiderInFlight, boolean tombstoneCorroborated,
                                   int sameApiIn24h, int sameJarOtherApiIn24h) {
        if (!spiderInFlight) {
            // 播放侧签名没有 jar 维度：维持原有「24h 内 2 次才处置」，单次可疑不动
            if (tombstoneCorroborated || sameApiIn24h >= REPEAT_THRESHOLD) return TIER_QUARANTINE;
            return TIER_NONE;
        }
        if (tombstoneCorroborated) return TIER_QUARANTINE_JAR;
        // 真凶在 jar 原生层：换 api 照崩（11-18 同 jar 两个 api 实证）。这个 jar 已经用另一个 api
        // 崩过一次，加上本次就是跨 api 的第 2 次——冷却只压住当前 api，换一集/换一路线照样再撞。
        // 代价是两起互不相关的单崩会把整个 jar 停一周，所以健康中心必须能手动放行（见 P0-1 前端）。
        if (sameJarOtherApiIn24h >= REPEAT_THRESHOLD - 1) return TIER_QUARANTINE_JAR;
        if (sameApiIn24h >= REPEAT_THRESHOLD) return TIER_QUARANTINE;
        return TIER_COOLDOWN;
    }

    /** 各档的名字，只用于日志与提示文案，不要让调用方比字符串 */
    public static String tierName(int tier) {
        switch (tier) {
            case TIER_COOLDOWN:
                return "cooldown";
            case TIER_QUARANTINE:
                return "quarantine";
            case TIER_QUARANTINE_JAR:
                return "quarantine-jar";
            default:
                return "none";
        }
    }

    /**
     * 崩溃线程是否同一线程类——只在 tombstone 没带 pid（{@code pid<=0}）时作兜底判据。
     *
     * <p>不作正向判据：同一根因不固定长在某个线程上。导出日志里 fault 地址同为 `0x7461642f`
     * 的三条 tombstone，两条落 `spider-worker`、一条落 V8 的 `maglev-pool-wor`；而爬虫哨兵本身
     * 也分 `spider-worker`（jar）与 `spider-python-lo`（drpy）两类线程。用线程名做肯定匹配会把
     * 同源崩溃误判成不同事。pid 字段缺失时总得有个口径，线程类比旧的「现场全部 jar 一起拉黑」
     * 窄得多，且判不匹配只会退化成不隔离。
     */
    public static boolean sameCrashThread(String tombstoneThread, String sentinelThread) {
        String crash = normalizeThread(tombstoneThread);
        return !crash.isEmpty() && crash.equals(normalizeThread(sentinelThread));
    }

    /** 线程名归一：小写 + 去掉尾部实例编号（`spider-worker-2` → `spider-worker`） */
    public static String normalizeThread(String raw) {
        if (raw == null) return "";
        return raw.trim().toLowerCase(java.util.Locale.US).replaceAll("[-_]?\\d+$", "");
    }
}
