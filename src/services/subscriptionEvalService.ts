/**
 * 批量订阅评测（CHG-12）
 *
 * 场景：用户从导航页批量复制几十上百条订阅 URL，逐条手动导入试错不现实。
 * 本服务并行「拉取 → 解析 → 抽样探测」，把清单变成可决策的排行数据：
 * 总条目 / 类型分布 / 站点抽测存活 / 爬虫 jar 存活 / 延迟 / 多仓标记。
 *
 * 口径：
 * - 单条 URL 的错误不影响其它 URL（status: 'error'，附错误码与文案）；
 * - 站点源抽测最多 2 条：GET api 地址（5s、不抛 HTTP 错），2xx 计活，
 *   4xx/5xx 计死，超时不计死（计数仍进 checked，展示 x/y 活）；
 * - 爬虫 jar 全量 HEAD（同 jar 共享结果，判定口径与导入预检一致）；
 * - 多仓索引（顶层 urls[]）只标记不展开，需用户在导入页选择仓库后评测。
 */
import {
  SUBSCRIPTION_EVAL_CONCURRENCY,
  TIMEOUT_SUBSCRIPTION_EVAL_MS,
} from '@/shared/constants';
import { AppError } from '@/shared/errors';
import { importService } from '@/services/importService';
import { probeJarUrls, stripJarSuffix } from '@/services/jarProbe';
import { httpClient } from '@/sources/base/httpClient';
import type { ImportPreview, ImportPreviewEntry } from '@/types';

export interface SubscriptionEvalResult {
  url: string;
  status: 'ok' | 'error';
  latencyMs: number;
  /** 订阅名（解析成功时） */
  name: string | null;
  /** 条目统计（多仓索引为 null） */
  total: number | null;
  siteCount: number;
  spiderCount: number;
  /** JS 爬虫（drpy，由内置引擎执行） */
  jsCount: number;
  doubanCount: number;
  unknownCount: number;
  /** 站点源抽测：存活 / 抽测数（无站点源或解析失败为 null） */
  siteAlive: number | null;
  siteChecked: number | null;
  /** 爬虫 jar 预检：判死 / 总数（无爬虫或解析失败为 null） */
  jarDead: number | null;
  jarTotal: number | null;
  isMultiRepo: boolean;
  repoCount: number | null;
  error: { code: string; message: string } | null;
}

/** 抽取清单文本里的 URL（容忍编号前缀、空白行、杂文字） */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = /https?:\/\/[^\s"'<>，。；）】]+/i.exec(line);
    if (match) out.push(match[0]);
  }
  return out;
}

/** 站点源抽测：GET api 地址，2xx 活 / 4xx5xx 死 / 其它（超时等）不确定 */
async function probeSiteAlive(url: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await httpClient.requestWithMeta(url, {
      method: 'GET',
      responseType: 'none',
      timeoutMs: 5000,
      retries: 0,
      throwOnHttpError: false,
      signal,
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return null;
  }
}

/** 单条订阅评测（错误不抛出，进结果） */
async function evaluateOne(url: string, signal?: AbortSignal): Promise<SubscriptionEvalResult> {
  const startedAt = Date.now();
  const base: SubscriptionEvalResult = {
    url,
    status: 'error',
    latencyMs: 0,
    name: null,
    total: null,
    siteCount: 0,
    spiderCount: 0,
    jsCount: 0,
    doubanCount: 0,
    unknownCount: 0,
    siteAlive: null,
    siteChecked: null,
    jarDead: null,
    jarTotal: null,
    isMultiRepo: false,
    repoCount: null,
    error: null,
  };

  let preview: ImportPreview;
  try {
    preview = await importService.previewFromUrl(url, signal, { jarPrecheck: false });
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError('E_NETWORK');
    return { ...base, latencyMs: Date.now() - startedAt, error: { code: err.code, message: err.message } };
  }

  const elapsed = Date.now() - startedAt;
  if (preview.repos.length > 0) {
    return {
      ...base,
      status: 'ok',
      latencyMs: elapsed,
      name: preview.name,
      isMultiRepo: true,
      repoCount: preview.repos.length,
    };
  }

  const valid = preview.entries.filter((entry) => entry.valid && entry.normalized !== null);
  const siteEntries = valid.filter((entry) => entry.type === 'site');
  const spiderEntries = valid.filter((entry) => entry.type === 'spider');
  const jarUrls = spiderEntries
    .map(spiderJarUrl)
    .filter((url): url is string => url !== null);

  const [jarResults, ...siteResults] = await Promise.all([
    jarUrls.length > 0 ? probeJarUrls(jarUrls, signal) : Promise.resolve(new Map()),
    ...sampleSiteUrls(siteEntries, signal),
  ]);

  const siteChecked = siteResults.filter((r): r is boolean => r !== null).length;
  const siteAlive = siteResults.filter((r) => r === true).length;
  const jarDead = jarUrls.filter((u) => jarResults.get(u)?.verdict === 'dead').length;

  return {
    url,
    status: 'ok',
    latencyMs: elapsed,
    name: preview.name,
    total: preview.total,
    siteCount: siteEntries.length,
    spiderCount: spiderEntries.length,
    jsCount: spiderEntries.length - jarUrls.length,
    doubanCount: valid.filter((entry) => entry.type === 'douban').length,
    unknownCount: valid.filter(
      (entry) => entry.type !== 'site' && entry.type !== 'spider' && entry.type !== 'douban',
    ).length,
    siteAlive: siteChecked > 0 ? siteAlive : null,
    siteChecked: siteChecked > 0 ? siteChecked : null,
    jarDead: jarUrls.length > 0 ? jarDead : null,
    jarTotal: jarUrls.length > 0 ? jarUrls.length : null,
    isMultiRepo: false,
    repoCount: null,
    error: null,
  };
}

function spiderJarUrl(entry: ImportPreviewEntry): string | null {
  const ext = entry.normalized?.ext as { kind?: unknown; jarUrl?: unknown } | null;
  if (!ext || ext.kind !== 'jar' || typeof ext.jarUrl !== 'string' || ext.jarUrl.length === 0) {
    return null;
  }
  return stripJarSuffix(ext.jarUrl);
}

/** 站点源抽测：最多取前 2 条（api 地址） */
function sampleSiteUrls(entries: ImportPreviewEntry[], signal?: AbortSignal): Array<Promise<boolean | null>> {
  return entries.slice(0, 2).map((entry) => {
    const baseUrl = entry.normalized?.baseUrl;
    return baseUrl ? probeSiteAlive(baseUrl, signal) : Promise.resolve(null);
  });
}

/** 活条目估计：站点活抽测比例 × 站点数 + (jar 总数 - 判死) × 折算 + 豆瓣 */
function aliveEstimateOf(result: SubscriptionEvalResult): number {
  if (result.status !== 'ok' || result.total === null) return -1;
  const siteAlive =
    result.siteChecked && result.siteAlive !== null
      ? Math.round((result.siteAlive / result.siteChecked) * result.siteCount)
      : result.siteCount;
  const spiderAlive =
    result.jarDead !== null ? result.spiderCount - result.jarDead : result.spiderCount;
  return siteAlive + spiderAlive + result.doubanCount;
}

/** 单条评测软上限：超时按 error 结果记录（内部各环节已自带超时，此层兜整体预算） */
function withEvalTimeout(p: Promise<SubscriptionEvalResult>): Promise<SubscriptionEvalResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('E_TIMEOUT')), TIMEOUT_SUBSCRIPTION_EVAL_MS);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const subscriptionEvalService = {
  /**
   * 并发评测一批订阅 URL（并发 4、进度回调），结果按「活条目估计」降序。
   * 取消（signal abort）后已完成的部分结果照常返回。
   */
  async evaluate(
    urls: string[],
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<SubscriptionEvalResult[]> {
    const total = urls.length;
    if (total === 0) return [];

    const results: SubscriptionEvalResult[] = [];
    let done = 0;
    let cursor = 0;

    await Promise.all(
      Array.from({ length: Math.min(SUBSCRIPTION_EVAL_CONCURRENCY, total) }, async () => {
        while (cursor < total) {
          const url = urls[cursor++]!;
          if (signal?.aborted) return;
          const result = await withEvalTimeout(evaluateOne(url, signal)).catch((e) => {
            const err = e instanceof AppError ? e : new AppError('E_NETWORK');
            return {
              url,
              status: 'error' as const,
              latencyMs: 0,
              name: null,
              total: null,
              siteCount: 0,
              spiderCount: 0,
              jsCount: 0,
              doubanCount: 0,
              unknownCount: 0,
              siteAlive: null,
              siteChecked: null,
              jarDead: null,
              jarTotal: null,
              isMultiRepo: false,
              repoCount: null,
              error: { code: err.code, message: err.message },
            };
          });
          results.push(result);
          done += 1;
          onProgress?.(done, total);
        }
      }),
    );

    return results.sort((a, b) => aliveEstimateOf(b) - aliveEstimateOf(a));
  },
};
