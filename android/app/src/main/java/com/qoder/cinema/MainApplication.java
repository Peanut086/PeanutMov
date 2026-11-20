package com.qoder.cinema;

import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONObject;

import java.util.List;

/**
 * 全局 startActivity 守卫：吞掉 `android.settings.*` 系统设置页跳转。
 *
 * 背景：TVBox jar 爬虫（如 ftyguard 系列）在 init 期会自行申请「所有文件访问」
 * 等特殊权限并拉起对应设置页；本应用不声明这些权限（设置页开关必然置灰），
 * 放行只会打断用户。应用自身打开设置页一律带上
 * {@link #EXTRA_OWN_SETTINGS_JUMP}（见 {@code #blockSettingsJump}），普通跳转因此
 * 全局过滤是安全的。SpiderPlugin.GuardedSpiderContext 只能拦住经由传入 Context 的
 * 跳转，爬虫若反射获取 Application（ActivityThread.currentApplication()）则绕过
 * 包装——所以必须在 Application 层兜底（真机实证 2026-10-25 20:30 绕过一次）。
 */
public class MainApplication extends Application {

    private static final String TAG = "SettingsJumpGuard";
    private static final String SETTINGS_ACTION_PREFIX = "android.settings.";
    /** P0: 网盘账号登录需要放行「所有文件访问」授权页 */
    private static final String ALLOWED_SETTINGS_ACTION = "android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION";
    /**
     * 本 App 自己打开设置页的凭证 extra（提醒渠道 / 精确闹钟 / 电池优化必须由用户自己授权）。
     *
     * 只按 action 放行等于把同一扇门交给 jar 爬虫（它们正是靠拉设置页 nag 用户），
     * 所以放行条件是「带这个私有 extra」：爬虫拿不到约定键名，且每一次放行都单独留痕。
     */
    public static final String EXTRA_OWN_SETTINGS_JUMP = "com.qoder.cinema.extra.OWN_SETTINGS_JUMP";

    @Override
    public void onCreate() {
        super.onCreate();
        // 初始化日志仓库（启动时恢复开关状态，清理过期日志）
        SpiderLogStore.init(this);
        // EXT-06 / FR-71（API-24）：节目提醒渠道 + 投递能力快照。
        // 必须在这里（进程启动、Capacitor 插件 load 之前）完成，渠道才以本工程的
        // 名称/重要性登记；排期、持久化、重启恢复仍由 @capacitor/local-notifications 负责。
        ReminderNotifications.bootstrap(this);
        // P2-15：xCrash 原生崩溃/ANR 捕获（须在 installCrashHandler 之前，避免链式覆盖）
        // A2：xCrash 初始化（带参数 + errno 检查 + dumper 自检）
        xcrash.XCrash.InitParameters xcrashParams = new xcrash.XCrash.InitParameters()
                .setLogDir(new java.io.File(getFilesDir(), "tombstones").getAbsolutePath())
                .setNativeRethrow(true)
                .setJavaRethrow(true);
        int xcrashErr = xcrash.XCrash.init(this, xcrashParams);
        if (xcrashErr != 0) {
            AppLog.w(TAG, "xcrash init failed errno=" + xcrashErr);
        }
        // dumper 不存在则原生崩溃必无 tombstone（本次修复前就是这个原因）
        java.io.File dumper = new java.io.File(getApplicationInfo().nativeLibraryDir, "libxcrash_dumper.so");
        if (!dumper.exists()) {
            AppLog.w(TAG, "xcrash dumper missing: " + dumper);
        }
        // P3：安装全局崩溃处理器，写 FATAL 日志后交还默认处理
        installCrashHandler();
        // REV-24：初始化崩溃哨兵并检查上次异常退出
        CrashSentinel.init(this);
        checkLastExit();
    }

    /**
     * REV-24 / B3：检查上次退出原因，若发现未清除的哨兵则记录并隔离
     * OPT-17: tombstone 摄入与 ApplicationExitInfo 读取移后台（IO 重，不阻塞启动）
     */
    private void checkLastExit() {
        // 1. 检查未清除的哨兵（B1：per-invocation token 版）—— 同步，决定安全模式
        java.util.List<JSONObject> sentinels = CrashSentinel.readUnclearedAll();
        boolean crashed = true;
        int verdictKind = ExitAttribution.UNKNOWN;
        // F2'：崩溃现场哨兵快照（clearAll 会清空磁盘，后台线程要用它做 jar 级隔离）
        final java.util.List<JSONObject> crashSentinels = new java.util.ArrayList<>();
        if (!sentinels.isEmpty()) {
            // 取最新的（startedAt 最大）作为归因目标
            JSONObject sentinel = sentinels.get(0);
            AppLog.w(TAG, "found " + sentinels.size() + " uncleared sentinels, attributing to: " + sentinel.toString());

            // G1：先问系统上次进程究竟怎么没的。哨兵只证明「死亡时该操作在途」，不证明因果；
            // ROM 后台清理/低内存杀进程也会留下未清除哨兵，照常隔离等于每次被清就随机冤枉一个好源。
            ExitVerdict verdict = classifyLastExit(sentinel.optInt("pid", -1));
            AppLog.w("CrashExit", "sentinel attribution: " + verdict.detail);
            crashed = CrashResponse.isCrash(verdict.kind, false);
            verdictKind = verdict.kind;
            String appliedTier = "NONE";

            if (crashed) {
                CrashSentinel.recordCrash(this, sentinel);

                // 根据哨兵内容生成隔离签名
                String signature = buildQuarantineSignature(sentinel);
                if (signature != null) {
                    // P0-1：处置只看证据强度，不再由「是不是爬虫」直接决定，也不再只看 api 粒度。
                    // 真机读数（同一份导出日志）：11-16 13:40 与 11-18 19:16/19:27/22:37 都是
                    // status=11 而当场无 tombstone，旧逻辑首次即隔离 7 天；11-18 19:27→22:37 又是
                    // 同一 jar 换 api 再崩，只按 api 计数永远升不了级。详见 CrashResponse。
                    boolean spider = signature.startsWith("spider:");
                    String jarMd5 = spider ? sentinel.optString("jarMd5", "") : "";
                    int sameApi = crashCountInWindow(signature);
                    // jarCrashCountInWindow 不限 api、含本次，所以减掉本签名那几次才剩下「同一个 jar 换 api 崩的」
                    int sameJar = jarMd5.isEmpty() ? 0 : jarCrashCountInWindow(jarMd5);
                    int otherApi = Math.max(0, sameJar - sameApi);
                    int tier = CrashResponse.responseTier(spider, false, sameApi, otherApi);
                    if (tier == CrashResponse.TIER_QUARANTINE) {
                        CrashSentinel.quarantine(this, signature);
                    } else if (tier == CrashResponse.TIER_QUARANTINE_JAR) {
                        CrashSentinel.quarantineJar(this, jarMd5);
                    } else if (tier == CrashResponse.TIER_COOLDOWN) {
                        CrashSentinel.startCooldown(this, signature, CrashResponse.SPIDER_COOLDOWN_MS);
                    }
                    appliedTier = CrashResponse.tierName(tier);
                    if (tier != CrashResponse.TIER_NONE) {
                        AppLog.w(TAG, "crash response=" + CrashResponse.tierName(tier)
                                + " signature=" + signature + " sameApi24h=" + sameApi
                                + " sameJarOtherApi24h=" + otherApi
                                + (tier == CrashResponse.TIER_COOLDOWN
                                        ? " auto-release in "
                                                + (CrashResponse.SPIDER_COOLDOWN_MS / 60000L) + "min"
                                        : ""));
                    }
                }

                // 记录其他并发哨兵作为上下文
                for (int i = 1; i < sentinels.size(); i++) {
                    AppLog.i(TAG, "inFlight sentinel: " + sentinels.get(i).toString());
                }

                // P2：检查是否应进入安全模式
                checkSafeMode();
            } else {
                // 被系统杀掉：在途哨兵只是被打断，不记崩溃、不隔离、不进安全模式
                for (int i = 0; i < sentinels.size(); i++) {
                    AppLog.i(TAG, "inFlight at kill (not a crash): " + sentinels.get(i).toString());
                }
            }

            // F2'：留一份崩溃现场哨兵快照给后台线程（native tombstone 命中后做 jar 级隔离）
            crashSentinels.addAll(sentinels);

            // P0-1：治理判定需要的一行读数——构件指纹 + API + 阶段 + 退出证据 + 本轮处置。
            // 这些字段过去散在 response / sentinel attribution / tombstone / AEI 四行里，导出日志
            // 只能靠时间戳手工对；tier=NONE 同样留痕（"这一轮为什么没处置"也是结论）。
            // tombstone 命中时后台会再补一行给出最终档位（QUARANTINE_JAR）。
            String exitReason = verdict.reason >= 0
                    ? "aei:" + ExitAttribution.reasonName(verdict.reason)
                    : "aei:unavailable";
            AppLog.w(TAG, "exit evidence: pid=" + sentinel.optInt("pid", -1)
                    + " tid=" + sentinel.optLong("threadId", -1L)
                    + " thread=" + sentinel.optString("threadName", "?")
                    + " jarHash=" + sentinel.optString("jarMd5", "")
                    + " api=" + sentinel.optString("api", "")
                    + " phase=" + sentinel.optString("action", "?")
                    + (sentinel.has("method") ? ":" + sentinel.optString("method") : "")
                    + " exitReason=" + exitReason
                    + " status=" + verdict.status
                    + " signal=" + ExitAttribution.signalName(verdict.status)
                    + " at=" + verdict.ts
                    + " responseTier=" + appliedTier);
            SpiderExitLedger.recordProcessExit(
                    sentinel.optString("action", "?")
                            + (sentinel.has("method") ? ":" + sentinel.optString("method") : ""),
                    sentinel.optString("jarMd5", ""),
                    sentinel.optString("api", ""),
                    exitReason,
                    ExitAttribution.signalName(verdict.status),
                    appliedTier,
                    sentinel.optInt("pid", -1),
                    verdict.ts,
                    verdict.detail,
                    this);

            // 清除所有哨兵（两种归因都已记录完毕）
            CrashSentinel.clearAll();
        }

        // 2. 稳定启动（无新崩溃）时自动静默退出安全模式——用户无感，爬虫源立即恢复
        //    被系统强杀同样算稳定启动：那些隔离/降级本就不该由它触发。
        if (!crashed && isSafeMode(this)) {
            exitSafeMode(this);
            Log.i(TAG, "system kill: auto-exited safe mode");
        }
        if (sentinels.isEmpty() && isSafeMode(this)) {
            exitSafeMode(this);
            Log.i(TAG, "stable launch: auto-exited safe mode");
        }

        // OPT-17: 以下 IO 重操作移后台线程
        final boolean crashedFinal = crashed;
        final int verdictKindFinal = verdictKind;
        new Thread(() -> {
            // 0. 摄入 tombstone 摘要（A3）
            CrashNative.TombstoneInfo tombstone = CrashNative.ingest(this);
            if (tombstone != null) {
                AppLog.w(TAG, "found native tombstone: " + tombstone.filename
                        + " signal=" + tombstone.signal + " fault=" + tombstone.faultAddr
                        + " pid=" + tombstone.pid + " thread=" + tombstone.threadName
                        + " sig=" + tombstone.signature);
                // F2'：原生崩溃 tombstone 是最强证据（xcrash 只在真崩时落盘）。把与该 tombstone
                // 现场对得上的在途爬虫 jar 按 jarMd5 整体隔离——只崩一次也拉黑整个 jar，
                // 因为真凶在 jar 原生层，换 api 预热照崩（文件 B 两例同签名实证）。
                //
                // P0-1：这里不再要求 crashedFinal。真机实测 ROM 把原生段错误记成
                // reason=1 EXIT_SELF（ExitAttribution 判为非崩溃退出），旧的
                // `crashedFinal && tombstone.crashSignal` 闸门因此永远走不到 jar 级隔离；
                // 反过来 tombstone 才是那一次真正的证据，所以由它覆盖同步阶段的结论。
                if (tombstone.crashSignal) {
                    applyJarLevelQuarantine(tombstone, crashSentinels);
                    if (!crashedFinal && !crashSentinels.isEmpty()) {
                        for (JSONObject s : crashSentinels) {
                            if (!sentinelMatchesTombstone(s, tombstone)) continue;
                            AppLog.w(TAG, "exit verdict overridden by tombstone: attributed as "
                                    + ExitAttribution.kindName(verdictKindFinal)
                                    + " but xcrash caught " + tombstone.signal
                                    + " on thread=" + tombstone.threadName
                                    + " → attributed to " + s.optString("action", "?"));
                            CrashSentinel.recordCrash(MainApplication.this, s);
                            checkSafeMode();
                            break;
                        }
                    }
                }
            }

            // 3. 读取 ApplicationExitInfo（API 30+）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    // 原生 SIGSEGV 等绕过 Java 崩溃处理器，只能靠 ApplicationExitInfo 归因。
                    // 华为屏蔽第三方 logcat，故写文件日志（W 级，开关关闭也落盘），查看页可见。
                    // 按时间戳去重：只记录上次启动之后新出现的退出，避免每次启动重复刷旧崩溃。
                    android.content.SharedPreferences exitPrefs =
                            getSharedPreferences("crash-exit-info", MODE_PRIVATE);
                    long lastSeen = exitPrefs.getLong("lastTs", 0L);
                    long maxSeen = lastSeen;
                    // 16 条：WebView 沙箱进程的退出会插在主进程记录前面，5 条经常读不到主进程那条。
                    // 按包名过滤——传 null 会把别的 App 的退出记录一起塞进这 16 个名额里，把我们的挤掉。
                    List<ApplicationExitInfo> exitInfos = getApplicationContext()
                            .getSystemService(android.app.ActivityManager.class)
                            .getHistoricalProcessExitReasons(getPackageName(), 0, 16);
                    for (ApplicationExitInfo info : exitInfos) {
                        if (info.getTimestamp() > maxSeen) maxSeen = info.getTimestamp();
                        if (info.getTimestamp() <= lastSeen) continue;
                        // G2：所有原因都落盘。此前只记 2/4/5，而国产 ROM 上「闪退」的主因是
                        // reason=10/13（管家强杀）与 3（低内存），日志里一行都没有，用户报
                        // 「崩溃」时无从归因。W 级保证详细日志开关关闭也落盘。
                        int kind = ExitAttribution.classify(
                                info.getReason(), info.getStatus(), info.getDescription());
                        String prefix = kind == ExitAttribution.CRASH
                                ? "crash exit: "
                                : kind == ExitAttribution.NON_CRASH_EXIT
                                        ? "process gone (not a crash): "
                                        : "process gone (reason undetermined): ";
                        AppLog.w("CrashExit", prefix + ExitAttribution.summary(info));
                    }
                    if (maxSeen > lastSeen) exitPrefs.edit().putLong("lastTs", maxSeen).apply();
                } catch (Exception e) {
                    AppLog.w(TAG, "failed to read ApplicationExitInfo", e);
                }
            }
        }, "startup-io").start();
    }

    /** 上次进程退出的归因结论：kind 为 ExitAttribution.CRASH / NON_CRASH_EXIT / UNKNOWN，detail 为整行日志文案 */
    private static final class ExitVerdict {
        final int kind;
        final String detail;
        /** 系统给的原始退出原因（{@code ApplicationExitInfo#getReason()}），-1 = 没读到 */
        final int reason;
        /** 原始 status：SIGNALED/CRASH_NATIVE 时是信号号 */
        final int status;
        /** 退出发生时刻（epoch ms），0 = 没读到 */
        final long ts;

        ExitVerdict(int kind, String detail, int reason, int status, long ts) {
            this.kind = kind;
            this.detail = detail;
            this.reason = reason;
            this.status = status;
            this.ts = ts;
        }
    }

    /**
     * G1：查系统记录的最近一次主进程退出，判断是崩溃还是被杀。
     * <p>
     * 先用哨兵里的 pid 精确查（同一 pid 的退出不可能来自别的进程，返回集也最小）；
     * 查不到再退回该包名最新的一条。API 30 以下没有该接口，或读取异常时返回 UNKNOWN
     * ——保持原有「按崩溃处理」的行为。
     */
    private ExitVerdict classifyLastExit(int sentinelPid) {
        int kind = ExitAttribution.UNKNOWN;
        String detail = "no ApplicationExitInfo (API " + Build.VERSION.SDK_INT + ")";
        int reason = -1;
        int status = -1;
        long ts = 0L;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                android.app.ActivityManager am = getApplicationContext()
                        .getSystemService(android.app.ActivityManager.class);
                String self = getPackageName();
                ApplicationExitInfo target = null;
                boolean byPid = false;
                if (sentinelPid > 0) {
                    target = newestMainProcess(am.getHistoricalProcessExitReasons(self, sentinelPid, 4), self);
                    byPid = target != null;
                }
                if (target == null) {
                    // WebView 沙箱进程的退出记录会插在前面，只能多取几条再筛主进程
                    target = newestMainProcess(am.getHistoricalProcessExitReasons(self, 0, 16), self);
                }
                if (target != null) {
                    kind = ExitAttribution.classify(
                            target.getReason(), target.getStatus(), target.getDescription());
                    reason = target.getReason();
                    status = target.getStatus();
                    ts = target.getTimestamp();
                    detail = (byPid ? "pid matched" : "newest main-process exit")
                            + "; " + ExitAttribution.summary(target);
                } else {
                    detail = "no main-process exit record";
                }
            } catch (Exception e) {
                detail = "read ApplicationExitInfo failed: " + e;
            }
        }
        return new ExitVerdict(kind, ExitAttribution.kindName(kind) + " (" + detail + ")",
                reason, status, ts);
    }

    /** 过滤掉 WebView 沙箱等子进程；exit-info 按时间倒序，第一条即最新 */
    private static ApplicationExitInfo newestMainProcess(List<ApplicationExitInfo> infos, String self) {
        for (ApplicationExitInfo info : infos) {
            if (self.equals(info.getProcessName())) return info;
        }
        return null;
    }

    /**
     * F2'：原生崩溃 tombstone 命中后，把与崩溃现场对得上的在途爬虫 jar 整体（jar 级）隔离。
     *
     * P0-1：匹配口径从「pid 对不上就全量兜底」改成 pid → 崩溃线程名两级，两级都对不上时不隔离。
     * 旧兜底误伤面很大：11-18 那次 tombstone 落在 `spider-python-lo`（drpy 引擎自己的线程），
     * 现场同时有 6 个 guard jar 的 `spider-worker-N` 哨兵在途，全量兜底会把 6 个源一起禁 7 天，
     * 而它们与这次崩溃无关。
     */
    private void applyJarLevelQuarantine(CrashNative.TombstoneInfo tombstone,
                                         List<JSONObject> sentinels) {
        if (sentinels == null || sentinels.isEmpty()) return;
        java.util.Set<String> jarMd5s = new java.util.LinkedHashSet<>();
        java.util.Set<String> untouched = new java.util.LinkedHashSet<>();
        java.util.List<JSONObject> matched = new java.util.ArrayList<>();
        for (JSONObject s : sentinels) {
            String action = s.optString("action", "");
            if (!action.startsWith("spider.")) continue;
            String md5 = s.optString("jarMd5", "");
            if (md5.isEmpty()) continue;
            if (sentinelMatchesTombstone(s, tombstone)) {
                jarMd5s.add(md5);
                matched.add(s);
            } else {
                untouched.add(md5);
            }
        }
        for (String md5 : jarMd5s) {
            CrashSentinel.quarantineJar(this, md5);
            AppLog.w(TAG, "jar-level quarantine from tombstone: spider:" + md5 + ":*");
        }
        // P0-1：tombstone 命中给出最终档位的单行读数（同步阶段那行只看得到 AEI，够不到信号与构件）
        for (JSONObject s : matched) {
            String phase = s.optString("action", "?")
                    + (s.has("method") ? ":" + s.optString("method") : "");
            AppLog.w(TAG, "exit evidence: pid=" + tombstone.pid
                    + " thread=" + tombstone.threadName
                    + " jarHash=" + s.optString("jarMd5", "")
                    + " api=" + s.optString("api", "")
                    + " phase=" + phase
                    + " exitReason=native:tombstone"
                    + " signal=" + tombstone.signal
                    + " fault=" + tombstone.faultAddr
                    + " at=" + tombstone.crashTime
                    + " responseTier=QUARANTINE_JAR");
            SpiderExitLedger.recordProcessExit(
                    phase, s.optString("jarMd5", ""), s.optString("api", ""),
                    "native:tombstone", tombstone.signal, "QUARANTINE_JAR",
                    (int) tombstone.pid, tombstone.crashTime, tombstone.summary, this);
        }
        if (!untouched.isEmpty()) {
            AppLog.i(TAG, "in-flight jar(s) left alone (tombstone pid=" + tombstone.pid
                    + " thread=" + tombstone.threadName + "): " + untouched);
        }
    }

    /**
     * P0-1：哨兵与 tombstone 是否属于同一崩溃现场——只认 pid。
     *
     * <p>导出日志里三条 tombstone 的落点各不相同：11-16 23:54（pid=18923）与 11-17 00:02
     * （pid=25392）当场被摄入，pid 与崩溃现场的在途哨兵一致 → 判匹配；11-16 13:40 那条
     * （pid=14902，崩在 V8 的 maglev 线程）滞后 3 天到 11-19 才摄入，那时在途哨兵已是另一个
     * 进程 → 判不匹配、不隔离，正是需要的行为（旧代码在这里会把现场全部 jar 一起拉黑 7 天）。
     *
     * <p>不用线程名做正向判据：同一根因落在线程不确定——maglev 那条与两条 spider-worker 的
     * fault 地址同为 `0x7461642f`，线程名反而把同源崩溃分成两类。仅在 tombstone 没带 pid 时
     * 退回线程类（此时 pid 无从校验，比全量兜底窄得多）。
     */
    static boolean sentinelMatchesTombstone(JSONObject sentinel, CrashNative.TombstoneInfo tombstone) {
        if (sentinel == null || tombstone == null) return false;
        if (tombstone.pid > 0) return sentinel.optInt("pid", -1) == (int) tombstone.pid;
        return CrashResponse.sameCrashThread(tombstone.threadName, sentinel.optString("threadName", ""));
    }

    /**
     * 根据哨兵内容构建隔离签名
     */
    private String buildQuarantineSignature(JSONObject sentinel) {
        try {
            String action = sentinel.optString("action", "");
            if (action.startsWith("spider.")) {
                String jarMd5 = sentinel.optString("jarMd5", "");
                String api = sentinel.optString("api", "");
                if (!jarMd5.isEmpty() && !api.isEmpty()) {
                    return "spider:" + jarMd5 + ":" + api;
                }
            } else if (action.equals("exoplayer")) {
                String sourceId = sentinel.optString("sourceId", "");
                String host = sentinel.optString("host", "");
                if (!sourceId.isEmpty() && !host.isEmpty()) {
                    return "exoplayer:" + sourceId + ":" + host;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to build quarantine signature", e);
        }
        return null;
    }

    /**
     * 统计 24 小时内同一签名的崩溃次数（含刚记录下的这一次）
     */
    private int crashCountInWindow(String signature) {
        org.json.JSONArray history = CrashSentinel.getCrashHistory(this);
        long now = System.currentTimeMillis();
        long windowMs = 24 * 60 * 60 * 1000L;
        int count = 0;
        try {
            for (int i = 0; i < history.length(); i++) {
                JSONObject entry = history.getJSONObject(i);
                long recordedAt = entry.getLong("recordedAt");
                if (now - recordedAt > windowMs) continue;
                JSONObject s = entry.getJSONObject("sentinel");
                String sig = buildQuarantineSignature(s);
                if (signature.equals(sig)) {
                    count++;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to count crashes in window", e);
        }
        return count;
    }

    /**
     * P0-1：统计 24h 内同一 jarMd5（不限 api）的崩溃次数（含本次）。
     *
     * 为什么要单独按 jar 计：真机 11-18 19:27 崩在 `csp_PanWebShare123`、22:37 崩在
     * `csp_PanWebShare`，同一个 jar 换 api 照崩，只按 api 签名各自算永远是 1 次，升不了级。
     */
    private int jarCrashCountInWindow(String jarMd5) {
        org.json.JSONArray history = CrashSentinel.getCrashHistory(this);
        long now = System.currentTimeMillis();
        long windowMs = 24 * 60 * 60 * 1000L;
        int count = 0;
        try {
            for (int i = 0; i < history.length(); i++) {
                JSONObject entry = history.getJSONObject(i);
                if (now - entry.getLong("recordedAt") > windowMs) continue;
                JSONObject s = entry.getJSONObject("sentinel");
                if (!s.optString("action", "").startsWith("spider.")) continue;
                if (jarMd5.equals(s.optString("jarMd5", ""))) count++;
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to count jar crashes in window", e);
        }
        return count;
    }

    // ========== REV-24 P2：安全模式 ==========

    private static final String KEY_SAFE_MODE = "safe_mode";
    private static final String KEY_SAFE_MODE_SINCE = "safe_mode_since";
    private static final long SAFE_MODE_WINDOW_MS = 60 * 1000L; // 60 秒
    private static final int SAFE_MODE_THRESHOLD = 2; // 60 秒内 2 次崩溃进入安全模式
    private static final long SAFE_MODE_DURATION_MS = 24 * 60 * 60 * 1000L; // 24h 自动过期，避免永久卡死

    /**
     * 检查是否应进入安全模式（60 秒内崩溃 2 次）
     */
    private void checkSafeMode() {
        org.json.JSONArray history = CrashSentinel.getCrashHistory(this);
        long now = System.currentTimeMillis();
        int recentCrashes = 0;
        try {
            for (int i = history.length() - 1; i >= 0; i--) {
                JSONObject entry = history.getJSONObject(i);
                long recordedAt = entry.getLong("recordedAt");
                if (now - recordedAt > SAFE_MODE_WINDOW_MS) break;
                recentCrashes++;
            }
        } catch (Exception e) {
            Log.w(TAG, "failed to check safe mode", e);
        }
        if (recentCrashes >= SAFE_MODE_THRESHOLD) {
            Log.w(TAG, "entering safe mode: " + recentCrashes + " crashes in 60s");
            // 处置结论必须能在日志页看到：国产 ROM 屏蔽第三方 logcat，只有 AppLog 落盘的那份
            // 导得出来，此前安全模式进出全程不可见，用户报「源全没了」时无从归因。
            AppLog.w(TAG, "entering safe mode: " + recentCrashes + " crashes in 60s");
            android.content.SharedPreferences prefs = getSharedPreferences("crash-sentinel-prefs", MODE_PRIVATE);
            prefs.edit()
                    .putBoolean(KEY_SAFE_MODE, true)
                    .putLong(KEY_SAFE_MODE_SINCE, System.currentTimeMillis())
                    .apply();
        }
    }

    /**
     * 查询当前是否处于安全模式（供 SpiderPlugin / ExoPlayerPlugin 调用）
     */
    public static boolean isSafeMode(Context context) {
        try {
            android.content.SharedPreferences prefs = context.getSharedPreferences("crash-sentinel-prefs", MODE_PRIVATE);
            if (!prefs.getBoolean(KEY_SAFE_MODE, false)) return false;
            long since = prefs.getLong(KEY_SAFE_MODE_SINCE, 0L);
            if (since > 0 && System.currentTimeMillis() - since > SAFE_MODE_DURATION_MS) {
                prefs.edit().putBoolean(KEY_SAFE_MODE, false).remove(KEY_SAFE_MODE_SINCE).apply();
                Log.i(TAG, "safe mode auto-expired after 24h");
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 手动退出安全模式（供前端设置页调用）
     */
    public static void exitSafeMode(Context context) {
        try {
            android.content.SharedPreferences prefs = context.getSharedPreferences("crash-sentinel-prefs", MODE_PRIVATE);
            prefs.edit().putBoolean(KEY_SAFE_MODE, false).remove(KEY_SAFE_MODE_SINCE).apply();
            CrashSentinel.clearCrashHistory(context);
            Log.i(TAG, "safe mode exited");
        } catch (Exception e) {
            Log.w(TAG, "failed to exit safe mode", e);
        }
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable throwable) {
                try {
                    SpiderLogStore store = SpiderLogStore.get();
                    if (store != null) {
                        String msg = "FATAL in thread [" + thread.getName() + "]: "
                                + throwable.getClass().getName() + ": " + throwable.getMessage()
                                + "\n" + Log.getStackTraceString(throwable);
                        store.log("F", "CrashHandler", msg);
                        store.flushNow();
                    }
                } catch (Exception ignored) {
                    // 崩溃处理器内部不能再崩
                }
                if (defaultHandler != null) {
                    defaultHandler.uncaughtException(thread, throwable);
                }
            }
        });
    }

    @Override
    public void startActivity(Intent intent) {
        if (blockSettingsJump(intent)) return;
        super.startActivity(intent);
    }

    @Override
    public void startActivity(Intent intent, Bundle options) {
        if (blockSettingsJump(intent)) return;
        super.startActivity(intent, options);
    }

    private static boolean blockSettingsJump(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action != null && action.startsWith(SETTINGS_ACTION_PREFIX)) {
            // 本 App 的授权入口（提醒渠道 / 精确闹钟 / 电池优化）带私有 extra 才放行
            if (intent.hasExtra(EXTRA_OWN_SETTINGS_JUMP)) {
                Log.d(TAG, "own settings jump allowed: " + action);
                return false;
            }
            // P0: 放行「所有文件访问」授权页，其余 settings 跳转继续拦截
            if (ALLOWED_SETTINGS_ACTION.equals(action)) {
                Log.d(TAG, "allowed settings jump: " + action);
                return false;
            }
            Log.w(TAG, "blocked settings jump: " + action);
            return true;
        }
        return false;
    }

    /** 供 MainActivity 等其它入口复用（jar 权限库会解包到 Activity 直调其 startActivity） */
    static boolean shouldBlockSettingsJump(Intent intent) {
        return blockSettingsJump(intent);
    }
}
