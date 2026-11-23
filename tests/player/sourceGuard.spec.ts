/**
 * 播放源前置守卫测试（AC-40 / FR-17）
 *
 * 覆盖要求：
 * - `.mpd`（含 `.mpd?a=1` 这类带 query 的形式）→ `E_UNSUPPORTED_FORMAT`
 * - m3u8 清单含 `#EXT-X-KEY:METHOD=SAMPLE-AES` → `E_DRM_PROTECTED`
 * - 普通 m3u8 / mp4 / webm / ts → 放行（返回 null）
 * - `preflightManifest`：仅 m3u8 发请求、可取消、失败一律放行（不误判 DRM）
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assertSourceSupported,
  containsSampleAes,
  detectUnsupportedSource,
  isDashUrl,
  isM3u8Url,
  preflightManifest,
} from '@/player/sourceGuard';
import { DASH_UNSUPPORTED_MESSAGE } from '@/shared/sourceFailure';
import { AppError } from '@/shared/errors';

const SAMPLE_AES_MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.example.com/widevine"',
  '#EXTINF:10,',
  'seg-1.ts',
].join('\n');

const PLAIN_MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:10,',
  'seg-1.ts',
].join('\n');

describe('sourceGuard.detectUnsupportedSource（AC-40）', () => {
  it('.mpd → E_UNSUPPORTED_FORMAT，且不重试', () => {
    const error = detectUnsupportedSource('https://cdn.example.com/manifest.mpd');
    expect(error).toBeInstanceOf(AppError);
    expect(error?.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(error?.message).toBe(DASH_UNSUPPORTED_MESSAGE);
    // OPT-26（P0-②-1）：抛错处就带子原因，分类不再靠文案猜——DASH 不能被念成「种子」
    expect(error?.reason).toBe('dash_manifest');
    expect(error?.retryable).toBe(false);
  });

  it('带 query/hash 的 .mpd?a=1 仍识别为 DASH', () => {
    const error = detectUnsupportedSource('https://cdn.example.com/manifest.mpd?a=1&token=x#frag');
    expect(error?.code).toBe('E_UNSUPPORTED_FORMAT');
  });

  it('大写 .MPD 也识别为 DASH', () => {
    expect(detectUnsupportedSource('https://cdn.example.com/manifest.MPD')?.code).toBe(
      'E_UNSUPPORTED_FORMAT',
    );
  });

  it('m3u8 + SAMPLE-AES → E_DRM_PROTECTED', () => {
    const error = detectUnsupportedSource('https://cdn.example.com/index.m3u8', SAMPLE_AES_MANIFEST);
    expect(error).toBeInstanceOf(AppError);
    expect(error?.code).toBe('E_DRM_PROTECTED');
    expect(error?.message).toBe('不支持受保护内容');
    expect(error?.retryable).toBe(false);
  });

  it('URL 自身带 #EXT-X-KEY:METHOD=SAMPLE-AES 标记也能识别', () => {
    const url = 'https://cdn.example.com/index.m3u8#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"';
    expect(detectUnsupportedSource(url)?.code).toBe('E_DRM_PROTECTED');
  });

  it('普通 m3u8 放行', () => {
    expect(detectUnsupportedSource('https://cdn.example.com/index.m3u8', PLAIN_MANIFEST)).toBeNull();
    expect(detectUnsupportedSource('https://cdn.example.com/index.m3u8')).toBeNull();
  });

  it('普通 mp4/webm/ts 放行', () => {
    expect(detectUnsupportedSource('https://cdn.example.com/a.mp4')).toBeNull();
    expect(detectUnsupportedSource('https://cdn.example.com/a.mp4?token=1')).toBeNull();
    expect(detectUnsupportedSource('https://cdn.example.com/a.webm')).toBeNull();
    expect(detectUnsupportedSource('https://cdn.example.com/a.ts')).toBeNull();
  });

  it('空地址放行（由上层做地址校验）', () => {
    expect(detectUnsupportedSource('')).toBeNull();
    expect(detectUnsupportedSource(null)).toBeNull();
    expect(detectUnsupportedSource(undefined)).toBeNull();
  });

  it('AES-128 与其它 METHOD 不算受保护内容（仅 SAMPLE-AES）', () => {
    const aes = PLAIN_MANIFEST.replace('#EXT-X-TARGETDURATION:10', '#EXT-X-KEY:METHOD=AES-128,URI="key"');
    expect(detectUnsupportedSource('https://cdn.example.com/index.m3u8', aes)).toBeNull();
  });

  it('带单引号的 METHOD=SAMPLE-AES 也命中（真实清单存在该写法）', () => {
    const text = PLAIN_MANIFEST.replace(
      '#EXT-X-TARGETDURATION:10',
      "#EXT-X-KEY:METHOD='SAMPLE-AES',URI=\"key\"",
    );
    expect(detectUnsupportedSource('https://cdn.example.com/index.m3u8', text)?.code).toBe(
      'E_DRM_PROTECTED',
    );
  });

  it('assertSourceSupported 命中 DASH 时抛出 AppError', () => {
    expect(() => assertSourceSupported('https://cdn.example.com/manifest.mpd')).toThrow(AppError);
    try {
      assertSourceSupported('https://cdn.example.com/manifest.mpd');
    } catch (e) {
      expect((e as AppError).code).toBe('E_UNSUPPORTED_FORMAT');
    }
  });

  it('mpd 优先于 SAMPLE-AES 判定（DASH 先拒绝）', () => {
    const error = detectUnsupportedSource(
      'https://cdn.example.com/manifest.mpd',
      SAMPLE_AES_MANIFEST,
    );
    expect(error?.code).toBe('E_UNSUPPORTED_FORMAT');
  });
});

describe('sourceGuard URL 判定辅助函数', () => {
  it('isDashUrl 忽略 query/hash', () => {
    expect(isDashUrl('https://a.com/x.mpd?token=1#x')).toBe(true);
    expect(isDashUrl('https://a.com/x.m3u8')).toBe(false);
    expect(isDashUrl('')).toBe(false);
  });

  it('isM3u8Url 忽略 query/hash', () => {
    expect(isM3u8Url('https://a.com/x.m3u8?token=1')).toBe(true);
    expect(isM3u8Url('https://a.com/x.mp4')).toBe(false);
    expect(isM3u8Url(null)).toBe(false);
  });

  it('containsSampleAes 对空值返回 false', () => {
    expect(containsSampleAes(null)).toBe(false);
    expect(containsSampleAes('')).toBe(false);
    expect(containsSampleAes(undefined)).toBe(false);
  });
});

describe('sourceGuard.preflightManifest（AC-40 预检约束）', () => {
  const headers = { Referer: 'https://cdn.example.com' };

  /** 类型放宽到 `RequestInfo | URL`，与 DOM 的 `fetch` 签名对齐（便于直接注入） */
  /** 同步返回 Response 的写法在测试里更直观，这里统一包成 Promise */
  function makeFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(impl(input, init)));
  }

  it('仅对 m3u8 发请求；.mpd / mp4 不发任何请求', async () => {
    const fetchImpl = makeFetch(() => new Response(PLAIN_MANIFEST));
    expect(await preflightManifest('https://a.com/manifest.mpd', { fetchImpl })).toBeNull();
    expect(await preflightManifest('https://a.com/a.mp4', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('m3u8 返回清单文本，并带上超时信号与站点头', async () => {
    const fetchImpl = makeFetch((_url, init) => {
      expect(init?.signal).toBeDefined();
      return new Response(PLAIN_MANIFEST);
    });
    const text = await preflightManifest('https://a.com/index.m3u8', { fetchImpl, headers });
    expect(text).toContain('#EXTINF');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect((call[1]?.headers as Record<string, string>).Referer).toBe('https://cdn.example.com');
  });

  it('非 2xx（403/404）一律放行，不判 DRM', async () => {
    const fetchImpl = makeFetch(() => new Response('forbidden', { status: 403 }));
    expect(await preflightManifest('https://a.com/index.m3u8', { fetchImpl })).toBeNull();
  });

  it('网络失败一律放行（不把网络抖动当 DRM）', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await preflightManifest('https://a.com/index.m3u8', { fetchImpl })).toBeNull();
  });

  it('外部 AbortSignal 已中止时不发请求', async () => {
    const fetchImpl = makeFetch(() => new Response(PLAIN_MANIFEST));
    const controller = new AbortController();
    controller.abort();
    expect(
      await preflightManifest('https://a.com/index.m3u8', { fetchImpl, signal: controller.signal }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('外部 AbortSignal 中止在飞请求', async () => {
    const controller = new AbortController();
    const fetchImpl = makeFetch((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const promise = preflightManifest('https://a.com/index.m3u8', {
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();
    expect(await promise).toBeNull();
  });

  it('SAMPLE-AES 清单返回文本，交由上层判定', async () => {
    const fetchImpl = makeFetch(() => new Response(SAMPLE_AES_MANIFEST));
    const text = await preflightManifest('https://a.com/index.m3u8', { fetchImpl });
    expect(detectUnsupportedSource('https://a.com/index.m3u8', text)?.code).toBe('E_DRM_PROTECTED');
  });
});
