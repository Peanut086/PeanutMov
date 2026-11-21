import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { requestBytes } from '@/services/danmaku/nativeHttp';
import { __resetPaletteCache, paletteForPoster, peekPalette } from '@/services/paletteService';

/**
 * 取色缓存的两条边界（G-B01 色相墙依赖于此）：
 * - 「查过、判定灰调」要能和「根本没查过」区分开（`kvRepo.get` 对两者都给 null，所以负结论得单独落库）；
 * - `peekPalette` 只读缓存，绝不联网、绝不解码——整墙浏览靠它，否则首屏变成几十张大图请求。
 */
vi.mock('@/db/repositories/kvRepo', () => ({
  kvRepo: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
}));

vi.mock('@/services/danmaku/nativeHttp', () => ({
  requestBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

const SAMPLE_PIXELS = 36 * 54;

/** happy-dom 没有真画布：把取样画布换成「整张都是同一个颜色」的假上下文 */
function stubFlatColor(rgb: [number, number, number]): void {
  const data = new Uint8ClampedArray(SAMPLE_PIXELS * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: vi.fn(),
        getImageData: () => ({ data, width: 36, height: 54 }),
      }) as unknown as CanvasRenderingContext2D,
  );
}

beforeEach(() => {
  __resetPaletteCache();
  vi.mocked(kvRepo.get).mockReset();
  vi.mocked(kvRepo.get).mockResolvedValue(null);
  vi.mocked(kvRepo.set).mockReset();
  vi.mocked(requestBytes).mockReset();
  vi.mocked(requestBytes).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 36, height: 54 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('peekPalette · 只读缓存', () => {
  it('非 http(s) 的海报地址一律当作「没结论」，不碰网络', async () => {
    for (const url of [null, undefined, '', 'data:image/png;base64,AAA', 'blob:https://x/1']) {
      await expect(peekPalette(url)).resolves.toEqual({ known: false, seed: null });
    }
    expect(kvRepo.get).not.toHaveBeenCalled();
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('缓存里有主色就返回主色，不去下载海报', async () => {
    vi.mocked(kvRepo.get).mockResolvedValue({ h: 200, s: 0.5, l: 0.5 });
    await expect(peekPalette('https://cdn/a.jpg')).resolves.toEqual({
      known: true,
      seed: { h: 200, s: 0.5, l: 0.5 },
    });
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('负记录读成「已知但无主色」，与未查过区分开', async () => {
    vi.mocked(kvRepo.get).mockResolvedValue({ none: true });
    await expect(peekPalette('https://cdn/grey.jpg')).resolves.toEqual({ known: true, seed: null });
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('完全没结论时返回 cold，调用方自己决定要不要补取', async () => {
    await expect(peekPalette('https://cdn/new.jpg')).resolves.toEqual({ known: false, seed: null });
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it('缓存读失败不抛，退化成 cold', async () => {
    vi.mocked(kvRepo.get).mockRejectedValue(new Error('db closed'));
    await expect(peekPalette('https://cdn/a.jpg')).resolves.toEqual({ known: false, seed: null });
  });
});

describe('paletteForPoster · 负记录落库', () => {
  it('灰调海报落 {none:true}，之后整墙可以直接判定它不用再看', async () => {
    stubFlatColor([128, 128, 128]);
    await expect(paletteForPoster('https://cdn/grey.jpg')).resolves.toBeNull();
    expect(kvRepo.set).toHaveBeenCalledWith(expect.stringContaining('palette:v1:'), { none: true });

    await expect(peekPalette('https://cdn/grey.jpg')).resolves.toEqual({ known: true, seed: null });
  });

  it('有主色的海报落 HSL 种子，重复调用只走内存', async () => {
    stubFlatColor([255, 0, 0]);
    const seed = await paletteForPoster('https://cdn/red.jpg');
    expect(seed).not.toBeNull();
    expect(seed!.h).toBeCloseTo(0, 0);
    expect(seed!.s).toBeCloseTo(1, 5);
    expect(kvRepo.set).toHaveBeenCalledWith(expect.stringContaining('palette:v1:'), seed);

    await expect(paletteForPoster('https://cdn/red.jpg')).resolves.toEqual(seed);
    expect(requestBytes).toHaveBeenCalledTimes(1);
    expect(kvRepo.get).toHaveBeenCalledTimes(1);
  });

  it('已有结论（含负记录）时不再解码海报', async () => {
    vi.mocked(kvRepo.get).mockResolvedValue({ none: true });
    await expect(paletteForPoster('https://cdn/grey.jpg')).resolves.toBeNull();
    expect(requestBytes).not.toHaveBeenCalled();
    expect(kvRepo.set).not.toHaveBeenCalled();
  });

  it('200 空响应算解码失败，不写「灰调」结论', async () => {
    stubFlatColor([255, 0, 0]);
    vi.mocked(requestBytes).mockResolvedValue(new Uint8Array());
    await expect(paletteForPoster('https://cdn/empty.jpg')).resolves.toBeNull();
    expect(kvRepo.set).not.toHaveBeenCalled();
  });

  it('拉流失败同样不落负记录：下次进来还会再试', async () => {
    stubFlatColor([255, 0, 0]);
    vi.mocked(requestBytes).mockRejectedValue(new Error('404'));
    await expect(paletteForPoster('https://cdn/404.jpg')).resolves.toBeNull();
    expect(kvRepo.set).not.toHaveBeenCalled();
  });

  it('createImageBitmap 不可用（老 WebView）时安静返回 null', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(paletteForPoster('https://cdn/a.jpg')).resolves.toBeNull();
    expect(kvRepo.set).not.toHaveBeenCalled();
  });
});
