/**
 * 导入诊断服务（EXT-08）
 *
 * 职责边界（与 EXT-01 的健康中心一致）：
 * 1. **纯计算口径**：失败分类、分类聚合、存活源统计、jar 下载耗时估算、
 *    诊断报告结构与序列化——全部无副作用，便于单测；
 * 2. **导出能力**：失败报告 JSON（Blob + `URL.createObjectURL` + `<a download>`），
 *    与备份导出（`BackupView`）同一套落盘口径：延迟 60s 再回收 ObjectURL；
 * 3. **jar 探测编排**：包一层 `jarProbe.probeJarUrls`，把结果规范化成
 *    `JarProbeSummary[]` 并回报进度。
 *
 * 不做的事：
 * - 不 import `importService`（避免循环依赖），导入编排在 `importService.importWithDiagnostic`；
 * - 不直接读写 IndexedDB（源列表由调用方传入，与 UI 展示同一份数据）；
 * - 不定义新的接口契约（`ImportPreview` / `ImportResult` 字段冻结，诊断结构是本模块内部类型）。
 */
import {
  FAILURE_REASON_META,
  isFailureHealth,
  summarizeSources,
  type HealthCenterSummary,
} from '@/services/healthCenterService';
import {
  JAR_CHECK_CONCURRENCY,
  probeJarUrls,
  type JarProbeProgress,
  type JarProbeResult,
  type JarVerdict,
} from '@/services/jarProbe';
import type {
  ErrorCode,
  ImportPreview,
  ImportPreviewEntry,
  ImportResult,
  Source,
} from '@/types';

/* ---------- 阶段 ---------- */

/** 导入诊断阶段（顺序即视图步骤条顺序） */
export type ImportDiagnosticStage = 'idle' | 'parse' | 'probe' | 'import' | 'done';

export interface ImportDiagnosticStageMeta {
  stage: Exclude<ImportDiagnosticStage, 'idle'>;
  label: string;
  description: string;
}

/** 视图步骤条口径：解析订阅 → 探测 jar → 写入源 → 完成 */
export const IMPORT_DIAGNOSTIC_STAGES: readonly ImportDiagnosticStageMeta[] = [
  { stage: 'parse', label: '解析订阅', description: '拉取订阅内容并解析源列表' },
  { stage: 'probe', label: '探测 jar', description: 'HEAD 探测爬虫 jar 是否可下载' },
  { stage: 'import', label: '写入源', description: '按去重策略写入本地源表' },
  { stage: 'done', label: '完成', description: '生成诊断报告与存活统计' },
];

/** 阶段在步骤条中的下标；`idle` / 未知返回 -1 */
export function stageIndexOf(stage: ImportDiagnosticStage): number {
  return IMPORT_DIAGNOSTIC_STAGES.findIndex((item) => item.stage === stage);
}

/** 阶段是否已走完（用于步骤条样式判定） */
export function isStageReached(current: ImportDiagnosticStage, stage: ImportDiagnosticStage): boolean {
  const currentIndex = stageIndexOf(current);
  const targetIndex = stageIndexOf(stage);
  if (currentIndex < 0 || targetIndex < 0) return false;
  return currentIndex >= targetIndex;
}

/** 单次进度回报（视图据此渲染步骤条与实时列表） */
export interface ImportDiagnosticProgress {
  stage: ImportDiagnosticStage;
  label: string;
  done: number;
  total: number;
  /** 解析完成后可拿到预览（供视图实时渲染每个源的状态）；未解析到为 null */
  preview?: ImportPreview | null;
  /** 当前探测的 jar 地址；非探测阶段为 null */
  jarUrl?: string | null;
}

/* ---------- jar 探测结果投影 ---------- */

/** 一次 jar 探测的展示投影（含 EXT-08 新增的大小 / 延迟字段） */
export interface JarProbeSummary {
  jarUrl: string;
  verdict: JarVerdict;
  detail: string | null;
  errorCode: ErrorCode | null;
  httpStatus: number | null;
  contentLength: number | null;
  latencyMs: number;
  viaMirror: string | null;
}

export function jarProbeSummaryOf(jarUrl: string, result: JarProbeResult): JarProbeSummary {
  return {
    jarUrl,
    verdict: result.verdict,
    detail: result.detail ?? null,
    errorCode: result.errorCode,
    httpStatus: result.httpStatus,
    contentLength: result.contentLength,
    latencyMs: Number.isFinite(result.latencyMs) ? Math.max(0, Math.round(result.latencyMs)) : 0,
    viaMirror: result.viaMirror,
  };
}

/** Map → 数组（按 jarUrl 升序，保证报告稳定可比对） */
export function toJarProbeSummaries(
  results: ReadonlyMap<string, JarProbeResult>,
): JarProbeSummary[] {
  return [...results.entries()]
    .map(([jarUrl, result]) => jarProbeSummaryOf(jarUrl, result))
    .sort((a, b) => (a.jarUrl < b.jarUrl ? -1 : a.jarUrl > b.jarUrl ? 1 : 0));
}

/** 爬虫 jar 条目取 jar 地址；非 jar 爬虫 / 缺失 / 非法返回 null */
export function jarUrlOfEntry(entry: ImportPreviewEntry): string | null {
  if (entry.type !== 'spider' || !entry.valid || entry.normalized === null) return null;
  const ext = entry.normalized.ext as { kind?: unknown; jarUrl?: unknown } | null;
  if (!ext || ext.kind !== 'jar' || typeof ext.jarUrl !== 'string') return null;
  const jarUrl = ext.jarUrl.trim();
  return jarUrl.length > 0 ? jarUrl : null;
}

/** 预览里所有可探测的 jar 地址（去重，保持首次出现顺序） */
export function collectJarTargets(preview: ImportPreview): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const entry of preview.entries) {
    const jarUrl = jarUrlOfEntry(entry);
    if (jarUrl === null || seen.has(jarUrl)) continue;
    seen.add(jarUrl);
    targets.push(jarUrl);
  }
  return targets;
}

/** 并发探测一批 jar，结果规范化并回报进度（取消时返回已完成部分） */
export async function diagnoseJarTargets(
  jarUrls: readonly string[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: JarProbeProgress) => void;
  } = {},
): Promise<JarProbeSummary[]> {
  if (jarUrls.length === 0) return [];
  const results = await probeJarUrls([...jarUrls], options.signal, options.onProgress);
  return toJarProbeSummaries(results);
}

/* ---------- 失败分类 ---------- */

/**
 * 失败原因分类。
 * 前四类与 `healthCenterService.FailureReason` 同名同义（源体检查出的健康失败）；
 * `jar_missing` / `jar_unreachable` / `invalid_config` / `duplicate` 是导入阶段特有原因。
 */
export type FailureCategory =
  | 'jar_missing'
  | 'jar_unreachable'
  | 'timeout'
  | 'unreachable'
  | 'bad_config'
  | 'auth_failed'
  | 'invalid_config'
  | 'duplicate'
  | 'unknown';

/** 固定顺序（并列时保持稳定排序） */
export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  'jar_missing',
  'jar_unreachable',
  'timeout',
  'unreachable',
  'bad_config',
  'auth_failed',
  'invalid_config',
  'duplicate',
  'unknown',
];

export interface FailureCategoryMeta {
  label: string;
  /** 处置建议（报告与视图共用，禁止各处自造文案） */
  hint: string;
  /** 是否值得重试（报告给出「重试建议」时用） */
  retryable: boolean;
}

/**
 * 分类文案与处置建议。
 * 与体检重合的四类**逐字复用** `FAILURE_REASON_META`，避免同一状态两种叫法。
 */
export const FAILURE_CATEGORY_META: Record<FailureCategory, FailureCategoryMeta> = {
  jar_missing: {
    label: 'jar 缺失',
    hint: '爬虫条目未提供可用的 jar 地址，需换订阅或手工补全配置',
    retryable: false,
  },
  jar_unreachable: {
    label: 'jar 不可达',
    hint: 'jar 下载失败（常见 403 / 域名失效），建议换可用订阅或镜像源',
    retryable: true,
  },
  timeout: { ...FAILURE_REASON_META.timeout, retryable: true },
  unreachable: { ...FAILURE_REASON_META.unreachable, retryable: false },
  bad_config: { ...FAILURE_REASON_META.bad_config, retryable: false },
  auth_failed: { ...FAILURE_REASON_META.auth_failed, retryable: false },
  invalid_config: {
    label: '配置无效',
    hint: '订阅条目缺少必填字段或字段非法，无法导入，需修订阅',
    retryable: false,
  },
  duplicate: {
    label: '重复跳过',
    hint: '已存在同名源，按「跳过」策略未写入；如需更新请选「覆盖」',
    retryable: false,
  },
  unknown: {
    label: '未知原因',
    hint: '未归类的失败，细节见错误码与明细',
    retryable: true,
  },
};

export interface FailureBucket {
  reason: FailureCategory;
  label: string;
  hint: string;
  count: number;
  /** 占失败条目总数的比例 0~1 */
  ratio: number;
  /** 展示用百分比（四舍五入取整） */
  percent: number;
}

/** 单条失败明细（报告的核心内容） */
export interface ImportFailureItem {
  /** 条目 key 或源 key（同一次导入内唯一，用于去重） */
  key: string;
  name: string;
  type: string;
  baseUrl: string;
  jarUrl: string | null;
  reason: FailureCategory;
  label: string;
  errorCode: ErrorCode | null;
  /** 可读明细：HTTP 状态 / 解析错误 / 健康判定 */
  detail: string;
  /** 重试建议（来自 `FAILURE_CATEGORY_META.hint`，jar 403 另有专门文案） */
  suggestion: string;
  retryable: boolean;
}

/** 条目的失败归类；不是失败返回 null */
export function classifyEntryFailure(
  entry: ImportPreviewEntry,
  probe: JarProbeSummary | null,
): FailureCategory | null {
  if (!entry.valid || entry.normalized === null) {
    // 解析器把 jar 相关问题统一标在 `field === 'jar'`，据此把爬虫条目精确归到 jar 缺失
    if (entry.issues.some((issue) => issue.field === 'jar')) return 'jar_missing';
    return 'invalid_config';
  }
  if (jarUrlOfEntry(entry) !== null && probe !== null && probe.verdict === 'dead') {
    return 'jar_unreachable';
  }
  return null;
}

/** jar 不可达的具体建议：带状态码时比通用文案更可操作 */
export function jarSuggestionOf(probe: JarProbeSummary | null): string {
  if (probe === null) return FAILURE_CATEGORY_META.jar_unreachable.hint;
  if (probe.httpStatus === 403) return 'jar 返回 403（源站拒绝访问），建议更换订阅或使用镜像地址';
  if (probe.httpStatus === 404) return 'jar 返回 404（文件已删除），该订阅已失效，建议更换订阅';
  if (probe.detail !== null) return `jar 探测失败：${probe.detail}；建议更换订阅或镜像地址`;
  return FAILURE_CATEGORY_META.jar_unreachable.hint;
}

/** jar 不可达的明细：优先用探测 detail，其次 HTTP 状态码（已含同一状态码时不重复拼） */
function jarFailureDetail(probe: JarProbeSummary | null): string {
  if (probe === null) return '未完成 jar 探测';
  const parts: string[] = [];
  const hasDetail = typeof probe.detail === 'string' && probe.detail.length > 0;
  if (hasDetail) parts.push(probe.detail as string);
  if (probe.httpStatus !== null && !(hasDetail && (probe.detail as string).includes(`HTTP ${probe.httpStatus}`))) {
    parts.push(`HTTP ${probe.httpStatus}`);
  }
  return parts.length > 0 ? parts.join('；') : 'jar 探测判定为不可达';
}

/** 条目首条 error 级 issue 文案（用于明细） */
function firstErrorOf(entry: ImportPreviewEntry): string {
  const error = entry.issues.find((issue) => issue.level === 'error' && issue.message.length > 0);
  if (error) return error.message;
  const any = entry.issues.find((issue) => issue.message.length > 0);
  return any?.message ?? '订阅条目缺少必填字段';
}

export interface FailureItemsInput {
  preview: ImportPreview | null;
  probes: readonly JarProbeSummary[];
  /** 导入结果（用于判定「重复跳过」）；未导入传 null */
  importResult?: ImportResult | null;
  /** 去重策略：只有 `skip` 才会产生「重复跳过」失败项 */
  duplicateStrategy?: 'skip' | 'overwrite' | 'keep-both';
  /** 全部源（含本次导入后的健康状态）；不传则不追加健康失败项 */
  sources?: readonly Source[];
  /** 订阅来源标识；为空时不追加健康失败项（无法界定归属） */
  subscriptionId?: string | null;
}

/**
 * 汇总一次导入的失败明细，两个来源：
 * ① 预览条目：jar 缺失 / jar 不可达 / 配置无效 / 重复跳过；
 * ② 源健康（仅 `subscriptionId` 非空时）：timeout / unreachable / bad_config / auth_failed，
 *    覆盖「覆盖导入后仍然是死源」的场景。
 *
 * 去重口径：同 key 只保留第一条（预览侧优先，原因更具体）。
 */
export function buildFailureItems(input: FailureItemsInput): ImportFailureItem[] {
  const probeByUrl = new Map(input.probes.map((probe) => [probe.jarUrl, probe]));
  const duplicateStrategy = input.duplicateStrategy ?? 'skip';
  const items: ImportFailureItem[] = [];
  const seen = new Set<string>();

  for (const entry of input.preview?.entries ?? []) {
    const jarUrl = jarUrlOfEntry(entry);
    const probe = jarUrl === null ? null : (probeByUrl.get(jarUrl) ?? null);
    const classified = classifyEntryFailure(entry, probe);
    const duplicateSkipped =
      classified === null &&
      duplicateStrategy === 'skip' &&
      input.importResult !== null &&
      input.importResult !== undefined &&
      entry.duplicateOf !== null;
    if (classified === null && !duplicateSkipped) continue;

    const reason: FailureCategory = classified ?? 'duplicate';
    const meta = FAILURE_CATEGORY_META[reason];
    const key = entry.normalized?.key ?? entry.key;
    if (seen.has(key)) continue;
    seen.add(key);

    const detail =
      reason === 'jar_missing'
        ? firstErrorOf(entry)
        : reason === 'jar_unreachable'
          ? jarFailureDetail(probe)
          : reason === 'duplicate'
            ? '与已有源 key/名称重复，按跳过策略未写入'
            : firstErrorOf(entry);

    items.push({
      key,
      name: entry.name.length > 0 ? entry.name : entry.key,
      type: entry.type,
      baseUrl: entry.baseUrl,
      jarUrl,
      reason,
      label: meta.label,
      errorCode: probe?.errorCode ?? null,
      detail,
      suggestion: reason === 'jar_unreachable' ? jarSuggestionOf(probe) : meta.hint,
      retryable: meta.retryable,
    });
  }

  const subscriptionId = input.subscriptionId ?? null;
  if (subscriptionId !== null) {
    for (const source of input.sources ?? []) {
      if (source.subscriptionId !== subscriptionId) continue;
      if (!isFailureHealth(source.health)) continue;
      if (seen.has(source.key)) continue;
      seen.add(source.key);
      const meta = FAILURE_CATEGORY_META[source.health];
      const ext = source.ext as { jarUrl?: unknown } | null;
      items.push({
        key: source.key,
        name: source.name,
        type: source.type,
        baseUrl: source.baseUrl,
        jarUrl: typeof ext?.jarUrl === 'string' && ext.jarUrl.length > 0 ? ext.jarUrl : null,
        reason: source.health,
        label: meta.label,
        errorCode: source.lastErrorCode,
        detail: `健康检查判定为「${meta.label}」`,
        suggestion: meta.hint,
        retryable: meta.retryable,
      });
    }
  }

  return items;
}

/** 按原因聚合失败明细（只含计数 > 0 的原因，按数量降序，并列按固定顺序） */
export function bucketFailures(items: readonly ImportFailureItem[]): FailureBucket[] {
  const counts = new Map<FailureCategory, number>();
  for (const item of items) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  const total = items.length;
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => {
      const meta = FAILURE_CATEGORY_META[reason];
      const ratio = total === 0 ? 0 : count / total;
      return {
        reason,
        label: meta.label,
        hint: meta.hint,
        count,
        ratio,
        percent: Math.round(ratio * 100),
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return FAILURE_CATEGORIES.indexOf(a.reason) - FAILURE_CATEGORIES.indexOf(b.reason);
    });
}

/* ---------- 存活源统计 ---------- */

export interface AliveSourceStats extends HealthCenterSummary {
  /** 存活 = 健康（口径单一真值：`ok`） */
  alive: number;
  /** 存活率百分比（四舍五入取整）；total=0 时为 0 */
  alivePercent: number;
}

/** 存活统计（复用健康中心汇总口径，避免两处数字对不上） */
export function summarizeAliveSources(sources: readonly Source[]): AliveSourceStats {
  const summary = summarizeSources(sources);
  return {
    ...summary,
    alive: summary.healthy,
    alivePercent: summary.total === 0 ? 0 : Math.round((summary.healthy / summary.total) * 100),
  };
}

/* ---------- jar 下载耗时估算 ---------- */

/** 典型 TVBox jar 体积（2~4MB），HEAD 无 content-length 时按此保守估算 */
export const DEFAULT_JAR_BYTES = 3 * 1024 * 1024;
/** 估算折算的原生侧并行下载路数（原生按需加载，实际接近串行，取 2 作为保守上界） */
export const JAR_ESTIMATE_CONCURRENCY = 2;

export interface JarTimeEstimate {
  /** 需要下载的 jar 数量（只算可达的） */
  jarCount: number;
  /** 已知大小合计（字节） */
  bytes: number;
  /** 其中按默认体积推算的 jar 数 */
  assumedCount: number;
  /** 估算吞吐（KB/s） */
  throughputKbps: number;
  /** 探测平均往返延迟（毫秒） */
  avgLatencyMs: number;
  /** 估算总耗时（秒，已折算并发与探测开销） */
  seconds: number;
  /** true = 全部 jar 返回了 content-length，估算不含默认体积假设 */
  measured: boolean;
}

/** 按探测延迟推断吞吐档位（档位是经验值，量级正确即可，不追求精确测速） */
export function assumedThroughputKbps(avgLatencyMs: number): number {
  if (!Number.isFinite(avgLatencyMs) || avgLatencyMs <= 0) return 400;
  if (avgLatencyMs < 150) return 1500;
  if (avgLatencyMs < 400) return 800;
  if (avgLatencyMs < 900) return 400;
  return 180;
}

/**
 * 估算 jar 下载耗时；没有可达 jar 返回 null（视图隐藏估算卡）。
 * 未知体积按 `DEFAULT_JAR_BYTES` 计入，并在 `assumedCount` 中如实标注。
 */
export function estimateJarDownload(probes: readonly JarProbeSummary[]): JarTimeEstimate | null {
  const alive = probes.filter((probe) => probe.verdict === 'ok');
  if (alive.length === 0) return null;

  const bytes = alive.reduce((sum, probe) => sum + (probe.contentLength ?? DEFAULT_JAR_BYTES), 0);
  const assumedCount = alive.filter((probe) => probe.contentLength === null).length;
  const avgLatencyMs =
    alive.reduce((sum, probe) => sum + (Number.isFinite(probe.latencyMs) ? probe.latencyMs : 0), 0) /
    alive.length;
  const throughputKbps = assumedThroughputKbps(avgLatencyMs);
  const downloadSeconds = bytes / (throughputKbps * 1024) / JAR_ESTIMATE_CONCURRENCY;
  const probeSeconds = (alive.length * Math.max(avgLatencyMs, 60)) / JAR_CHECK_CONCURRENCY / 1000;
  return {
    jarCount: alive.length,
    bytes,
    assumedCount,
    throughputKbps,
    avgLatencyMs: Math.round(avgLatencyMs),
    seconds: Math.max(1, Math.round(downloadSeconds + probeSeconds)),
    measured: assumedCount === 0,
  };
}

/** 字节数 → 人类可读（1 位小数，KB 起） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 秒数 → 「不到 1 秒 / n 秒 / m 分 s 秒」 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '不到 1 秒';
  if (seconds < 1) return '不到 1 秒';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} 秒`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

/** 探测结果的告警文案（死 jar / 未决 jar 各一条；无则空数组） */
export function probeWarnings(probes: readonly JarProbeSummary[]): string[] {
  const warnings: string[] = [];
  const dead = probes.filter((probe) => probe.verdict === 'dead');
  const uncertain = probes.filter((probe) => probe.verdict === 'unknown');
  if (dead.length > 0) {
    const sample = dead[0];
    const detail = sample?.detail ?? (sample?.httpStatus != null ? `HTTP ${sample.httpStatus}` : '');
    warnings.push(
      `${dead.length} 个 jar 不可达${detail.length > 0 ? `（如 ${detail}）` : ''}，相关源已默认取消勾选`,
    );
  }
  if (uncertain.length > 0) {
    warnings.push(
      `${uncertain.length} 个 jar 探测未决（超时或服务器不支持 HEAD），未据此判死，导入后可复检`,
    );
  }
  return warnings;
}

/* ---------- 诊断报告 ---------- */

export const FAILURE_REPORT_VERSION = 1;

export interface ImportFailureReport {
  version: number;
  generatedAt: number;
  /** 订阅地址；文件导入为 null（本任务只覆盖 URL 导入） */
  subscriptionUrl: string | null;
  subscriptionName: string | null;
  summary: {
    /** 预览条目总数 */
    total: number;
    success: number;
    /** 失败明细条数（= failures.length） */
    failed: number;
    skipped: number;
    /** jar 探测判定不可达的数量 */
    jarDead: number;
    /** 本次诊断耗时（毫秒） */
    durationMs: number;
  };
  alive: AliveSourceStats;
  buckets: FailureBucket[];
  failures: ImportFailureItem[];
  probes: JarProbeSummary[];
  warnings: string[];
}

export interface FailureReportInput {
  subscriptionUrl: string | null;
  subscriptionName?: string | null;
  preview: ImportPreview | null;
  importResult?: ImportResult | null;
  probes?: readonly JarProbeSummary[];
  failures: readonly ImportFailureItem[];
  buckets?: readonly FailureBucket[];
  alive: AliveSourceStats;
  warnings?: readonly string[];
  startedAt: number;
  finishedAt?: number;
  now?: number;
}

/** 组装失败报告（纯函数；`generatedAt` 可注入，便于测试断言文件名与内容） */
export function buildFailureReport(input: FailureReportInput): ImportFailureReport {
  const generatedAt = input.now ?? Date.now();
  const failures = [...input.failures];
  const finish = input.finishedAt ?? generatedAt;
  return {
    version: FAILURE_REPORT_VERSION,
    generatedAt,
    subscriptionUrl: input.subscriptionUrl,
    subscriptionName: input.subscriptionName ?? input.preview?.name ?? null,
    summary: {
      total: input.preview?.total ?? 0,
      success: input.importResult?.success ?? 0,
      failed: failures.length,
      skipped: input.importResult?.skipped ?? 0,
      jarDead: (input.probes ?? []).filter((probe) => probe.verdict === 'dead').length,
      durationMs: Math.max(0, finish - input.startedAt),
    },
    alive: input.alive,
    buckets: [...(input.buckets ?? bucketFailures(failures))],
    failures,
    probes: [...(input.probes ?? [])],
    warnings: [...(input.warnings ?? [])],
  };
}

/** 报告 → JSON 字符串（2 空格缩进，便于用户直接阅读/贴 issue） */
export function serializeFailureReport(report: ImportFailureReport): string {
  return JSON.stringify(report, null, 2);
}

/** 报告 → Blob（MIME 固定 `application/json`，与备份导出一致） */
export function failureReportBlob(report: ImportFailureReport): Blob {
  return new Blob([serializeFailureReport(report)], { type: 'application/json' });
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 文件名：`import-diagnostic-YYYYMMDD-HHmm.json`（本地时区） */
export function failureReportFileName(generatedAt: number): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return 'import-diagnostic.json';
  const day = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const time = `${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  return `import-diagnostic-${day}-${time}.json`;
}

/**
 * 触发失败报告下载（Web / WebView）。
 *
 * 与 `BackupView.triggerDownload` 同一套口径：
 * - Blob MIME 兜底为 `application/json`；
 * - `<a download>` 必须挂进文档才会被浏览器接管；
 * - **不能立刻 revoke**：下载异步读 Blob，过早回收会得到空文件，延后 60s。
 *
 * @returns 是否真的触发了点击（失败由调用方提示，不伪造成功）
 */
export function downloadFailureReport(
  report: ImportFailureReport,
  fileName: string = failureReportFileName(report.generatedAt),
): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;

  const href = URL.createObjectURL(failureReportBlob(report));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } catch {
    if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    URL.revokeObjectURL(href);
    return false;
  }
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(href);
    }, 60_000);
  }
  return true;
}

/* ---------- 自动禁用口径 ---------- */

/** 连续失败达到阈值才自动禁用（与 FR-51 一致，阈值由 `shared/constants` 单一真值提供） */
export function shouldAutoDisable(streak: number, threshold: number): boolean {
  return Number.isFinite(streak) && Number.isFinite(threshold) && threshold > 0 && streak >= threshold;
}
