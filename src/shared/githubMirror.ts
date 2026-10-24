/**
 * GitHub raw 镜像回退（CHG-11）
 *
 * 背景：直连 `raw.githubusercontent.com` 在部分网络环境不可达（实测订阅清单里
 * 大量 gh-proxy 包装 URL 即为此），裸 GitHub 地址的订阅 / jar 会导入失败。
 *
 * 语义：仅「网络类失败」（E_NETWORK / E_TIMEOUT）触发镜像回退——HTTP 4xx/5xx
 * 是源或资源本身的问题，镜像解决不了，直接抛出。镜像命中成功时调用方可拿到
 * 实际使用的变体地址（用于日志与预检归属）。
 */
import { GITHUB_MIRROR_HOSTS } from '@/shared/constants';
import { AppError } from '@/shared/errors';

/** 视为 GitHub raw 资源的域名（github.com 本体在判定函数里单独处理 `/raw/` 路径） */
const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'raw.github.com',
]);

/** 触发镜像回退的错误码 */
const MIRROR_FALLBACK_CODES: ReadonlySet<string> = new Set(['E_NETWORK', 'E_TIMEOUT']);

export function isGithubRawUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    // github.com 本体只认 /raw/ 资源路径（页面地址换镜像没有意义）
    if (hostname === 'github.com') return /\/raw\//.test(pathname);
    return GITHUB_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/** 镜像变体地址（原地址不在内）；非 GitHub 地址返回空数组 */
export function mirrorVariants(url: string): string[] {
  if (!isGithubRawUrl(url)) return [];
  return GITHUB_MIRROR_HOSTS.map((host) => `https://${host}/${url}`);
}

export interface MirrorFallbackResult<T> {
  value: T;
  /** 命中的镜像地址；原地址直连成功为 null */
  viaMirror: string | null;
}

/**
 * 带镜像回退的执行器：先跑原地址；网络类失败且为 GitHub raw 地址时按序换镜像。
 * 任一镜像返回 HTTP 类失败（4xx/5xx）说明资源在镜像上也不存在，直接抛出不再换。
 */
export async function withGithubMirrorFallback<T>(
  url: string,
  run: (variantUrl: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<MirrorFallbackResult<T>> {
  try {
    return { value: await run(url), viaMirror: null };
  } catch (e) {
    const code = e instanceof AppError ? e.code : null;
    if (!code || !MIRROR_FALLBACK_CODES.has(code) || signal?.aborted) throw e;
    const variants = mirrorVariants(url);
    let last: unknown = e;
    for (const variant of variants) {
      if (signal?.aborted) throw last instanceof Error ? last : e;
      try {
        return { value: await run(variant), viaMirror: variant };
      } catch (err) {
        const nextCode = err instanceof AppError ? err.code : null;
        if (!nextCode || !MIRROR_FALLBACK_CODES.has(nextCode)) throw err;
        last = err;
      }
    }
    throw last;
  }
}
