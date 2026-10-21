import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAST_UNSUPPORTED_MESSAGE, castService } from '@/services/castService';

/**
 * 投屏能力检测（AC-82 / AC-84 / REV-08）
 *
 * 缺陷：`isSupported()` 按 `navigator.share` 判断，桌面 Chrome 有该 API → Web 返回 true，
 * 与 AC-84「`Capacitor.getPlatform() === 'web'` 时返回 false」相反；点投屏后得到
 * "Must be handling a user gesture…" → Toast「操作失败，请重试」。
 *
 * 修复：Web 一律 false；`cast()` 返回 `reason: 'unsupported-platform'` 且不抛异常。
 */

/** 覆盖全局 Capacitor 桥（模拟原生/Web 平台） */
function setPlatform(platform: 'web' | 'android' | null): void {
  const globalObject = globalThis as { Capacitor?: unknown };
  if (platform === null) {
    delete globalObject.Capacitor;
    return;
  }
  globalObject.Capacitor = {
    getPlatform: () => platform,
    isNativePlatform: () => platform !== 'web',
    isNative: platform !== 'web',
  };
}

/** 模拟"有 Web Share 能力的桌面 Chrome" */
function stubWebShare(): void {
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    writable: true,
    value: vi.fn(async () => undefined),
  });
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
}

function restoreWebShare(): void {
  // happy-dom 默认没有这两个成员：直接删除以恢复原状
  try {
    delete (navigator as { share?: unknown }).share;
    delete (navigator as { canShare?: unknown }).canShare;
  } catch {
    // 忽略
  }
}

const URL_REQUEST = {
  kind: 'url' as const,
  url: 'https://cdn.example.com/a.mp4',
  mime: 'video/mp4',
  title: '测试影片',
  linkedUrl: 'https://cdn.example.com/a.mp4',
};

describe('castService 平台能力检测（AC-82 / AC-84）', () => {
  beforeEach(() => {
    stubWebShare();
    setPlatform('web');
  });

  afterEach(() => {
    restoreWebShare();
    setPlatform(null);
  });

  it('Web 平台：即使 navigator.share 可用，isSupported() 也返回 false（AC-84）', async () => {
    expect(typeof navigator.share).toBe('function');
    await expect(castService.isSupported()).resolves.toBe(false);
  });

  it('Web 平台：cast() 返回 unsupported-platform 且不抛异常（AC-82）', async () => {
    const result = await castService.cast(URL_REQUEST);
    expect(result).toEqual({ started: false, reason: 'unsupported-platform', error: null });
    // 不得调用 Web Share，避免触发"Must be handling a user gesture"这类技术错误
    expect(navigator.share).not.toHaveBeenCalled();
  });

  it('降级提示文案与 AC-82 一致（UI 直接展示该文案）', () => {
    expect(CAST_UNSUPPORTED_MESSAGE).toBe('当前环境不支持系统投屏（仅 Android App 可用）');
  });

  it('无 Capacitor 桥（纯浏览器）同样视为 Web：isSupported=false', async () => {
    setPlatform(null);
    await expect(castService.isSupported()).resolves.toBe(false);
    await expect(castService.cast(URL_REQUEST)).resolves.toEqual({
      started: false,
      reason: 'unsupported-platform',
      error: null,
    });
  });

  it('Android 原生但插件未注册：isSupported=false，cast() 降级不抛异常（模拟器场景）', async () => {
    setPlatform('android');
    await expect(castService.isSupported()).resolves.toBe(false);
    await expect(castService.cast(URL_REQUEST)).resolves.toMatchObject({
      started: false,
      reason: 'unsupported-platform',
    });
  });

  it('原生环境但 url 为空：返回 no-target（不误报平台不支持）', async () => {
    setPlatform('android');
    const result = await castService.cast({ ...URL_REQUEST, url: '' });
    expect(result).toEqual({ started: false, reason: 'no-target', error: null });
  });
});
