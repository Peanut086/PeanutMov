import { describe, expect, it } from 'vitest';

import {
  COOKIE_ONLY_CAPABILITY_NOTE,
  NETDISK_PLATFORMS,
  getAllPlatforms,
  getPlatform,
  supportsAccountApi,
  type NetdiskPlatform,
} from '@/services/netdiskPlatforms';

/**
 * OPT-05 / EXT-02：网盘能力声明收敛（决策 Q-03=A）
 *
 * 结论口径：
 * - 夸克保留账号 + 会员 API（`full-api`）
 * - UC / 123 / 天翼 / 阿里 只做 Cookie 直填（`cookie-only`），账号能力未验证
 * - 声明必须与真实 API 字段一致，禁止再出现「列了平台但没有能力说明」的漂移
 */

const COOKIE_ONLY_KEYS = ['uc', '123', 'tianyi', 'ali'] as const;

function platformOf(key: string): NetdiskPlatform {
  const platform = getPlatform(key);
  expect(platform, `平台 ${key} 必须存在`).toBeDefined();
  return platform as NetdiskPlatform;
}

describe('netdiskPlatforms 能力分级（OPT-05）', () => {
  it('平台清单保持 5 个，key 与配置自洽', () => {
    const platforms = getAllPlatforms();
    expect(platforms).toHaveLength(5);
    expect(platforms.map(p => p.key).sort()).toEqual(['123', 'ali', 'quark', 'tianyi', 'uc']);
    // 展示顺序：夸克（完整 API）优先，其余 4 个 Cookie 直填平台并列其后
    expect(platforms.map(p => p.key)).toEqual(['quark', 'uc', '123', 'tianyi', 'ali']);
    for (const platform of platforms) {
      expect(NETDISK_PLATFORMS[platform.key]).toBe(platform);
      expect(platform.name.length).toBeGreaterThan(0);
      expect(platform.loginUrl.startsWith('https://')).toBe(true);
      expect(platform.cookieFile.endsWith('.txt')).toBe(true);
      expect(platform.cookieDomains.length).toBeGreaterThan(0);
    }
  });

  it('仅夸克声明 full-api 且具备账号/会员 API', () => {
    const quark = platformOf('quark');
    expect(quark.capabilityLevel).toBe('full-api');
    expect(quark.memberApi).toBeTruthy();
    expect(quark.accountApi).toBeTruthy();
    expect(supportsAccountApi(quark)).toBe(true);

    const fullApiPlatforms = getAllPlatforms().filter(p => p.capabilityLevel === 'full-api');
    expect(fullApiPlatforms.map(p => p.key)).toEqual(['quark']);
  });

  it('UC/123/天翼/阿里 声明 cookie-only，并携带统一能力说明', () => {
    for (const key of COOKIE_ONLY_KEYS) {
      const platform = platformOf(key);
      expect(platform.capabilityLevel).toBe('cookie-only');
      expect(platform.capabilityNote).toBe(COOKIE_ONLY_CAPABILITY_NOTE);
      expect(supportsAccountApi(platform)).toBe(false);
    }
    expect(COOKIE_ONLY_CAPABILITY_NOTE).toBe('Cookie 直填、账号能力未验证');
  });

  it('cookie-only 平台不携带任何账号 API 字段（不承诺未实现能力）', () => {
    for (const key of COOKIE_ONLY_KEYS) {
      const platform = platformOf(key);
      expect(platform.memberApi).toBeUndefined();
      expect(platform.accountApi).toBeUndefined();
    }
  });

  it('能力等级与 API 声明一致：声明漂移即失败', () => {
    for (const platform of getAllPlatforms()) {
      const hasAccountApi = Boolean(platform.accountApi);
      const hasMemberApi = Boolean(platform.memberApi);
      if (platform.capabilityLevel === 'full-api') {
        expect(hasAccountApi, `${platform.key} 声明 full-api 但缺 accountApi`).toBe(true);
        expect(hasMemberApi, `${platform.key} 声明 full-api 但缺 memberApi`).toBe(true);
        expect(platform.capabilityNote, `${platform.key} 为 full-api，不应带限能说明`).toBeUndefined();
      } else {
        expect(hasAccountApi, `${platform.key} 声明 cookie-only 却带 accountApi`).toBe(false);
        expect(hasMemberApi, `${platform.key} 声明 cookie-only 却带 memberApi`).toBe(false);
        expect(platform.capabilityNote, `${platform.key} 缺失能力说明`).toBeTruthy();
      }
    }
  });
});
