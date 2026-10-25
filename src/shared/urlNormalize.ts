/**
 * 订阅导入 URL 归一化（v1.7 / CHG-18，纯函数无 IO）
 *
 * 116 条社区订阅实测的三类「拉不到」问题：
 * 1. 把 gitee/gitlab/github 仓库**页面**地址当 raw 链接贴进来（`blob/`、`-/blob/`）；
 * 2. gh-proxy / ghfast 等代理前缀地址，代理失效后整条链路死掉（CHG-11 的镜像回退
 *    只认裸 GitHub raw 地址，带前缀的不认）；
 * 3. jsdelivr CDN 地址与 raw.githubusercontent 互为变体，单点失败。
 *
 * 语义：
 * - `url` 是**首选地址**（代理前缀保留——原样可用时优先原路，不改写用户输入）；
 * - `variants` 是网络失败时按序重试的变体（剥前缀直连 → 各镜像 → CDN 互换）；
 * - `notes` 只提示不改写（如 `?id-3` 疑似 `?id=3`）。
 */
import { CDN_VARIANT_MAP, GITHUB_MIRROR_HOSTS, URL_PROXY_HOSTS } from '@/shared/constants';

export interface UrlNormalization {
  /** 首选地址（blob→raw 已重写；代理前缀原样保留） */
  url: string;
  /** 命中的代理前缀 host；无则 null */
  strippedProxy: string | null;
  /** 网络失败时按序尝试的变体（不含首选地址本身） */
  variants: string[];
  /** 非致命提示 */
  notes: string[];
}

/** 代码托管平台的「页面 → raw」重写规则（`$1` = 用户/组织，`$2` = 仓库，`$3` = 分支，`$4` = 路径） */
const BLOB_REWRITES: ReadonlyArray<{ host: RegExp; to: (m: RegExpMatchArray) => string }> = [
  // github.com/user/repo/blob/branch/path → raw（github 本体 raw 域名，CHG-11 镜像可接手）
  {
    host: /^github\.com$/i,
    to: (m) => `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
  },
  // gitee.com/user/repo/blob/branch/path → raw
  {
    host: /^gitee\.com$/i,
    to: (m) => `https://gitee.com/${m[1]}/${m[2]}/raw/${m[3]}/${m[4]}`,
  },
  // gitlab.com / jihulab.com：/-/blob/ → /-/raw/
  {
    host: /^(?:gitlab\.com|jihulab\.com)$/i,
    to: (m) => `https://${m[0] ? '' : ''}`, // 占位，下方统一处理
  },
  // cnb.cool：/-/git/raw/ 已是 raw；/-/blob/ → /-/git/raw/
  {
    host: /^cnb\.cool$/i,
    to: (m) => `https://cnb.cool/${m[1]}/${m[2]}/-/git/raw/${m[4]}`,
  },
];

/** 提取 `blob`/`-/blob/` 路径并重写为 raw 地址；不匹配返回 null */
function rewriteBlobUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // gitlab / jihulab：`/-/blobs?/`（兼容 `/-/raws?/` 已是 raw 不动）
  if (host === 'gitlab.com' || host === 'jihulab.com') {
    const m = /^\/(.+?)\/(.+?)\/-\/blob(?:s)?\/(.+?)\/(.+)$/.exec(path);
    if (m) return `https://${host}/${m[1]}/${m[2]}/-/raw/${m[3]}/${m[4]}`;
    return null;
  }

  const rule = BLOB_REWRITES.find((r) => r.host.test(host));
  if (!rule) return null;
  if (host === 'gitlab.com' || host === 'jihulab.com') return null;
  // github / gitee / cnb：`/user/repo/blob?/branch/path` 或 `/user/repo/-/blob/...`（cnb）
  const m = /^\/(.+?)\/(.+?)\/(?:-\/)?blob(?:s)?\/(.+?)\/(.+)$/.exec(path);
  if (!m) return null;
  return rule.to([url, m[1]!, m[2]!, m[3]!, m[4]!] as RegExpMatchArray);
}

/** 识别「代理前缀 + 目标地址」形态，返回目标地址；不匹配返回 null */
export function stripProxyPrefix(url: string): { proxyHost: string; target: string } | null {
  for (const proxy of URL_PROXY_HOSTS) {
    const prefix = `https://${proxy}/`;
    if (url.startsWith(prefix)) {
      const target = url.slice(prefix.length).trim();
      if (target.length > 0) return { proxyHost: proxy, target };
    }
  }
  return null;
}

/** jsdelivr ↔ raw 互换变体（github user/repo/branch/path 三段可解析时） */
function cdnVariants(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  const out: string[] = [];

  // jsdelivr → raw：/gh/user/repo@branch/path
  const jsd = /^(?:cdn|fastly|testingcf)\.jsdelivr\.net$/i.test(host);
  if (jsd) {
    const m = /^\/gh\/([^/@]+)\/([^/@]+)@([^/]+)\/(.+)$/.exec(parsed.pathname);
    if (m) out.push(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`);
    return out;
  }

  // raw.githubusercontent → jsdelivr：/user/repo/branch/path
  if (host === 'raw.githubusercontent.com') {
    const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(parsed.pathname);
    if (m) {
      for (const cdnHost of Object.keys(CDN_VARIANT_MAP)) {
        out.push(`https://${cdnHost}/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`);
      }
    }
  }
  return out;
}

const GITHUB_RAW_HOSTS = new Set(['raw.githubusercontent.com', 'gist.githubusercontent.com', 'raw.github.com']);

/** 是否为 GitHub raw 资源（含代理前缀包装的形态） */
function isGithubRawish(url: string): boolean {
  const stripped = stripProxyPrefix(url);
  const target = stripped?.target ?? url;
  try {
    const { hostname, pathname } = new URL(target);
    if (hostname === 'github.com') return /\/raw\//.test(pathname);
    return GITHUB_RAW_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * 归一化导入地址。
 * `blob→raw` 重写**会改写首选地址**（页面地址拉不到配置，重写是唯一正确解释）；
 * 代理前缀、CDN 变体只进 `variants`，不改写首选。
 */
export function normalizeImportUrl(raw: string): UrlNormalization {
  const trimmed = (raw ?? '').trim();
  const notes: string[] = [];

  // ① 代理前缀：记录并取目标地址做后续判定（首选仍用原地址）
  const proxied = stripProxyPrefix(trimmed);
  const strippedProxy = proxied?.proxyHost ?? null;
  const effective = proxied?.target ?? trimmed;

  // ② blob → raw 重写（首选地址级）
  const rewritten = rewriteBlobUrl(effective);
  const url = rewritten ?? trimmed;
  if (rewritten && rewritten !== trimmed) {
    notes.push(`已将仓库页面地址重写为 raw 地址：${rewritten}`);
  }

  // ③ 变体序列：剥代理直连 → GitHub 镜像 → CDN 互换
  const variants: string[] = [];
  const push = (v: string): void => {
    if (v && v !== url && !variants.includes(v)) variants.push(v);
  };

  if (proxied) push(proxied.target);
  if (rewritten) push(rewritten);

  const githubTarget = rewritten ?? effective;
  if (!proxied && isGithubRawish(trimmed)) {
    for (const mirror of GITHUB_MIRROR_HOSTS) push(`https://${mirror}/${githubTarget}`);
  } else if (proxied && isGithubRawish(proxied.target)) {
    // 前缀地址：剥前缀后仍可走镜像
    for (const mirror of GITHUB_MIRROR_HOSTS) push(`https://${mirror}/${proxied.target}`);
  }

  for (const v of cdnVariants(githubTarget)) push(v);

  // ④ 拼写提示（不改写）：查询串里有 `-` 且没有 `=`，如 `?id-3` 疑似 `?id=3`
  const queryStart = url.indexOf('?');
  if (queryStart >= 0 && url.includes('-', queryStart) && !url.includes('=', queryStart)) {
    notes.push('地址查询串疑似拼写错误（如 ?id-3 应为 ?id=3），请核对原始地址');
  }

  return { url, strippedProxy, variants, notes };
}

/** 直播列表地址特征（预判提示用；最终以响应内容判定为准） */
export function isLikelyLiveListUrl(url: string): boolean {
  const lower = (url ?? '').toLowerCase();
  if (/\.m3u8?(?:[?#]|$)/.test(lower)) return true;
  if (/\/(?:iptv|live|tv)(?:[/?#]|$)/.test(lower) && /\.txt(?:[?#]|$)/.test(lower)) return true;
  return /(?:iptv-org|iptv|live\.zbds|epg\.pw)/i.test(lower);
}
