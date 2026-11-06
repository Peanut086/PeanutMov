/**
 * 导入服务（API-05）
 *
 * - 预览：URL（10s 超时 / 2MB 上限）与文件（.json / 2MB / 非空）；
 * - 提交：单事务写入全部源，失败回滚；支持 skip / overwrite / keep-both。
 *
 * `ImportResult` 口径（CHG-03，AC-13）：
 * - `success`：本次真正写入的条目数（含 overwrite 更新、keep-both 新建）；
 * - `skipped`：**未被写入**的条目数，包含两类：
 *   ① 预览阶段即判定无效（`!valid` 或 `normalized === null`）的条目；
 *   ② 与已有源重复且 `onDuplicate === 'skip'` 的条目；
 * - `failed`：逐条写入失败数（单事务模式下写入失败会整体抛错，正常恒为 0）；
 * - `issues`：无效条目以一条汇总 `info`（`SKIPPED_INVALID`）表达，重复条目逐条
 *   `SKIPPED_DUPLICATE` 表达。
 *
 * 不变量：`success + skipped + failed + 未勾选的合法条目 = preview.total`。
 * 即"预览共 N 个源 / 可导入 M 个"与提交结果可对账（M = success + 重复但被覆盖/保留的条目）。
 * `skipped` 不包含"合法但用户未勾选"的条目——那是用户主动排除，不是跳过。
 *
 * EXT-08（导入诊断）在此之上新增两个入口，均不改既有 `previewFromUrl / commit` 语义：
 * - `prefetchImport`：拉取解析 + jar 可达性预取 + 下载耗时估算（只读，不写库）；
 * - `importWithDiagnostic`：带诊断的导入（复用预取结果 → 只写勾选条目 → 失败分类 → 报告）。
 */
import { withTx } from '@/db/index';
import { sourceRepo, toStorableSource } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import {
  bucketFailures,
  buildFailureItems,
  buildFailureReport,
  collectJarTargets,
  diagnoseJarTargets,
  estimateJarDownload,
  IMPORT_DIAGNOSTIC_STAGES,
  jarUrlOfEntry,
  probeWarnings,
  summarizeAliveSources,
  toJarProbeSummaries,
  type AliveSourceStats,
  type ImportDiagnosticProgress,
  type ImportDiagnosticStage,
  type ImportFailureItem,
  type ImportFailureReport,
  type JarProbeSummary,
  type JarTimeEstimate,
} from '@/services/ImportDiagnosticService';
import { probeJarUrls } from '@/services/jarProbe';
import { subscriptionParser } from '@/services/subscriptionParser';
import { liveService } from '@/services/liveService';
import { extractTvboxLives } from '@/sources/live/liveParsers';
import {
  HTML_SNIFF_MAX_CANDIDATES,
  KV_KEY_IMPORT_RECORDS,
  MAX_SUBSCRIPTION_BYTES,
  TIMEOUT_SUBSCRIPTION_FETCH_MS,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { newId, nextKey } from '@/shared/id';
import { logger } from '@/shared/logger';
import { isValidHttpUrl } from '@/shared/url';
import { normalizeImportUrl } from '@/shared/urlNormalize';
import { crawl } from '@/sources/pipeline/scheduler';
import { detectCmsApiPayload, detectLiveList } from '@/sources/pipeline/detectors';
import type { HtmlLandingResult, SubscriptionText } from '@/sources/pipeline/parsers';
import { kvRepo } from '@/db/repositories/kvRepo';
import type {
  ImportCommitOptions,
  ImportIssue,
  ImportPreview,
  ImportPreviewEntry,
  ImportResult,
  Source,
} from '@/types';

export interface ImportService {
  previewFromUrl(
    url: string,
    signal?: AbortSignal,
    opts?: { jarPrecheck?: boolean },
  ): Promise<ImportPreview>;
  /** 多仓索引展开：拉取其中一个仓库地址的源列表 */
  previewFromRepo(repoUrl: string, signal?: AbortSignal): Promise<ImportPreview>;
  previewFromText(text: string, fileName: string): Promise<ImportPreview>;
  previewFromFile(file: File): Promise<ImportPreview>;
  commit(preview: ImportPreview, options: ImportCommitOptions): Promise<ImportResult>;
  refreshSubscription: typeof refreshSubscriptionImpl;
  /** EXT-08：只读预取（解析 + jar 探测 + 耗时估算），不写库 */
  prefetchImport(url: string, options?: ImportDiagnosticOptions): Promise<ImportDiagnosticPrefetch>;
  /** EXT-08：带诊断的导入（可复用预取结果；支持取消） */
  importWithDiagnostic(
    url: string,
    options?: ImportDiagnosticOptions,
  ): Promise<ImportDiagnosticResult>;
}

/* ---------- EXT-08：导入诊断 ---------- */

export interface ImportDiagnosticOptions {
  signal?: AbortSignal;
  /** 只导入命中的 key；不传 = 预览中「有效且默认勾选」的条目 */
  selectedKeys?: string[];
  /** 同名策略，默认 `skip`（与导入页一致） */
  onDuplicate?: ImportCommitOptions['onDuplicate'];
  /** 过程进度（阶段 + n/total + 解析后的预览） */
  onProgress?: (progress: ImportDiagnosticProgress) => void;
  /** 已预取的预览（含 jar 判定与勾选状态）：传入则跳过拉取与探测，避免二次网络开销 */
  preview?: ImportPreview;
  /** 与 `preview` 配套的 jar 探测结果；用于生成报告 */
  probes?: JarProbeSummary[];
  /** 导入后按「连续失败次数」自动禁用（默认 true，走 FR-51 同一口径） */
  autoDisable?: boolean;
  /** 是否探测 jar（默认 true） */
  jarProbe?: boolean;
}

export interface ImportDiagnosticPrefetch {
  subscriptionUrl: string;
  /** 已按 jar 判定回写 `selected / warning` 的预览 */
  preview: ImportPreview;
  probes: JarProbeSummary[];
  /** 可达 jar 的下载耗时估算；没有可达 jar 为 null */
  estimate: JarTimeEstimate | null;
  /** 死 jar / 未决 jar 的告警（导入前提前提示） */
  warnings: string[];
  startedAt: number;
  finishedAt: number;
}

export type ImportDiagnosticStatus = 'done' | 'canceled';

export interface ImportDiagnosticResult {
  status: ImportDiagnosticStatus;
  subscriptionUrl: string;
  preview: ImportPreview | null;
  probes: JarProbeSummary[];
  estimate: JarTimeEstimate | null;
  /** 取消时为 null（未写库） */
  import: ImportResult | null;
  failures: ImportFailureItem[];
  /** 失败报告（可随时导出；取消时也产出，便于留证） */
  report: ImportFailureReport;
  alive: AliveSourceStats;
  /** 本次导入后因连续失败被自动禁用的源数量 */
  autoDisabled: number;
  warnings: string[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** 取消时未处理的条目数（进度文案用） */
  pending: number;
}

const STAGE_LABELS = new Map<ImportDiagnosticStage, string>(
  IMPORT_DIAGNOSTIC_STAGES.map((meta) => [meta.stage, meta.label]),
);

function reportProgress(
  options: ImportDiagnosticOptions,
  stage: ImportDiagnosticStage,
  done: number,
  total: number,
  extra: { preview?: ImportPreview | null; jarUrl?: string | null } = {},
): void {
  if (!options.onProgress) return;
  options.onProgress({
    stage,
    label: STAGE_LABELS.get(stage) ?? '',
    done,
    total,
    preview: extra.preview ?? null,
    jarUrl: extra.jarUrl ?? null,
  });
}

export interface ImportRecord {
  url: string;
  name: string | null;
  importedAt: number;
  success: number;
}

async function readImportRecords(): Promise<ImportRecord[]> {
  const records = await kvRepo.get<ImportRecord[]>(KV_KEY_IMPORT_RECORDS);
  return Array.isArray(records) ? records : [];
}

async function appendImportRecord(record: ImportRecord): Promise<void> {
  const existing = await readImportRecords();
  const next = [record, ...existing.filter((item) => item.url !== record.url)].slice(0, 20);
  await kvRepo.set(KV_KEY_IMPORT_RECORDS, next);
}

/** 把"与现有源重复"的条目补上 `duplicateOf`（parser 只做同批去重） */
async function annotateDuplicates(preview: ImportPreview): Promise<ImportPreview> {
  const existing = await sourceRepo.list();
  const byKey = new Map(existing.map((source) => [source.key, source]));
  const byNameUrl = new Map(existing.map((source) => [`${source.name}::${source.baseUrl}`, source]));

  const entries = preview.entries.map((entry) => {
    if (!entry.valid || entry.normalized === null) return entry;
    const match =
      byKey.get(entry.normalized.key ?? entry.key) ??
      byNameUrl.get(`${entry.normalized.name}::${entry.normalized.baseUrl}`) ??
      null;
    if (!match) return entry;
    return { ...entry, duplicateOf: match.id };
  });
  return { ...preview, entries };
}

async function previewFromRaw(
  text: string,
  opts: { origin: 'url' | 'file'; sourceUrl?: string | null; fileName?: string | null },
  signal?: AbortSignal,
  precheckOpts?: { jarPrecheck?: boolean },
): Promise<ImportPreview> {
  const parsed = subscriptionParser.parse(text, opts);
  // CHG-13：顺带提取 TVBox lives[] 直播源（导入成功后由 UI 添加到直播页）
  const parsedPreview: ImportPreview = { ...parsed, lives: extractTvboxLives(text) };
  // v1.7/CHG-18：直播列表优先于多仓识别——m3u 的频道 URL 行会被 reposOf
  // 误判成「多仓索引」（逐行 URL 文本），必须先按直播列表定性再谈多仓。
  const isLiveList = detectLiveList(text) !== null;
  const base = isLiveList ? { ...parsedPreview, repos: [] } : parsedPreview;
  // v1.7/CHG-18：非订阅内容兜底建议（直播列表 / 单流 / CMS 采集接口）
  const preview = attachSuggestions(base, text, opts.sourceUrl ?? null);
  const annotated = await annotateDuplicates(preview);
  if (precheckOpts?.jarPrecheck === false) return annotated;
  return precheckSpiderJars(annotated, signal);
}

/* ---------- 爬虫 jar 预检（CHG-10；探测逻辑抽取至 jarProbe 供评测复用） ---------- */

/**
 * 把 jar 探测结论回写到预览：判死的条目取消默认勾选并追加警示。
 * 预览（CHG-10）与诊断预取（EXT-08）共用，保证两处「选不选」口径一致。
 * 幂等：已追加过同类警示的条目不再重复拼接（预取结果回传给导入时会再跑一次）。
 * 无判死条目时原样返回，避免无意义的对象重建。
 */
function applyJarSummaries(preview: ImportPreview, probes: readonly JarProbeSummary[]): ImportPreview {
  if (probes.length === 0) return preview;
  const byUrl = new Map(probes.map((probe) => [probe.jarUrl, probe]));
  let changed = false;
  const entries = preview.entries.map((entry) => {
    const jarUrl = jarUrlOfEntry(entry);
    if (jarUrl === null) return entry;
    const probe = byUrl.get(jarUrl);
    if (!probe || probe.verdict !== 'dead') return entry;
    if ((entry.warning ?? '').includes('jar 不可达（')) {
      // 已经标记过（同一份预览被重复诊断）：只兜底勾选状态，不重复拼文案
      if (!entry.selected) return entry;
      changed = true;
      return { ...entry, selected: false };
    }
    changed = true;
    return {
      ...entry,
      selected: false,
      // 文案被 `refreshSubscriptionImpl` 按「jar 不可达」聚合统计，改动需同步
      warning: [entry.warning, `jar 不可达（${probe.detail ?? '请求失败'}），导入后无法浏览`]
        .filter(Boolean)
        .join('；'),
    };
  });
  return changed ? { ...preview, entries } : preview;
}

/**
 * 并发 HEAD jar（同一 jar 地址共享结果），判死的条目取消默认勾选并追加警示。
 * 实测 4k.json 类订阅大半 jar 已 403 / 域名失效，预览时可见，导入后不再反复失败。
 */
async function precheckSpiderJars(preview: ImportPreview, signal?: AbortSignal): Promise<ImportPreview> {
  const targets = collectJarTargets(preview);
  if (targets.length === 0) return preview;
  const results = await probeJarUrls(targets, signal);
  return applyJarSummaries(preview, toJarProbeSummaries(results));
}

/* ---------- v1.7/CHG-18：URL 归一化变体 + 落地页嗅探拉取 ---------- */

type SubscriptionFetchValue = SubscriptionText | HtmlLandingResult;

export interface SubscriptionFetch {
  text: string;
  /** 响应是 HTML 落地页且嗅探到同域候选配置链接；其余为 null */
  htmlCandidates: string[] | null;
}

async function crawlSubscription(
  variantUrl: string,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<SubscriptionFetch> {
  const { value } = await crawl<SubscriptionFetchValue>({
    intent: 'subscription',
    url: variantUrl,
    signal,
    budgetMs,
    headers: { Accept: 'application/json, text/plain, */*' },
    maxBytes: MAX_SUBSCRIPTION_BYTES,
  });
  if ('kind' in value && value.kind === 'html-landing') {
    return { text: value.text, htmlCandidates: value.candidates };
  }
  return { text: value.text, htmlCandidates: null };
}

/** 网络类失败才继续换变体；HTTP 4xx/5xx / 格式错误说明资源本身有问题 */
function isRetryableVariantError(e: unknown): boolean {
  const code = e instanceof AppError ? e.code : null;
  return code === 'E_NETWORK' || code === 'E_TIMEOUT';
}

/**
 * 拉取订阅文本（默认 10s 预算 / 2MB 上限），URL 预览与多仓展开共用。
 *
 * v1.7/CHG-18 拉取顺序（全部共享同一预算）：
 *   ① 首选地址（GitHub raw 自带镜像回退；gh-proxy 前缀地址失败先剥前缀直连）
 *   ② `normalizeImportUrl` 变体（CDN 互换、重写后地址等）
 *
 * 走爬虫管道：指纹 + 规则决定"这是 JSON / 纯文本 URL 列表 / 直播列表 / HTML 落地页"，
 * 并按 BOM → header → 探测解码字符集（GBK 站点不再乱码）。
 * 失败时抛出带用户文案的 `AppError`（文案由规则里的解析器决定）。
 */
async function fetchSubscriptionText(
  url: string,
  signal?: AbortSignal,
  budgetOverrideMs?: number,
): Promise<SubscriptionFetch> {
  const trimmed = url.trim();
  if (!isValidHttpUrl(trimmed)) {
    throw new AppError('E_INVALID_INPUT', '订阅地址必须是 http(s):// 开头的合法地址');
  }

  const normalized = normalizeImportUrl(trimmed);
  const deadline = Date.now() + (budgetOverrideMs ?? TIMEOUT_SUBSCRIPTION_FETCH_MS);

  let lastError: unknown;
  try {
    const { value } = await withGithubMirrorFallback(
      normalized.url,
      (variantUrl) => crawlSubscription(variantUrl, signal, Math.max(2000, deadline - Date.now())),
      signal,
    );
    return value;
  } catch (e) {
    lastError = e;
    if (!isRetryableVariantError(e) || signal?.aborted) throw e;
  }

  for (const variant of normalized.variants) {
    if (signal?.aborted) throw lastError;
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    try {
      return await crawlSubscription(variant, signal, remaining);
    } catch (e) {
      if (!isRetryableVariantError(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

/** 把 URL 归一化提示追加为 info issue（不改预览结构） */
function withNotes(preview: ImportPreview, notes: string[]): ImportPreview {
  if (notes.length === 0) return preview;
  return {
    ...preview,
    globalIssues: [
      ...preview.globalIssues,
      ...notes.map((message) => ({ level: 'info' as const, code: 'URL_NORMALIZED', field: null, message })),
    ],
  };
}

/**
 * v1.7/CHG-18：内容不是普通订阅时给出可操作建议（纯函数，URL 与文件导入共用）。
 * 仅当没有可导入条目/仓库/直播时才兜底判定，payload 需要可寻址 URL
 * （文件/文本导入没有来源地址，不产建议——导出供单测直接覆盖 URL 路径）。
 */
export function attachSuggestions(preview: ImportPreview, text: string, payloadUrl: string | null): ImportPreview {
  if (payloadUrl === null) return preview;
  if (preview.entries.length > 0 || preview.repos.length > 0 || preview.lives.length > 0) return preview;
  if (preview.suggestions && preview.suggestions.length > 0) return preview;

  const live = detectLiveList(text);
  if (live) {
    return {
      ...preview,
      suggestions:
        live.kind === 'single-stream'
          ? [{ kind: 'single-stream', action: 'add-channel', payload: payloadUrl }]
          : [{ kind: 'live-list', action: 'add-live', payload: payloadUrl, channelCount: live.channelCount }],
    };
  }
  if (detectCmsApiPayload(text)) {
    return { ...preview, suggestions: [{ kind: 'cms-api', action: 'add-site', payload: payloadUrl }] };
  }
  return preview;
}

export const importService: ImportService = {
  async previewFromUrl(
    url: string,
    signal?: AbortSignal,
    opts?: { jarPrecheck?: boolean },
  ): Promise<ImportPreview> {
    const trimmed = url.trim();
    const normalized = normalizeImportUrl(trimmed);
    const fetched = await fetchSubscriptionText(trimmed, signal);

    // v1.7/CHG-18：落地页候选跟进——同域 ≤3 条，首个产出有效内容的胜出
    if (fetched.htmlCandidates !== null) {
      const candidates = fetched.htmlCandidates.slice(0, HTML_SNIFF_MAX_CANDIDATES);
      let lastError: unknown = new AppError(
        'E_UNSUPPORTED_FORMAT',
        '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截',
        { detail: 'HTML 落地页内未发现可用的配置链接', retryable: false },
      );
      for (const candidate of candidates) {
        try {
          const sub = await fetchSubscriptionText(candidate, signal);
          if (sub.htmlCandidates !== null) continue; // 候选又是落地页：不递归
          const preview = await previewFromRaw(sub.text, { origin: 'url', sourceUrl: trimmed }, signal, opts);
          if (preview.entries.length > 0 || preview.repos.length > 0 || preview.lives.length > 0) {
            return withNotes(preview, [
              `已从落地页发现的配置链接导入：${candidate}`,
              ...normalized.notes,
            ]);
          }
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    }

    const preview = await previewFromRaw(fetched.text, { origin: 'url', sourceUrl: trimmed }, signal, opts);
    return withNotes(preview, normalized.notes);
  },

  /** 展开多仓索引中的一个仓库地址，返回该仓库的源预览 */
  async previewFromRepo(repoUrl: string, signal?: AbortSignal): Promise<ImportPreview> {
    const fetched = await fetchSubscriptionText(repoUrl, signal);
    return previewFromRaw(fetched.text, { origin: 'url', sourceUrl: repoUrl.trim() }, signal);
  },

  async previewFromText(text: string, fileName: string): Promise<ImportPreview> {
    if (text.trim().length === 0) {
      throw new AppError('E_INVALID_INPUT', '文件内容为空');
    }
    return previewFromRaw(text, { origin: 'file', fileName });
  },

  async previewFromFile(file: File): Promise<ImportPreview> {
    if (!/\.json$/i.test(file.name)) {
      throw new AppError('E_INVALID_INPUT', '仅支持 JSON 文件');
    }
    if (file.size > MAX_SUBSCRIPTION_BYTES) {
      throw new AppError('E_INVALID_INPUT', '文件过大（上限 2MB）');
    }
    if (file.size === 0) {
      throw new AppError('E_INVALID_INPUT', '文件内容为空');
    }
    const text = await file.text();
    if (text.trim().length === 0) {
      throw new AppError('E_INVALID_INPUT', '文件内容为空');
    }
    return previewFromRaw(text, { origin: 'file', fileName: file.name });
  },

  refreshSubscription: refreshSubscriptionImpl,

  prefetchImport: prefetchImportImpl,
  importWithDiagnostic: importWithDiagnosticImpl,

  /**
   * 提交导入（单事务）。
   *
   * `selectedKeys` 语义（CHG-03）：
   * - **空数组 = 导入全部有效项**（等价于"全选"）；非空 = 仅导入 key 命中的条目。
   * - 该约定是给"程序化调用"用的便捷语义；UI 侧的"全选/全不选"必须自行区分：
   *   `ImportSubscriptionView` 在 `importableCount === 0` 时直接返回、按钮置灰，
   *   因此"一个都没勾选但存在有效项"不会走到这里被误当全量导入。新增调用方需遵守同一约束。
   * - 合法但未被勾选的条目既不计 `success` 也不计 `skipped`（用户主动排除，不是"跳过"）。
   *
   * `skipped` 口径见文件头注释：预览无效 + 重复源（skip 策略）。
   */
  async commit(preview: ImportPreview, options: ImportCommitOptions): Promise<ImportResult> {
    const selected = new Set(options.selectedKeys);
    const invalidEntries = preview.entries.filter((entry) => !entry.valid || entry.normalized === null);
    const candidates = preview.entries.filter((entry) => entry.valid && entry.normalized !== null);
    const chosen = selected.size === 0 ? candidates : candidates.filter((entry) => selected.has(entry.key));
    if (preview.globalIssues.some((item) => item.level === 'error')) {
      throw new AppError('E_INVALID_INPUT', '订阅存在全局错误，无法导入');
    }
    // CHG-11：新建源也归一到「订阅来源标识」（URL / 文件名）
    const subscriptionId = preview.sourceUrl ?? preview.fileName ?? null;

    const issues: ImportIssue[] = [];
    let skipped = 0;
    const toWrite: Source[] = [];
    const sourceIds: string[] = [];

    // ① 预览阶段即无效的条目：无法写入，如实计入 `skipped`（AC-13 口径统一）
    if (invalidEntries.length > 0) {
      skipped += invalidEntries.length;
      const names = invalidEntries.map((entry) => entry.name || entry.key || '未命名源');
      const head = names.slice(0, 3).join('、');
      const suffix = names.length > 3 ? ` 等 ${names.length} 个源` : '';
      issues.push({
        level: 'info',
        code: 'SKIPPED_INVALID',
        field: null,
        message: `${names.length} 个源配置无效，未提交：${head}${suffix}`,
      });
    }

    const existingSources = await sourceRepo.list();
    const existingKeys = new Set(existingSources.map((source) => source.key));
    const existingById = new Map(existingSources.map((source) => [source.id, source]));
    const existingByKey = new Map(existingSources.map((source) => [source.key, source]));
    const now = Date.now();

    for (const entry of chosen) {
      const normalized = entry.normalized;
      if (!normalized) continue;
      const baseKey = normalized.key ?? entry.key;

      if (entry.duplicateOf) {
        const existing = existingById.get(entry.duplicateOf);
        if (!existing) {
          // 已不存在（预览后删除了）：按新源处理，但 key 可能被其它源占用
          if (existingKeys.has(baseKey)) {
            const holder = existingByKey.get(baseKey);
            if (options.onDuplicate === 'skip') {
              skipped += 1;
              issues.push({
                level: 'info',
                code: 'SKIPPED_DUPLICATE',
                field: 'key',
                message: `${entry.name} 的 key 已存在，已跳过`,
              });
              continue;
            }
            if (options.onDuplicate === 'overwrite' && holder) {
              toWrite.push(mergeIntoExisting(holder, entry, preview, now));
              sourceIds.push(holder.id);
              continue;
            }
            const key = nextKey(baseKey, existingKeys);
            existingKeys.add(key);
            const created = buildSource(entry, key, now, subscriptionId);
            toWrite.push(created);
            sourceIds.push(created.id);
            continue;
          }
          const created = buildSource(entry, baseKey, now, subscriptionId);
          toWrite.push(created);
          sourceIds.push(created.id);
          existingKeys.add(created.key);
          continue;
        }
        if (options.onDuplicate === 'skip') {
          skipped += 1;
          issues.push({
            level: 'info',
            code: 'SKIPPED_DUPLICATE',
            field: 'key',
            message: `${entry.name} 已存在，已跳过`,
          });
          continue;
        }
        if (options.onDuplicate === 'overwrite') {
          toWrite.push(mergeIntoExisting(existing, entry, preview, now));
          sourceIds.push(existing.id);
          continue;
        }
        // keep-both
        const key = nextKey(baseKey, existingKeys);
        existingKeys.add(key);
        const created = buildSource(entry, key, now, subscriptionId);
        toWrite.push(created);
        sourceIds.push(created.id);
        continue;
      }

      let key = baseKey;
      if (existingKeys.has(key)) {
        if (options.onDuplicate === 'skip') {
          skipped += 1;
          issues.push({
            level: 'info',
            code: 'SKIPPED_DUPLICATE',
            field: 'key',
            message: `${entry.name} 的 key 已存在，已跳过`,
          });
          continue;
        }
        if (options.onDuplicate === 'overwrite') {
          // 预览未标注重复但 key 已被占用（预览后新增/重复提交同一份预览）：
          // 同样按覆盖处理，否则会写入重复 key 触发唯一索引约束（E_DB）
          const existing = existingByKey.get(key);
          if (existing) {
            toWrite.push(mergeIntoExisting(existing, entry, preview, now));
            sourceIds.push(existing.id);
            continue;
          }
        }
        if (options.onDuplicate === 'keep-both') {
          key = nextKey(key, existingKeys);
        }
      }
      existingKeys.add(key);
      const created = buildSource(entry, key, now, subscriptionId);
      toWrite.push(created);
      sourceIds.push(created.id);
    }

    if (toWrite.length === 0) {
      return { success: 0, skipped, failed: 0, sourceIds: [], issues };
    }

    const overwrittenIds = toWrite.filter((s) => existingById.has(s.id)).map((s) => s.id);
    try {
      await withTx(['sources', 'media', 'lines', 'episodes', 'categories'], 'readwrite', async (tx) => {
        const sourceStore = tx.objectStore('sources');
        // 预览对象来自 Vue 响应式状态，ext/headers 可能是 Proxy，
        // 结构化克隆会抛 DataCloneError，写入前必须还原成纯值
        for (const source of toWrite) await sourceStore.put(toStorableSource(source));
        for (const sourceId of overwrittenIds) {
          // overwrite：清空该源缓存（FR-04）
          const mediaKeys = await tx
            .objectStore('media')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of mediaKeys) await tx.objectStore('media').delete(key);
          const lineKeys = await tx
            .objectStore('lines')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of lineKeys) await tx.objectStore('lines').delete(key);
          const epKeys = await tx
            .objectStore('episodes')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of epKeys) await tx.objectStore('episodes').delete(key);
          const catKeys = await tx
            .objectStore('categories')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of catKeys) await tx.objectStore('categories').delete(key);
        }
      });
    } catch (e) {
      const error = toAppError(e, 'E_DB');
      throw error;
    }

    if (preview.sourceUrl) {
      await appendImportRecord({
        url: preview.sourceUrl,
        name: preview.name,
        importedAt: Date.now(),
        success: toWrite.length,
      }).catch(() => undefined);
    }

    appEvents.emit('sources:changed', { reason: 'import' });
    return { success: toWrite.length, skipped, failed: 0, sourceIds, issues };
  },
};

/** 覆盖策略：保留原 `id`/`key`/`createdAt`，用订阅里的配置更新可变字段（FR-04） */
function mergeIntoExisting(
  existing: Source,
  entry: ImportPreviewEntry,
  preview: ImportPreview,
  now: number,
): Source {
  const normalized = entry.normalized;
  if (!normalized) return existing;
  return {
    ...existing,
    name: normalized.name,
    type: normalized.type,
    baseUrl: normalized.baseUrl,
    pathPrefix: normalized.pathPrefix ?? existing.pathPrefix,
    auth: normalized.auth
      ? {
          mode: normalized.auth.mode ?? 'none',
          username: normalized.auth.username ?? null,
          password: normalized.auth.password ?? null,
          token: normalized.auth.token ?? null,
        }
      : existing.auth,
    headers: normalized.headers ?? existing.headers,
    ext: normalized.ext ?? existing.ext,
    enabled: true,
    subscriptionId: preview.sourceUrl ?? preview.fileName ?? existing.subscriptionId,
    warning: entry.warning,
    updatedAt: now,
  };
}

function buildSource(
  entry: ImportPreviewEntry,
  key: string,
  now: number,
  subscriptionId: string | null,
): Source {
  const normalized = entry.normalized;
  if (!normalized) throw new AppError('E_INVALID_INPUT');
  return {
    id: newId(),
    key,
    name: normalized.name,
    type: normalized.type,
    enabled: normalized.enabled ?? true,
    builtin: false,
    sort: now,
    baseUrl: normalized.baseUrl,
    pathPrefix: normalized.pathPrefix ?? null,
    auth: {
      mode: normalized.auth?.mode ?? 'none',
      username: normalized.auth?.username ?? null,
      password: normalized.auth?.password ?? null,
      token: normalized.auth?.token ?? null,
    },
    headers: normalized.headers ?? {},
    ext: normalized.ext ?? null,
    // CHG-11：subscriptionId 统一为「订阅来源标识」（URL / 文件名），
    // 与 mergeIntoExisting 口径一致，供订阅管理按来源聚合（此前误写 entry.key）
    subscriptionId,
    warning: entry.warning,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 读取历史导入记录（"检查更新"入口使用） */
export async function listImportRecords(): Promise<ImportRecord[]> {
  return readImportRecords();
}

/** 刷新订阅实现（挂在 importService 上，见对象字面量） */
async function refreshSubscriptionImpl(
  url: string,
  signal?: AbortSignal,
): Promise<{ updated: number; newCount: number; jarDead: number; livesSynced: number }> {
  const preview = await importService.previewFromUrl(url, signal);
  const valid = preview.entries.filter((entry) => entry.valid && entry.normalized !== null);
  const jarDead = valid.filter((entry) => (entry.warning ?? '').includes('jar 不可达')).length;
  // 只覆盖已有源：勾选 = 有效 && 预检未判死 && 已存在（duplicateOf 指向现有源 id）
  const updateKeys = valid.filter((entry) => entry.selected && entry.duplicateOf).map((entry) => entry.key);
  const result = await importService.commit(preview, { selectedKeys: updateKeys, onDuplicate: 'overwrite' });
  const newCount = valid.filter((entry) => entry.selected && !entry.duplicateOf).length;

  // 功能扩展-2：同步直播源（url 即 subscriptionId）
  let livesSynced = 0;
  if (preview.lives.length > 0) {
    try {
      await liveService.addTvboxLives(preview.lives, url);
      livesSynced = preview.lives.length;
    } catch (e) {
      logger.warn('刷新订阅同步直播源失败', url, e);
    }
  }

  return { updated: result.success, newCount, jarDead, livesSynced };
}

/* ---------- EXT-08：导入诊断实现 ---------- */

/** 默认导入集合：预览里「有效 && 已归一化 && 默认勾选」的条目（判死 jar 已被取消勾选） */
function defaultSelectedKeys(preview: ImportPreview): string[] {
  return preview.entries
    .filter((entry) => entry.valid && entry.normalized !== null && entry.selected)
    .map((entry) => entry.key);
}

interface DiagnosticSnapshot {
  subscriptionUrl: string;
  preview: ImportPreview | null;
  probes: JarProbeSummary[];
  estimate: JarTimeEstimate | null;
  warnings: string[];
  startedAt: number;
}

/**
 * 取消分支的统一结果：不写库，但仍产出报告与存活统计（留证）。
 * `pending` = 尚未处理的条目数，供视图显示「已取消（剩余 n 个未处理）」。
 */
async function canceledDiagnosticResult(
  snapshot: DiagnosticSnapshot,
  pending: number,
): Promise<ImportDiagnosticResult> {
  const finishedAt = Date.now();
  const sources = await sourceRepo.list().catch(() => [] as Source[]);
  const alive = summarizeAliveSources(sources);
  const failures = buildFailureItems({
    preview: snapshot.preview,
    probes: snapshot.probes,
    importResult: null,
    subscriptionId: snapshot.preview?.sourceUrl ?? null,
  });
  const report = buildFailureReport({
    subscriptionUrl: snapshot.subscriptionUrl,
    preview: snapshot.preview,
    probes: snapshot.probes,
    failures,
    buckets: bucketFailures(failures),
    alive,
    warnings: snapshot.warnings,
    startedAt: snapshot.startedAt,
    finishedAt,
    now: finishedAt,
  });
  return {
    status: 'canceled',
    subscriptionUrl: snapshot.subscriptionUrl,
    preview: snapshot.preview,
    probes: snapshot.probes,
    estimate: snapshot.estimate,
    import: null,
    failures,
    report,
    alive,
    autoDisabled: 0,
    warnings: snapshot.warnings,
    startedAt: snapshot.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - snapshot.startedAt),
    pending,
  };
}

/**
 * 只读预取：解析订阅 → 探测 jar → 估算下载耗时。
 *
 * 与 `previewFromUrl` 的差异：解析阶段关闭内置 jar 预检（`jarPrecheck: false`），
 * 由本函数用 `diagnoseJarTargets` 统一探测并回报进度，避免同一批 jar HEAD 两遍。
 * 传入 `options.preview` 时直接复用（视图「预取 → 确认导入」两步走的第二段）。
 */
async function prefetchImportImpl(
  url: string,
  options: ImportDiagnosticOptions = {},
): Promise<ImportDiagnosticPrefetch> {
  const startedAt = Date.now();
  const subscriptionUrl = url.trim();

  if (options.preview) {
    const probes = [...(options.probes ?? [])];
    return {
      subscriptionUrl,
      preview: options.preview,
      probes,
      estimate: estimateJarDownload(probes),
      warnings: probeWarnings(probes),
      startedAt,
      finishedAt: Date.now(),
    };
  }

  reportProgress(options, 'parse', 0, 1, { preview: null });
  const parsed = await importService.previewFromUrl(subscriptionUrl, options.signal, {
    jarPrecheck: false,
  });
  reportProgress(options, 'parse', 1, 1, { preview: parsed });

  const targets = options.jarProbe === false ? [] : collectJarTargets(parsed);
  const probes =
    targets.length === 0
      ? []
      : await diagnoseJarTargets(targets, {
          signal: options.signal,
          onProgress: ({ done, total, jarUrl }) =>
            reportProgress(options, 'probe', done, total, { preview: parsed, jarUrl }),
        });
  reportProgress(options, 'probe', probes.length, targets.length, { preview: parsed });

  return {
    subscriptionUrl,
    preview: applyJarSummaries(parsed, probes),
    probes,
    estimate: estimateJarDownload(probes),
    warnings: probeWarnings(probes),
    startedAt,
    finishedAt: Date.now(),
  };
}

/**
 * 带诊断的导入（EXT-08 主流程）。
 *
 * 顺序：预取（解析 + jar 探测）→ 取消检查 → 写入勾选条目 → 连续失败自动禁用
 * → 存活统计 + 失败分类 → 报告。
 *
 * 只写「有效 && 已归一化 && 默认勾选」的条目：判死 jar 的源不会被写入（FR「只保留存活源」）。
 * `selectedKeys` 显式传空数组表示「一个都不导入」，不会退化成 `commit` 的「全量导入」语义。
 */
async function importWithDiagnosticImpl(
  url: string,
  options: ImportDiagnosticOptions = {},
): Promise<ImportDiagnosticResult> {
  const startedAt = Date.now();
  const subscriptionUrl = url.trim();
  const duplicateStrategy = options.onDuplicate ?? 'skip';

  let preview: ImportPreview | null = options.preview ?? null;
  let probes: JarProbeSummary[] = [...(options.probes ?? [])];
  let estimate: JarTimeEstimate | null = estimateJarDownload(probes);
  let warnings: string[] = probeWarnings(probes);

  if (preview === null) {
    const prefetch = await prefetchImportImpl(subscriptionUrl, options);
    preview = prefetch.preview;
    probes = prefetch.probes;
  } else {
    // 调用方自带预览：缺探测结果时补一次，否则「jar 不可达」无法分类
    if (probes.length === 0 && options.jarProbe !== false) {
      const targets = collectJarTargets(preview);
      if (targets.length > 0) {
        probes = await diagnoseJarTargets(targets, {
          signal: options.signal,
          onProgress: ({ done, total, jarUrl }) =>
            reportProgress(options, 'probe', done, total, { preview, jarUrl }),
        });
      }
    }
    // 无论探测结果来自预取还是调用方，都按结论重算勾选：判死 jar 的源绝不写入
    preview = applyJarSummaries(preview, probes);
  }
  // 估算与告警始终按最终探测结果计算，避免调用方传入的旧值残留
  estimate = estimateJarDownload(probes);
  warnings = probeWarnings(probes);

  const snapshot: DiagnosticSnapshot = {
    subscriptionUrl,
    preview,
    probes,
    estimate,
    warnings,
    startedAt,
  };

  const chosenKeys = options.selectedKeys ?? defaultSelectedKeys(preview);
  if (options.signal?.aborted) {
    return canceledDiagnosticResult(snapshot, chosenKeys.length);
  }

  reportProgress(options, 'import', 0, chosenKeys.length, { preview });
  const importResult: ImportResult =
    chosenKeys.length === 0
      ? { success: 0, skipped: 0, failed: 0, sourceIds: [], issues: [] }
      : await importService.commit(preview, {
          selectedKeys: chosenKeys,
          onDuplicate: duplicateStrategy,
        });
  reportProgress(options, 'import', importResult.success, chosenKeys.length, { preview });

  // FR-51 同口径：连续 3 次体检 bad 的源自动禁用；动态 import 规避循环依赖
  let autoDisabled = 0;
  if (importResult.success > 0 && options.autoDisable !== false) {
    try {
      const { subscriptionLifecycleService } = await import('@/services/subscriptionLifecycleService');
      autoDisabled = await subscriptionLifecycleService.applyHealthDegradation();
    } catch (e) {
      logger.warn('导入诊断：自动禁用连续失败源失败', subscriptionUrl, e);
    }
  }

  const sources = await sourceRepo.list();
  const alive = summarizeAliveSources(sources);
  const failures = buildFailureItems({
    preview,
    probes,
    importResult,
    duplicateStrategy,
    sources,
    subscriptionId: preview.sourceUrl ?? null,
  });
  const buckets = bucketFailures(failures);
  const finishedAt = Date.now();
  const report = buildFailureReport({
    subscriptionUrl,
    preview,
    importResult,
    probes,
    failures,
    buckets,
    alive,
    warnings,
    startedAt,
    finishedAt,
    now: finishedAt,
  });

  reportProgress(options, 'done', 1, 1, { preview });

  return {
    status: 'done',
    subscriptionUrl,
    preview,
    probes,
    estimate,
    import: importResult,
    failures,
    report,
    alive,
    autoDisabled,
    warnings,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    pending: 0,
  };
}
