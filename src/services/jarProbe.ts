/**
 * 爬虫 jar 可达性预检（CHG-10 引入、CHG-12 抽取共享）
 *
 * 供三处使用：
 * - `importService.precheckSpiderJars`（导入预览时筛死源）；
 * - `subscriptionEvalService`（批量订阅评测的活条目估计）；
 * - `importService.prefetchImport / importWithDiagnostic`（EXT-08 导入诊断：
 *   额外采集 content-length 与往返延迟，用于估算 jar 下载耗时）。
 *
 * 判定口径：
 * - dead：HTTP 4xx/5xx（状态码可读即服务器有应答）；
 * - unknown：`E_TIMEOUT`（可能是慢网络活源）、405/501（不支持 HEAD）、
 *   Web 端 `E_NETWORK`（可能是 CORS 假阳性）；原生端网络错误视为域名失效；
 * - GitHub raw 形态的 jar 直连不可达时按序换镜像（CHG-11）。
 *
 * EXT-08 新增字段（`latencyMs` / `contentLength` / `errorCode` / `httpStatus`）只增不改，
 * 既有调用方仍只读 `verdict / detail / viaMirror`。
 */
import { AppError, toAppError } from '@/shared/errors';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { isNative } from '@/shared/platform';
import { httpClient } from '@/sources/base/httpClient';
import type { ErrorCode } from '@/types';

export const JAR_CHECK_CONCURRENCY = 6;
export const JAR_CHECK_TIMEOUT_MS = 3000;

export type JarVerdict = 'ok' | 'dead' | 'unknown';

export interface JarProbeResult {
  verdict: JarVerdict;
  /** dead 时的失败原因（如 `HTTP 403`） */
  detail?: string;
  /** 命中的镜像地址；直连成功为 null */
  viaMirror: string | null;
  /** HEAD 往返耗时（毫秒）；超时的情况为实际等待时间 */
  latencyMs: number;
  /** `content-length`（字节）；HEAD 未返回该头或解析失败为 null */
  contentLength: number | null;
  /** 失败错误码；成功为 null */
  errorCode: ErrorCode | null;
  /** HTTP 状态码；网络层失败（无应答）为 null */
  httpStatus: number | null;
}

/** 批量探测进度（EXT-08：诊断视图实时显示 n/total） */
export interface JarProbeProgress {
  done: number;
  total: number;
  /** 刚完成的 jar 地址（同一 jar 只回报一次） */
  jarUrl: string;
}

/** HEAD 结论不确定（不据此判死） */
export function jarCheckInconclusive(e: AppError): boolean {
  if (e.code === 'E_TIMEOUT') return true;
  if (!isNative() && (e.code === 'E_NETWORK' || e.httpStatus === null)) return true;
  return e.httpStatus === 405 || e.httpStatus === 501;
}

/** 剥掉 `;md5;hash` 后缀（由原生侧解析，HTTP 请求不带） */
export function stripJarSuffix(jarUrl: string): string {
  return jarUrl.split(';')[0] ?? jarUrl;
}

/**
 * 读取 `content-length`。
 * 跨域 HEAD 在未暴露该响应头时读不到（浏览器返回 null），此时按 `null` 处理，
 * 由调用方回落到默认 jar 体积估算，不伪造数值。
 */
export function contentLengthOf(headers: Headers | null | undefined): number | null {
  const raw = headers?.get('content-length') ?? null;
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 单次 HEAD 探测的元数据（EXT-08 估算用）。
 * `contentLength` 缺省表示拿不到体积（跨域未暴露 / 客户端无元数据入口），
 * 由调用方回落到默认体积，不伪造数值。
 */
interface HeadProbe {
  contentLength: number | null;
  httpStatus: number | null;
}

/**
 * HEAD 一次 jar 并尽量取回体积与状态码。
 *
 * 首选 `requestWithMeta`（同一次请求即可拿到 headers / status）；
 * 客户端未提供该入口时退化为 `request`（只判定可达性，体积与状态码留空）——
 * 受限环境与轻量替身不应因为缺元数据就失去「可达性预检」这个主功能。
 */
async function headJarUrl(url: string, signal?: AbortSignal): Promise<HeadProbe> {
  const options = {
    method: 'HEAD' as const,
    responseType: 'none' as const,
    timeoutMs: JAR_CHECK_TIMEOUT_MS,
    retries: 0,
    signal,
  };
  if (typeof httpClient.requestWithMeta === 'function') {
    const meta = await httpClient.requestWithMeta<undefined>(url, options);
    return { contentLength: contentLengthOf(meta.headers), httpStatus: meta.status };
  }
  await httpClient.request(url, options);
  return { contentLength: null, httpStatus: null };
}

/** 探测单个 jar 地址（HEAD，3s、不重试、镜像回退） */
export async function probeJarUrl(jarUrl: string, signal?: AbortSignal): Promise<JarProbeResult> {
  const url = stripJarSuffix(jarUrl);
  const startedAt = Date.now();
  try {
    const { value, viaMirror } = await withGithubMirrorFallback(
      url,
      (variantUrl) => headJarUrl(variantUrl, signal),
      signal,
    );
    return {
      verdict: 'ok',
      viaMirror,
      latencyMs: Date.now() - startedAt,
      contentLength: value.contentLength,
      errorCode: null,
      httpStatus: value.httpStatus,
    };
  } catch (e) {
    const err = toAppError(e, 'E_NETWORK');
    const latencyMs = Date.now() - startedAt;
    // 取消不算死：批量评测中断时在途请求会被 abort
    if (signal?.aborted || jarCheckInconclusive(err)) {
      return {
        verdict: 'unknown',
        viaMirror: null,
        latencyMs,
        contentLength: null,
        errorCode: err.code,
        httpStatus: err.httpStatus,
      };
    }
    return {
      verdict: 'dead',
      detail: err.detail ?? err.message,
      viaMirror: null,
      latencyMs,
      contentLength: null,
      errorCode: err.code,
      httpStatus: err.httpStatus,
    };
  }
}

/**
 * 并发探测一批 jar 地址（并发 `JAR_CHECK_CONCURRENCY`），结果按原始 jarUrl 索引。
 * 相同地址只发一次请求（TVBox 订阅里大量条目共享同一个 jar）。
 *
 * `onProgress` 为 EXT-08 新增（可选）：每完成一个唯一地址回报一次，供诊断视图展示进度。
 */
export async function probeJarUrls(
  jarUrls: string[],
  signal?: AbortSignal,
  onProgress?: (progress: JarProbeProgress) => void,
): Promise<Map<string, JarProbeResult>> {
  const results = new Map<string, JarProbeResult>();
  const unique = [...new Set(jarUrls)];
  if (unique.length === 0) return results;

  const total = unique.length;
  let done = 0;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(JAR_CHECK_CONCURRENCY, unique.length) }, async () => {
      while (cursor < unique.length) {
        const jarUrl = unique[cursor++]!;
        if (signal?.aborted) return;
        const result = await probeJarUrl(jarUrl, signal);
        results.set(jarUrl, result);
        done += 1;
        onProgress?.({ done, total, jarUrl });
      }
    }),
  );
  return results;
}
