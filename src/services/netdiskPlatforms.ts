/**
 * 网盘平台配置（P2）
 *
 * 每个平台的登录 URL、cookie 文件路径、API 端点等配置。
 *
 * 能力分级（决策 Q-03=A · OPT-05 / EXT-02）：
 * - `full-api`：具备账号 + 会员 API，可校验昵称/会员状态 —— 当前仅夸克。
 * - `cookie-only`：只做 Cookie 直填，账号能力未验证（本轮不逆向第三方 API）。
 *   该等级的卡片必须展示 `capabilityNote`，且不得出现会员/容量等未实现能力入口。
 */

import type { Source } from '@/types';

/** 平台能力等级 */
export type NetdiskCapabilityLevel = 'full-api' | 'cookie-only';

/** `cookie-only` 平台的统一能力说明（UI 文案唯一出处） */
export const COOKIE_ONLY_CAPABILITY_NOTE = 'Cookie 直填、账号能力未验证';

export interface NetdiskPlatform {
  key: string;
  name: string;
  icon: string;
  loginUrl: string;
  cookieFile: string;
  cookieDomains: string[];
  /** 能力等级：决定 UI 展示哪些能力信息 */
  capabilityLevel: NetdiskCapabilityLevel;
  /** 能力说明：`cookie-only` 平台必填，`full-api` 平台留空 */
  capabilityNote?: string;
  memberApi?: string;
  accountApi?: string;
  userAgent?: string;
}

export const NETDISK_PLATFORMS: Record<string, NetdiskPlatform> = {
  quark: {
    key: 'quark',
    name: '夸克网盘',
    icon: '🔵',
    loginUrl: 'https://pan.quark.cn',
    cookieFile: 'quark_cookie.txt',
    cookieDomains: ['https://pan.quark.cn', 'https://drive-pc.quark.cn'],
    capabilityLevel: 'full-api',
    memberApi: 'https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true&_ch=home&fetch_identity=true',
    accountApi: 'https://pan.quark.cn/account/info?fr=pc&platform=pc',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  uc: {
    key: 'uc',
    name: 'UC网盘',
    icon: '🟢',
    loginUrl: 'https://drive.uc.cn',
    cookieFile: 'uc_cookie.txt',
    cookieDomains: ['https://drive.uc.cn'],
    capabilityLevel: 'cookie-only',
    capabilityNote: COOKIE_ONLY_CAPABILITY_NOTE,
  },
  '123': {
    key: '123',
    name: '123云盘',
    icon: '🟡',
    loginUrl: 'https://yun.123pan.cn',
    cookieFile: '123_cookie.txt',
    cookieDomains: ['https://yun.123pan.cn', 'https://123pan.cn', 'https://www.123pan.com'],
    capabilityLevel: 'cookie-only',
    capabilityNote: COOKIE_ONLY_CAPABILITY_NOTE,
  },
  tianyi: {
    key: 'tianyi',
    name: '天翼云盘',
    icon: '🔴',
    loginUrl: 'https://cloud.189.cn',
    cookieFile: 'tianyi_cookie.txt',
    cookieDomains: ['https://cloud.189.cn'],
    capabilityLevel: 'cookie-only',
    capabilityNote: COOKIE_ONLY_CAPABILITY_NOTE,
  },
  ali: {
    key: 'ali',
    name: '阿里云盘',
    icon: '⚪',
    loginUrl: 'https://www.alipan.com',
    cookieFile: 'ali_cookie.txt',
    cookieDomains: [
      'https://www.alipan.com',
      'https://alipan.com',
      'https://passport.alipan.com',
      'https://www.aliyundrive.com',
      'https://aliyundrive.com',
    ],
    capabilityLevel: 'cookie-only',
    capabilityNote: COOKIE_ONLY_CAPABILITY_NOTE,
  },
};

/**
 * 平台展示顺序（夸克优先，其余按 Cookie 直填平台并列）
 *
 * 必须显式声明：`NETDISK_PLATFORMS` 的 key `'123'` 是类整数键，
 * `Object.values()` 会把它排到最前面，导致「完整支持」的夸克被挤到第二位。
 */
export const NETDISK_PLATFORM_ORDER = ['quark', 'uc', '123', 'tianyi', 'ali'] as const;

/**
 * 获取平台配置
 */
export function getPlatform(key: string): NetdiskPlatform | undefined {
  return NETDISK_PLATFORMS[key];
}

/**
 * 获取所有支持的平台列表（按 `NETDISK_PLATFORM_ORDER` 输出，未列出的 key 追加在尾部）
 */
export function getAllPlatforms(): NetdiskPlatform[] {
  const ordered = NETDISK_PLATFORM_ORDER.map(key => NETDISK_PLATFORMS[key]).filter(
    (platform): platform is NetdiskPlatform => Boolean(platform),
  );
  const rest = Object.values(NETDISK_PLATFORMS).filter(
    platform => !NETDISK_PLATFORM_ORDER.includes(platform.key as (typeof NETDISK_PLATFORM_ORDER)[number]),
  );
  return [...ordered, ...rest];
}

/**
 * 是否具备账号 / 会员 API 能力（`cookie-only` 平台恒为 false）
 */
export function supportsAccountApi(platform: NetdiskPlatform): boolean {
  return platform.capabilityLevel === 'full-api' && Boolean(platform.accountApi);
}

/* ---------- 网盘源识别（P4-3 口径 + F8 启动引导口径） ---------- */

/** 宽口径关键词：只要 initExt / baseUrl 命中就按网盘源下发画质与线程配置 */
const NETDISK_CONFIG_KEYWORDS = ['netdisk', 'pan', 'quark', 'uc', '123', 'tianyi', 'ali', '网盘'];

/** 网盘平台的无歧义标识（专名与域名；不含 `uc` / `pan` / `ali` 这类会误伤的短词） */
const NETDISK_SIGNATURE = /网盘|云盘|netdisk|quark|123pan|pan123|alipan|aliyundrive|tianyi|drive\.uc\.cn/i;

function initExtOf(source: Source): string {
  const ext = (source.ext ?? {}) as { initExt?: unknown };
  return typeof ext.initExt === 'string' ? ext.initExt : '';
}

/**
 * P4-3：是否为网盘源（原 `SpiderAdapter` 私有口径，上移到服务层供其它模块复用）。
 *
 * 口径刻意偏宽：误判的代价只是多下发一段「尽力而为」的配置提示。
 * 用户可见的提醒请改用更严的 `requiresNetdiskCookie`。
 */
export function isNetdiskSource(source: Source): boolean {
  const searchText = `${initExtOf(source)} ${source.baseUrl ?? ''}`.toLowerCase();
  return NETDISK_CONFIG_KEYWORDS.some((kw) => searchText.includes(kw.toLowerCase()));
}

/**
 * F8：该源是否真的依赖 App 管理的网盘 Cookie。
 *
 * 判据只看已入库的源配置，不碰外部存储——缺 `MANAGE_EXTERNAL_STORAGE` 时
 * cookie 文件本身就读不到，「先读到 cookie 再提醒」会在最需要提醒的那次启动上自锁。
 * 比 `isNetdiskSource` 严：那里误判只是多下发一段配置，这里误判是每次启动弹 Toast。
 */
export function requiresNetdiskCookie(source: Source): boolean {
  return NETDISK_SIGNATURE.test(`${source.name ?? ''} ${initExtOf(source)} ${source.baseUrl ?? ''}`);
}
