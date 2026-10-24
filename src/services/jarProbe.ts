/**
 * 爬虫 jar 可达性预检（CHG-10 引入、CHG-12 抽取共享）
 *
 * 供两处使用：
 * - `importService.precheckSpiderJars`（导入预览时筛死源）；
 * - `subscriptionEvalService`（批量订阅评测的活条目估计）。
 *
 * 判定口径：
 * - dead：HTTP 4xx/5xx（状态码可读即服务器有应答）；
 * - unknown：`E_TIMEOUT`（可能是慢网络活源）、405/501（不支持 HEAD）、
 *   Web 端 `E_NETWORK`（可能是 CORS 假阳性）；原生端网络错误视为域名失效；
 * - GitHub raw 形态的 jar 直连不可达时按序换镜像（CHG-11）。
 */
import { AppError, toAppError } from '@/shared/errors';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { isNative } from '@/shared/platform';
import { httpClient } from '@/sources/base/httpClient';

export const JAR_CHECK_CONCURRENCY = 6;
export const JAR_CHECK_TIMEOUT_MS = 3000;

export type JarVerdict = 'ok' | 'dead' | 'unknown';

export interface JarProbeResult {
  verdict: JarVerdict;
  /** dead 时的失败原因（如 `HTTP 403`） */
  detail?: string;
  /** 命中的镜像地址；直连成功为 null */
  viaMirror: string | null;
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

/** 探测单个 jar 地址（HEAD，3s、不重试、镜像回退） */
export async function probeJarUrl(jarUrl: string, signal?: AbortSignal): Promise<JarProbeResult> {
  const url = stripJarSuffix(jarUrl);
  try {
    const { viaMirror } = await withGithubMirrorFallback(
      url,
      (variantUrl) =>
        httpClient.request(variantUrl, {
          method: 'HEAD',
          responseType: 'none',
          timeoutMs: JAR_CHECK_TIMEOUT_MS,
          retries: 0,
          signal,
        }),
      signal,
    );
    return { verdict: 'ok', viaMirror };
  } catch (e) {
    const err = toAppError(e, 'E_NETWORK');
    // 取消不算死：批量评测中断时在途请求会被 abort
    if (signal?.aborted || jarCheckInconclusive(err)) return { verdict: 'unknown', viaMirror: null };
    return { verdict: 'dead', detail: err.detail ?? err.message, viaMirror: null };
  }
}

/**
 * 并发探测一批 jar 地址（并发 `JAR_CHECK_CONCURRENCY`），结果按原始 jarUrl 索引。
 * 相同地址只发一次请求（TVBox 订阅里大量条目共享同一个 jar）。
 */
export async function probeJarUrls(
  jarUrls: string[],
  signal?: AbortSignal,
): Promise<Map<string, JarProbeResult>> {
  const results = new Map<string, JarProbeResult>();
  const unique = [...new Set(jarUrls)];
  if (unique.length === 0) return results;

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(JAR_CHECK_CONCURRENCY, unique.length) }, async () => {
      while (cursor < unique.length) {
        const jarUrl = unique[cursor++]!;
        if (signal?.aborted) return;
        results.set(jarUrl, await probeJarUrl(jarUrl, signal));
      }
    }),
  );
  return results;
}
