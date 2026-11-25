package com.qoder.cinema;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.qoder.cinema.download.DownloadService;
import com.qoder.cinema.download.DownloadThrottle;

import android.os.StatFs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * MediaTool 原生插件（API-17：`remuxMp4` / `cancelRemux`；A-03：`extractFrames`）
 *
 * 定位：**薄适配层**。参数校验、路径安全、串行调度、取消注册、事件推送都在这里；
 * 真正的转封装在 {@link MediaRemuxer}（解复用 + 复用，不转码）。
 *
 * 契约（技术方案 API-17，逐条落地）：
 * - 只接受 `Directory.Data` 相对路径；拒绝空串、绝对路径、`..` 越界（§8.3.7）；
 * - 输出内部写 `{outputPath}.part`，成功后原子 rename（AC-143 无残留）；
 * - 转封装串行 1 个（§6.1），队列中的任务可被 `cancelRemux` 取消；
 * - 事件 `remuxProgress`（processedUs / durationUs），节流由 {@link MediaRemuxer} 保证 ≤2 次/秒；
 * - 失败不抛异常栈给 JS：统一返回 `{ ok:false, code, reason }`，由前端回退 `.ts`（AC-143）。
 *
 * 与前端 JS 桥的两处字段差异（**已上报协调者，未私改契约**，此处做双向兼容）：
 * 1. `cancelRemux`：API-17 用 `taskId`，`src/native/mediaToolPlugin.ts` 用 `inputPath` → 两者都接受；
 * 2. `remuxMp4`：API-17 有 `taskId`，JS 桥未传 → `taskId` 变可选，事件里同时回传 `inputPath` 供关联。
 *
 * 能力补齐（原属 API-18，现随 EXT-04 / FR-63 落地）：`getStorageInfo` / `setSpeedLimit`。
 * 前者用 StatFs 报真实可用空间——前端此前回退的 `navigator.storage.estimate()`
 * 在 Android WebView 上拿到的是配额估值而非磁盘剩余，预检因此会算错；
 * 后者把档位下发给 {@link DownloadThrottle}，让「对所有下载任务生效」这句承诺成立
 * （原生直链不经 JS sink，此前只有 JS 桶在扣减）。
 *
 * @author xyp
 */
@CapacitorPlugin(name = "MediaTool")
public class MediaToolPlugin extends Plugin {

    private static final String TAG = "MediaToolPlugin";
    private static final String EVENT_PROGRESS = "remuxProgress";
    private static final String DATA_RELATIVE_ROOT = "downloads";
    /** 启动清理只认这个后缀，避免误删 RangeDownloader 的下载 `.part` */
    private static final String REMUX_PART_SUFFIX = ".mp4.part";
    private static final int CLEANUP_MAX_DEPTH = 4;
    private static final long DEFAULT_TIMEOUT_MS = MediaRemuxer.DEFAULT_TIMEOUT_MS;
    private static final long MAX_TIMEOUT_MS = 600_000L;

    /** A-03 抽帧上限：一次拖动最多要 24 格，再多就只会让工作线程排队 */
    private static final int MAX_FRAMES = 24;
    private static final int MIN_FRAME_EDGE = 32;
    private static final int MAX_FRAME_EDGE = 256;

    /** 进行中 + 排队中的转封装任务，key 为输入文件规范化路径 */
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final AtomicBoolean transformerProbeRunning = new AtomicBoolean(false);
    /** 已 begin 但尚未 end 的后处理计数；插件销毁时按它把前台服务计数补齐，避免泄漏 */
    private final AtomicInteger openPostprocess = new AtomicInteger(0);
    private ExecutorService worker;
    /** 抽帧独立线程：与转封装分离，避免后处理跑长任务时进度条预览排在其后 */
    private ExecutorService frameWorker;
    /** FIX-PLAY-C3：TS 自检扫描线程（纯读文件），同样压最低优先级，不与播放/下载争抢 */
    private ExecutorService scanWorker;

    // ========== 生命周期 ==========

    @Override
    public void load() {
        super.load();
        // FR-60 §6.1：转封装串行 1 个，独立线程，避免占用电容桥线程与下载队列
        worker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "media-remux");
            thread.setPriority(Thread.NORM_PRIORITY - 1);
            return thread;
        });
        // A-03：抽帧是"越小越快越好"的辅助能力，线程优先级压到最低，抢不过播放与下载
        frameWorker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "seek-frames");
            thread.setPriority(Thread.MIN_PRIORITY);
            return thread;
        });
        // FIX-PLAY-C3：TS 对齐扫描（文件自检），单线程低优先级
        scanWorker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "ts-scan");
            thread.setPriority(Thread.MIN_PRIORITY);
            return thread;
        });
        // AC-143 / NFR 可靠性：上次进程被杀留下的 *.mp4.part 一律视为残留，启动即清理
        try {
            worker.execute(this::cleanupStaleParts);
        } catch (RejectedExecutionException ignored) {
        }
        AppLog.i(TAG, "MediaTool loaded");
    }

    @Override
    public void handleOnDestroy() {
        for (Job job : jobs.values()) {
            job.canceled.set(true);
        }
        jobs.clear();
        if (worker != null) {
            worker.shutdownNow();
            worker = null;
        }
        if (frameWorker != null) {
            // 中断即让 SeekFrameExtractor 在下一帧检查点退出；未 resolve 的调用由 WebView 回收
            frameWorker.shutdownNow();
            frameWorker = null;
        }
        if (scanWorker != null) {
            scanWorker.shutdownNow();
            scanWorker = null;
        }
        // shutdownNow 会丢弃尚未开始的任务，它们的 runRemux 不会执行，
        // 因此这里兜底把后处理计数归零，避免前台服务永远停在"转封装中"
        int outstanding = openPostprocess.getAndSet(0);
        for (int i = 0; i < outstanding; i++) {
            DownloadService.endPostprocess(getContext());
        }
        super.handleOnDestroy();
    }

    /** 能力探测（加法方法，不改变 API-17 既有签名；前端仍以 isPluginAvailable 为准） */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("platform", "android");
        result.put("engine", "MediaExtractor+MediaMuxer");
        result.put("maxTimeoutMs", MAX_TIMEOUT_MS);
        call.resolve(result);
    }

    // ========== EXT-04 / FR-63：存储与限速 ==========

    /**
     * 真实可用空间。
     *
     * Directory.Data 在 Android 上就是 `getFilesDir()`，因此直接对它 StatFs；
     * 前端此前回退的 `navigator.storage.estimate()` 拿到的是浏览器配额估值，
     * 与磁盘剩余可能差一个数量级，预检「空间不足」判定因此不可信。
     */
    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        try {
            File probe = resolveProbeDir(call.getString("path"));
            StatFs stat = new StatFs(probe.getAbsolutePath());
            long blockSize = stat.getBlockSizeLong();
            JSObject result = new JSObject();
            result.put("freeBytes", stat.getAvailableBlocksLong() * blockSize);
            result.put("totalBytes", stat.getBlockCountLong() * blockSize);
            result.put("path", probe.getAbsolutePath());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("getStorageInfo 失败: " + e.getMessage());
        }
    }

    /**
     * 可空长整型入参。`call.getLong(key)` 只认 org.json 的 Long，而 JS 数字在桥里是 Integer，
     * 会被判成类型不符返回 null；这里按 Number 取，仅缺失或非数字才退回 null（同源缺陷见 ExoPlayerPlugin P0-7）。
     */
    private static Long optLongOrNull(JSObject data, String key) {
        Object value = data.opt(key);
        return value instanceof Number ? ((Number) value).longValue() : null;
    }

    /** 下发全局限速额度；bytesPerSec <= 0 表示不限速。切换立即对进行中的分段线程生效 */
    @PluginMethod
    public void setSpeedLimit(PluginCall call) {
        Long bytesPerSec = optLongOrNull(call.getData(), "bytesPerSec");
        if (bytesPerSec == null) {
            call.reject("bytesPerSec required");
            return;
        }
        long value = bytesPerSec < 0 ? 0L : bytesPerSec;
        DownloadThrottle.shared().setBytesPerSec(value);
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("bytesPerSec", value);
        call.resolve(result);
    }

    /** 只接受 `getFilesDir()` 之内的相对路径，绝对路径与 `..` 越界一律退回根目录 */
    private File resolveProbeDir(String relPath) {
        File filesDir = getContext().getFilesDir();
        if (relPath == null || relPath.trim().isEmpty()) {
            return filesDir;
        }
        try {
            File candidate = new File(filesDir, relPath);
            if (candidate.getCanonicalPath().startsWith(filesDir.getCanonicalPath())) {
                return candidate.exists() ? candidate : filesDir;
            }
        } catch (IOException ignored) {
        }
        return filesDir;
    }

    // ========== API-17 ==========

    /**
     * TS → MP4 转封装。
     *
     * 入参：`inputPath` / `outputPath`（必填，相对 Directory.Data）、`taskId`、`container`、
     * `deleteInput`（P0-3：默认 **false**，输入一律保留；只有调用方确认下载记录已按新产物
     * 落库后才显式传 true）、`timeoutMs`（默认 120000，上限 600000）。
     */
    @PluginMethod
    public void remuxMp4(PluginCall call) {
        String taskId = trimToNull(call.getString("taskId"));
        String inputPath = trimToNull(call.getString("inputPath"));
        String outputPath = trimToNull(call.getString("outputPath"));
        String container = trimToNull(call.getString("container"));
        Boolean deleteInputArg = call.getBoolean("deleteInput", Boolean.FALSE);
        Long timeoutArg = optLongOrNull(call.getData(), "timeoutMs");

        if (inputPath == null || outputPath == null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "inputPath/outputPath required");
            return;
        }

        if ("fmp4".equalsIgnoreCase(container)) {
            // AC-154：fMP4 本身就是 MP4 家族，直接以 .mp4 交付，不触碰解复用器、不产生临时副本
            JSObject skipped = new JSObject();
            skipped.put("ok", true);
            skipped.put("success", true);
            skipped.put("skipped", true);
            skipped.put("reason", "fmp4-passthrough");
            skipped.put("container", "fmp4");
            skipped.put("durationMs", 0L);
            skipped.put("tracks", new JSArray());
            if (taskId != null) skipped.put("taskId", taskId);
            skipped.put("inputPath", inputPath);
            AppLog.i(TAG, "remux skipped (fmp4 passthrough) task=" + safe(taskId) + " input=" + inputPath);
            call.resolve(skipped);
            return;
        }

        long timeoutMs = DEFAULT_TIMEOUT_MS;
        if (timeoutArg != null) {
            if (timeoutArg <= 0) {
                reject(call, MediaRemuxer.CODE_INVALID_INPUT, "timeoutMs must be > 0");
                return;
            }
            timeoutMs = Math.min(timeoutArg, MAX_TIMEOUT_MS);
        }

        File filesDir = getContext().getFilesDir();
        File input;
        File output;
        try {
            input = resolveInData(filesDir, inputPath);
            output = resolveInData(filesDir, outputPath);
        } catch (IllegalArgumentException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, e.getMessage());
            return;
        }
        if (input.equals(output)) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "input and output must differ");
            return;
        }
        if (!output.getName().toLowerCase(java.util.Locale.US).endsWith(".mp4")) {
            // 输出必须是 .mp4：既保证语义，也让 `{base}.mp4.part` 落在启动清理规则内（AC-143）
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "outputPath must end with .mp4");
            return;
        }
        if (!input.isFile() || input.length() <= 0) {
            reject(call, MediaRemuxer.CODE_FILE_MISSING, "input missing or empty");
            return;
        }

        String key = canonicalOf(input);
        boolean deleteInput = Boolean.TRUE.equals(deleteInputArg);
        Job job = new Job(key, taskId, input, output, inputPath, outputPath, deleteInput, timeoutMs);
        if (jobs.putIfAbsent(key, job) != null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "remux already running for this input");
            return;
        }

        ExecutorService executor = worker;
        if (executor == null || executor.isShutdown()) {
            jobs.remove(key);
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "plugin not ready");
            return;
        }

        // FR-60 / 集成点：转封装期间保持前台服务，避免后台被系统回收
        beginPostprocess();
        try {
            executor.execute(() -> runRemux(job, call));
        } catch (RejectedExecutionException e) {
            jobs.remove(key);
            endPostprocess();
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "remux executor rejected");
        }
    }

    /**
     * P0-3：独立复检一个盘上产物（开机对账、采纳没有记账的孤儿 MP4 之前调用）。
     * `path` 与 `remuxMp4` 同一口径（相对 `Directory.Data`，不接受绝对路径）。
     * 只读探测，不写文件；用的尺子和转封装交付校验是同一把（`MediaRemuxer.probePublished`），
     * 否则"当场通过、重启后判废"会自己打自己。
     *
     * P2-2：除了结论，还把轨道、时长和首/中/尾定位抽样一并回给前端，让「文件自检」能拿出证据。
     * 可选 `expectedDurationUs`（下载记账的跨度）带上后同时验时长漂移。
     */
    @PluginMethod
    public void verifyMedia(PluginCall call) {
        String path = trimToNull(call.getString("path"));
        if (path == null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "path required");
            return;
        }
        File file;
        try {
            file = resolveInData(getContext().getFilesDir(), path);
        } catch (IllegalArgumentException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, e.getMessage());
            return;
        }
        JSObject response = new JSObject();
        if (!file.isFile() || file.length() <= 0) {
            response.put("ok", false);
            response.put("probeVerdict", "missing");
            response.put("outputBytes", 0L);
            response.put("seekPoints", new JSArray());
            call.resolve(response);
            return;
        }
        Long expectedBoxed = call.getLong("expectedDurationUs");
        long expectedDurationUs = expectedBoxed == null || expectedBoxed <= 0L ? 0L : expectedBoxed;
        MediaRemuxer.ProbeReport report = MediaRemuxer.probeReport(file, expectedDurationUs);
        boolean pass = report.verdict == null;
        response.put("ok", pass);
        response.put("probeVerdict", pass ? "pass" : report.verdict);
        response.put("outputBytes", file.length());
        response.put("trackCount", report.trackCount);
        response.put("audioTrackCount", report.audioTrackCount);
        response.put("videoTrackIndex", report.videoTrackIndex);
        response.put("videoMime", report.videoMime);
        response.put("width", report.width);
        response.put("height", report.height);
        response.put("durationUs", report.durationUs);
        response.put("expectedDurationUs", expectedDurationUs);
        JSArray seeks = new JSArray();
        for (MediaRemuxer.ProbeSeek seek : report.seeks) {
            JSObject item = new JSObject();
            item.put("phase", seek.phase);
            item.put("requestedUs", seek.requestedUs);
            item.put("sampleUs", seek.sampleUs);
            item.put("deltaUs", seek.sampleUs < 0 ? -1L : seek.sampleUs - seek.requestedUs);
            item.put("sizeBytes", seek.sizeBytes);
            item.put("hit", seek.hit);
            seeks.put(item);
        }
        response.put("seekPoints", seeks);
        call.resolve(response);
    }

    /**
     * P1-B：Media3 Transformer 无损转封装 PoC。输入永远保留，输出先写 `.mp4.part`；
     * 只有禁止转码、输入输出编码样本指纹、B 切片、时长和首中尾定位全部通过才返回 ok。
     */
    @PluginMethod
    public void probeTsRemux(PluginCall call) {
        String inputPath = trimToNull(call.getString("inputPath"));
        String outputPath = trimToNull(call.getString("outputPath"));
        if (inputPath == null || outputPath == null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "inputPath/outputPath required");
            return;
        }
        Long timeoutArg = optLongOrNull(call.getData(), "timeoutMs");
        long timeoutMs = TransformerTsProbe.DEFAULT_TIMEOUT_MS;
        if (timeoutArg != null) {
            if (timeoutArg <= 0) {
                reject(call, MediaRemuxer.CODE_INVALID_INPUT, "timeoutMs must be > 0");
                return;
            }
            timeoutMs = Math.min(timeoutArg, TransformerTsProbe.MAX_TIMEOUT_MS);
        }

        File input;
        File output;
        try {
            input = resolveInData(getContext().getFilesDir(), inputPath);
            output = resolveInData(getContext().getFilesDir(), outputPath);
        } catch (IllegalArgumentException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, e.getMessage());
            return;
        }
        if (input.equals(output)) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "input and output must differ");
            return;
        }
        if (!output.getName().toLowerCase(java.util.Locale.US).endsWith(".mp4")) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "outputPath must end with .mp4");
            return;
        }
        if (!input.isFile() || input.length() <= 0) {
            reject(call, MediaRemuxer.CODE_FILE_MISSING, "input missing or empty");
            return;
        }
        File part = new File(output.getAbsolutePath() + ".part");
        if (output.exists() || part.exists()) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "output or .mp4.part already exists");
            return;
        }
        if (!transformerProbeRunning.compareAndSet(false, true)) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "transformer probe already running");
            return;
        }

        try {
            TransformerTsProbe.run(getContext(), input, output, timeoutMs, result -> {
                transformerProbeRunning.set(false);
                AppLog.i(TAG, "transformer-poc done verdict=" + result.optString("verdict")
                        + " input=" + inputPath + " output=" + outputPath
                        + " elapsedMs=" + result.optLong("elapsedMs"));
                try {
                    JSObject response = JSObject.fromJSONObject(result);
                    response.put("inputPath", inputPath);
                    response.put("outputPath", outputPath);
                    call.resolve(response);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception e) {
            transformerProbeRunning.set(false);
            reject(call, MediaRemuxer.CODE_UNSUPPORTED, "transformer probe start failed: " + e.getMessage());
        }
    }

    /**
     * 取消转封装：置取消位 → 工作线程在下一个检查点返回 `E_CANCELED` 并删除 `.part`。
     * 请求支持 `taskId`（API-17）或 `inputPath`（前端 JS 桥），未命中返回 `{canceled:false}`。
     */
    @PluginMethod
    public void cancelRemux(PluginCall call) {
        String taskId = trimToNull(call.getString("taskId"));
        String inputPath = trimToNull(call.getString("inputPath"));
        if (taskId == null && inputPath == null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "taskId or inputPath required");
            return;
        }

        Job target = null;
        for (Job job : jobs.values()) {
            if (taskId != null && taskId.equals(job.taskId)) {
                target = job;
                break;
            }
            if (inputPath != null && inputPath.equals(job.inputPath)) {
                target = job;
                break;
            }
        }

        JSObject result = new JSObject();
        if (target == null) {
            result.put("canceled", false);
        } else {
            target.canceled.set(true);
            result.put("canceled", true);
            AppLog.i(TAG, "remux cancel requested task=" + safe(target.taskId) + " input=" + target.inputPath);
        }
        call.resolve(result);
    }

    // ========== A-03 进度条抽帧 ==========

    /**
     * 抽取进度条预览帧。
     *
     * 入参：`path`（相对 Directory.Data，必填）、`timesMs`（时间点数组，最多 24 个）、
     * `maxEdge`（默认 128，限 32~256）、`quality`（JPEG 质量，默认 60，限 20~95）。
     * 出参：`{ frames: [{index, timeMs, dataUrl}] }`，取不到的帧直接缺席。
     *
     * 只服务本地文件：远端流没有可读的容器，前端会先判断再调用；这里对在线源
     * 一律返回空数组，让预览退回"只有时间"的气泡而不是报错。
     */
    @PluginMethod
    public void extractFrames(PluginCall call) {
        String path = trimToNull(call.getString("path"));
        JSArray timesArg = call.getArray("timesMs");
        if (path == null || timesArg == null || timesArg.length() == 0) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "path and timesMs required");
            return;
        }
        if (timesArg.length() > MAX_FRAMES) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "timesMs exceeds " + MAX_FRAMES);
            return;
        }

        File file;
        try {
            file = resolveInData(getContext().getFilesDir(), path);
        } catch (IllegalArgumentException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, e.getMessage());
            return;
        }

        final long[] timesMs = new long[timesArg.length()];
        for (int i = 0; i < timesArg.length(); i++) {
            timesMs[i] = Math.max(0L, timesArg.optLong(i));
        }
        final int maxEdge = clamp(call.getInt("maxEdge"), SeekFrameExtractor.DEFAULT_MAX_EDGE, MIN_FRAME_EDGE, MAX_FRAME_EDGE);
        final int quality = clamp(call.getInt("quality"), SeekFrameExtractor.DEFAULT_QUALITY, 20, 95);

        ExecutorService executor = frameWorker;
        if (executor == null || executor.isShutdown()) {
            resolveFrames(call, new SeekFrameExtractor.Frame[0]);
            return;
        }
        if (!file.isFile() || file.length() <= 0) {
            resolveFrames(call, new SeekFrameExtractor.Frame[0]);
            return;
        }

        final File target = file;
        try {
            executor.execute(() -> resolveFrames(call, SeekFrameExtractor.extract(target, timesMs, maxEdge, quality)));
        } catch (RejectedExecutionException e) {
            resolveFrames(call, new SeekFrameExtractor.Frame[0]);
        }
    }

    /** 抽帧回包：缺帧不报错，前端按"没有预览"降级 */
    private void resolveFrames(PluginCall call, SeekFrameExtractor.Frame[] frames) {
        JSObject result = new JSObject();
        JSArray items = new JSArray();
        for (SeekFrameExtractor.Frame frame : frames) {
            JSObject item = new JSObject();
            item.put("index", frame.index);
            item.put("timeMs", frame.timeMs);
            item.put("dataUrl", frame.dataUrl);
            items.put(item);
        }
        result.put("frames", items);
        try {
            call.resolve(result);
        } catch (Exception ignored) {
            // WebView 已销毁时 resolve 会失败，忽略即可
        }
    }

    // ========== 工作线程 ==========

    private void runRemux(final Job job, final PluginCall call) {
        JSObject response;
        try {
            response = remuxOrFailure(job);
        } catch (Throwable t) {
            // 禁止裸抛：任何意外都收敛成契约内的 code，前端据此回退 .ts
            AppLog.e(TAG, "remux crashed task=" + safe(job.taskId) + " input=" + job.inputPath, t);
            response = failureResponse(job, MediaRemuxer.CODE_UNSUPPORTED, "internal-error");
        } finally {
            jobs.remove(job.key);
            endPostprocess();
        }
        try {
            call.resolve(response);
        } catch (Exception ignored) {
            // WebView 已销毁时 resolve 会失败，忽略即可（任务侧按未完成处理）
        }
    }

    private JSObject remuxOrFailure(Job job) {
        if (job.canceled.get()) {
            JSObject canceled = failureResponse(job, MediaRemuxer.CODE_CANCELED, MediaRemuxer.REASON_CANCELED);
            AppLog.i(TAG, "remux canceled before start task=" + safe(job.taskId) + " input=" + job.inputPath);
            return canceled;
        }

        MediaRemuxer.Result result = MediaRemuxer.remux(
                job.input,
                job.output,
                job.deleteInput,
                job.timeoutMs,
                (processedUs, durationUs) -> emitProgress(job, processedUs, durationUs),
                () -> job.canceled.get() || Thread.currentThread().isInterrupted());

        JSObject response = new JSObject();
        response.put("ok", result.ok);
        // 任务书字段名（success）与 API-17（ok）并存，前端 TS 桥取 ok
        response.put("success", result.ok);
        response.put("skipped", result.skipped);
        response.put("inputBytes", result.inputBytes);
        response.put("outputBytes", result.outputBytes);
        response.put("durationUs", result.durationUs);
        response.put("durationMs", result.elapsedMs);
        response.put("container", result.container != null ? result.container : "ts");
        // P0-3：交付复检结论 + 输入是否还在，前端据此决定"能不能删 TS / 要不要回滚记账"
        response.put("probeVerdict", result.probeVerdict);
        response.put("inputRetained", result.inputRetained);
        response.put("inputPath", job.inputPath);
        if (job.taskId != null) response.put("taskId", job.taskId);
        if (result.code != null) response.put("code", result.code);
        if (result.reason != null) response.put("reason", result.reason);
        if (result.outputPath != null) {
            // 回传相对路径语义，避免把绝对路径泄露给 UI
            response.put("outputPath", job.outputPath);
        }
        JSArray tracks = new JSArray();
        for (MediaRemuxer.Track track : result.tracks) {
            JSObject item = new JSObject();
            item.put("type", track.type);
            item.put("mime", track.mime);
            if (track.width > 0) item.put("width", track.width);
            if (track.height > 0) item.put("height", track.height);
            if (track.channels > 0) item.put("channels", track.channels);
            if (track.sampleRate > 0) item.put("sampleRate", track.sampleRate);
            tracks.put(item);
        }
        response.put("tracks", tracks);

        // §6.4：一条汇总日志，只记 taskId + 相对路径 + 耗时，不记 URL / headers
        if (result.ok && !result.skipped) {
            AppLog.i(TAG, "remux done task=" + safe(job.taskId) + " input=" + job.inputPath
                    + " -> " + job.outputPath + " in " + result.elapsedMs + "ms"
                    + " (" + result.inputBytes + " -> " + result.outputBytes + " bytes)");
        } else if (result.skipped) {
            AppLog.i(TAG, "remux skipped task=" + safe(job.taskId) + " reason=" + result.reason);
        } else {
            AppLog.w(TAG, "remux failed task=" + safe(job.taskId) + " code=" + result.code
                    + " reason=" + result.reason + " in " + result.elapsedMs + "ms");
        }
        return response;
    }

    private JSObject failureResponse(Job job, String code, String reason) {
        JSObject response = new JSObject();
        response.put("ok", false);
        response.put("success", false);
        response.put("skipped", false);
        response.put("code", code);
        response.put("reason", reason);
        // 失败时产物仍是原 .ts（AC-143），前端据此保留文件
        response.put("container", "ts");
        response.put("inputBytes", job.input.length());
        response.put("outputBytes", 0L);
        response.put("durationUs", 0L);
        response.put("durationMs", 0L);
        response.put("inputPath", job.inputPath);
        if (job.taskId != null) response.put("taskId", job.taskId);
        response.put("tracks", new JSArray());
        return response;
    }

    /** 进度事件 + 前台通知同步（"转封装中 x%"），节流由 MediaRemuxer 负责 */
    private void emitProgress(Job job, long processedUs, long durationUs) {
        try {
            if (durationUs > 0) {
                int percent = (int) Math.min(100L, Math.max(0L, processedUs * 100L / durationUs));
                DownloadService.updatePostprocessNotification(percent);
            } else {
                DownloadService.updatePostprocessNotification(-1);
            }
            JSObject data = new JSObject();
            data.put("taskId", job.taskId != null ? job.taskId : "");
            data.put("inputPath", job.inputPath);
            data.put("outputPath", job.outputPath);
            data.put("processedUs", processedUs);
            data.put("durationUs", durationUs);
            notifyListeners(EVENT_PROGRESS, data);
        } catch (Exception ignored) {
            // 事件推送失败不影响转封装
        }
    }

    // ========== FIX-PLAY-C3：离线 TS 文件自检 ==========

    /**
     * TS 对齐扫描：按 188/192 包长全量校验 0x47 同步字节，定位损坏偏移。
     *
     * 入参：`path`（相对 Directory.Data，必填）。
     * 出参：`{ok, verdict, fileSize, packetSize, alignedStart, totalPackets,
     * badPackets, firstBadOffset, tailBytes}`；verdict ∈
     * `ok | not-ts | corrupt | truncated | prefix`。
     *
     * 「播放到一半报 MediaCodec 解码错误」的产物多数能在扫描里现形：坏包偏移
     * （corrupt）、尾部残包（truncated）、头部混入非 TS 前缀（prefix）。
     * 纯文件读计算，不碰解码器；单线程低优先级，不抢播放/下载资源。
     */
    @PluginMethod
    public void scanTs(PluginCall call) {
        String path = trimToNull(call.getString("path"));
        if (path == null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "path required");
            return;
        }
        File file;
        try {
            file = resolveInData(getContext().getFilesDir(), path);
        } catch (IllegalArgumentException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, e.getMessage());
            return;
        }
        if (!file.isFile() || file.length() <= 0) {
            reject(call, MediaRemuxer.CODE_FILE_MISSING, "input missing or empty");
            return;
        }
        ExecutorService executor = scanWorker;
        if (executor == null || executor.isShutdown()) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "plugin not ready");
            return;
        }
        final File target = file;
        try {
            executor.execute(() -> runTsScan(target, call));
        } catch (RejectedExecutionException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "scan executor rejected");
        }
    }

    /** D：只读提取 TS 视频 PTS/DTS 时间轴；不重写文件，也不推断缺失时长。 */
    @PluginMethod
    public void scanTsTimeline(PluginCall call) {
        String path = trimToNull(call.getString("path"));
        if (path == null) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "path required");
            return;
        }
        File file;
        try {
            file = resolveInData(getContext().getFilesDir(), path);
        } catch (IllegalArgumentException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, e.getMessage());
            return;
        }
        if (!file.isFile() || file.length() <= 0) {
            reject(call, MediaRemuxer.CODE_FILE_MISSING, "input missing or empty");
            return;
        }
        ExecutorService executor = scanWorker;
        if (executor == null || executor.isShutdown()) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "plugin not ready");
            return;
        }
        final File target = file;
        try {
            executor.execute(() -> runTsTimelineScan(target, call));
        } catch (RejectedExecutionException e) {
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "scan executor rejected");
        }
    }

    private void runTsTimelineScan(File file, PluginCall call) {
        try {
            JSONObject scanned = TsTimelineScanner.scan(file);
            JSObject result = new JSObject();
            result.put("ok", scanned.optBoolean("ok", false));
            result.put("timelineReliable", scanned.optBoolean("timelineReliable", false));
            result.put("verdict", scanned.optString("verdict", "no-timeline"));
            result.put("fileSize", scanned.optLong("fileSize", file.length()));
            result.put("packetSize", scanned.optInt("packetSize", 0));
            result.put("alignedStart", scanned.optLong("alignedStart", -1));
            result.put("totalPackets", scanned.optLong("totalPackets", 0));
            result.put("badPackets", scanned.optLong("badPackets", 0));
            result.put("firstBadOffset", scanned.optLong("firstBadOffset", -1));
            result.put("tailBytes", scanned.optLong("tailBytes", 0));
            result.put("timestampCount", scanned.optLong("timestampCount", 0));
            result.put("timelineSource", scanned.optString("timelineSource", ""));
            result.put("durationUs", scanned.optLong("durationUs", 0));
            result.put("discontinuities", scanned.optInt("discontinuities", 0));
            JSArray segments = new JSArray();
            JSONArray rawSegments = scanned.optJSONArray("segments");
            if (rawSegments != null) {
                for (int i = 0; i < rawSegments.length(); i++) {
                    JSONObject raw = rawSegments.optJSONObject(i);
                    if (raw == null) continue;
                    JSObject segment = new JSObject();
                    segment.put("offset", raw.optLong("offset", -1));
                    segment.put("durationUs", raw.optLong("durationUs", 0));
                    segment.put("discontinuity", raw.optBoolean("discontinuity", false));
                    segments.put(segment);
                }
            }
            result.put("segments", segments);
            AppLog.i(TAG, "ts-timeline verdict=" + result.getString("verdict")
                    + " durationUs=" + result.getLong("durationUs")
                    + " segments=" + segments.length() + " size=" + file.length());
            call.resolve(result);
        } catch (Exception e) {
            AppLog.w(TAG, "ts-timeline failed", e);
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "timeline scan failed: " + e.getMessage());
        }
    }

    private void runTsScan(File file, PluginCall call) {
        final int[] candidates = {188, 192};
        JSObject result = new JSObject();
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "r")) {
            long size = raf.length();
            result.put("fileSize", size);
            int probeLen = (int) Math.min(size, 2L * 1024 * 1024);
            byte[] probe = new byte[probeLen];
            raf.readFully(probe);

            // 对齐起点：前 8KB 内第一个「连续 5 包同步」的 0x47（干净文件即 0）
            int start = -1;
            int startPacket = 188;
            int scanLimit = Math.min(probeLen - 5 * 192, 8192);
            outer:
            for (int i = 0; i <= Math.max(scanLimit, 0); i++) {
                if (probe[i] != 0x47) continue;
                for (int ps : candidates) {
                    int hits = 0;
                    for (int k = 0; k < 5; k++) {
                        long idx = (long) i + (long) k * ps;
                        if (idx < probeLen && probe[(int) idx] == 0x47) hits++;
                    }
                    if (hits == 5) {
                        start = i;
                        startPacket = ps;
                        break outer;
                    }
                }
            }
            if (start < 0) {
                result.put("ok", false);
                result.put("verdict", "not-ts");
                result.put("packetSize", 0);
                result.put("alignedStart", -1);
                result.put("totalPackets", 0);
                result.put("badPackets", 0);
                result.put("firstBadOffset", -1);
                result.put("tailBytes", size);
                call.resolve(result);
                return;
            }

            // 包长择优：probe 段（起点起）同步命中率高者胜出，起点探测结果作首选
            int packetSize = startPacket;
            double bestRatio = -1;
            for (int ps : candidates) {
                int total = 0;
                int hits = 0;
                for (long p = start; p < probeLen; p += ps) {
                    total++;
                    if (probe[(int) p] == 0x47) hits++;
                }
                double ratio = total == 0 ? 0 : (double) hits / total;
                if (ratio > bestRatio) {
                    bestRatio = ratio;
                    packetSize = ps;
                }
            }

            // 全量扫描：分块读，逐包查同步字节
            long checked = 0;
            long bad = 0;
            long firstBad = -1;
            int blockSize = packetSize * 512;
            byte[] block = new byte[blockSize];
            long pos = start;
            while (pos + packetSize <= size) {
                int n = (int) Math.min(blockSize, size - pos);
                n -= n % packetSize;
                if (n <= 0) break;
                raf.seek(pos);
                raf.readFully(block, 0, n);
                for (int i = 0; i + packetSize <= n; i += packetSize) {
                    checked++;
                    if (block[i] != 0x47) {
                        bad++;
                        if (firstBad < 0) firstBad = pos + i;
                    }
                }
                pos += n;
            }
            long tail = size - pos;
            String verdict;
            if (bad > 0) verdict = "corrupt";
            else if (tail != 0) verdict = "truncated";
            else if (start != 0) verdict = "prefix";
            else verdict = "ok";
            result.put("ok", "ok".equals(verdict));
            result.put("verdict", verdict);
            result.put("packetSize", packetSize);
            result.put("alignedStart", start);
            result.put("totalPackets", checked);
            result.put("badPackets", bad);
            result.put("firstBadOffset", firstBad);
            result.put("tailBytes", tail);
            AppLog.i(TAG, "ts-scan verdict=" + verdict + " bad=" + bad + "/" + checked
                    + " firstBad=" + firstBad + " tail=" + tail + " size=" + size);
            call.resolve(result);
        } catch (Exception e) {
            AppLog.w(TAG, "ts-scan failed", e);
            reject(call, MediaRemuxer.CODE_INVALID_INPUT, "scan failed: " + e.getMessage());
        }
    }

    // ========== 路径安全 / 清理 ==========

    /**
     * 把 `Directory.Data` 相对路径解析为 File，并拒绝越界：空串、绝对路径、
     * `..` 段、规范化后跳出数据目录的路径（§8.3.7）。
     */
    private File resolveInData(File root, String relativePath) {
        String value = relativePath.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("empty-path");
        if (value.startsWith("/") || value.startsWith("\\") || value.matches("^[A-Za-z]:.*")) {
            throw new IllegalArgumentException("absolute-path");
        }
        for (String segment : value.split("[/\\\\]")) {
            if ("..".equals(segment)) throw new IllegalArgumentException("path-traversal");
        }
        File target = new File(root, value);
        try {
            String rootCanonical = root.getCanonicalPath();
            String targetCanonical = target.getCanonicalPath();
            if (!targetCanonical.equals(rootCanonical)
                    && !targetCanonical.startsWith(rootCanonical + File.separator)) {
                throw new IllegalArgumentException("path-escape");
            }
        } catch (IOException e) {
            throw new IllegalArgumentException("path-invalid");
        }
        return target;
    }

    /** 启动清理 `downloads/**&#47;*.mp4.part`（深度有上限，避免遍历失控） */
    private void cleanupStaleParts() {
        File root = new File(getContext().getFilesDir(), DATA_RELATIVE_ROOT);
        if (!root.isDirectory()) return;
        int removed = sweepStaleParts(root, 0);
        if (removed > 0) {
            AppLog.i(TAG, "cleaned stale remux parts: " + removed);
        }
    }

    private int sweepStaleParts(File dir, int depth) {
        int removed = 0;
        File[] children = dir.listFiles();
        if (children == null) return 0;
        for (File child : children) {
            if (child.isDirectory()) {
                if (depth < CLEANUP_MAX_DEPTH) removed += sweepStaleParts(child, depth + 1);
                continue;
            }
            if (child.getName().endsWith(REMUX_PART_SUFFIX) && MediaRemuxer.deleteQuietly(child)) {
                removed++;
            }
        }
        return removed;
    }

    // ========== 工具 ==========

    /** 后处理计数 +1 并拉起前台服务（配对使用 {@link #endPostprocess()}） */
    private void beginPostprocess() {
        openPostprocess.incrementAndGet();
        DownloadService.beginPostprocess(getContext());
    }

    /** 后处理计数 -1；已归零时不重复递减，避免插件销毁兜底后出现负数 */
    private void endPostprocess() {
        int previous = openPostprocess.getAndUpdate(value -> value > 0 ? value - 1 : 0);
        if (previous > 0) {
            DownloadService.endPostprocess(getContext());
        }
    }

    private static void reject(PluginCall call, String code, String detail) {
        AppLog.w(TAG, "remux rejected: " + code + " (" + detail + ")");
        call.reject(code + ": " + detail);
    }

    private static String canonicalOf(File file) {
        try {
            return file.getCanonicalPath();
        } catch (IOException e) {
            return file.getAbsolutePath();
        }
    }

    private static String trimToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String safe(String value) {
        return value != null ? value : "-";
    }

    /** 可选整数参数：缺失取默认，越界钳到端点（抽帧的尺寸/质量不必因为传错就失败） */
    private static int clamp(Integer value, int fallback, int min, int max) {
        if (value == null) return fallback;
        return Math.min(max, Math.max(min, value));
    }

    /** 一次转封装的登记项（含取消位）；只在 plugin 内部流转 */
    private static final class Job {
        final String key;
        final String taskId;
        final File input;
        final File output;
        final String inputPath;
        final String outputPath;
        final boolean deleteInput;
        final long timeoutMs;
        final AtomicBoolean canceled = new AtomicBoolean(false);

        Job(String key, String taskId, File input, File output, String inputPath, String outputPath,
            boolean deleteInput, long timeoutMs) {
            this.key = key;
            this.taskId = taskId;
            this.input = input;
            this.output = output;
            this.inputPath = inputPath;
            this.outputPath = outputPath;
            this.deleteInput = deleteInput;
            this.timeoutMs = timeoutMs;
        }
    }
}
