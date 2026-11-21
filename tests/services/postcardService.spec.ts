import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「一帧明信片」（G-C04）的取数与导出通路。
 *
 * 版式几何用假画布钉住：坐标 NaN 在真画布上只是静默不画，肉眼要翻很久，
 * 所以这里断言"每个落到画布上的数字都是有限数"，比截图更早发现问题。
 */

const h = vi.hoisted(() => ({
  available: { value: true },
  extract: vi.fn(),
  loadPoster: vi.fn(),
  ensureDir: vi.fn(),
  writeBase64: vi.fn(),
  fsAvailable: { value: true },
  base64: { value: 'AA==' },
  shareAvailable: { value: true },
  shareFile: vi.fn(),
}));

vi.mock('@/native/mediaToolPlugin', () => ({
  isMediaToolAvailable: () => h.available.value,
  extractSeekFrames: h.extract,
}));

vi.mock('@/native/fs', () => ({
  isFsAvailable: () => h.fsAvailable.value,
  ensureDir: h.ensureDir,
  writeBase64: h.writeBase64,
  blobToArrayBuffer: (blob: Blob) => blob.arrayBuffer(),
  arrayBufferToBase64: (buffer: ArrayBuffer) => (buffer.byteLength > 0 ? h.base64.value : ''),
}));

vi.mock('@/native/castPlugin', () => ({
  isCastShareAvailable: async () => h.shareAvailable.value,
  shareFile: h.shareFile,
}));

vi.mock('@/services/paletteService', () => ({
  loadPosterImage: h.loadPoster,
}));

vi.mock('@/shared/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import {
  composePostcard,
  fetchPostcardFrames,
  loadPostcardAssets,
  postcardFrameTimes,
  sharePostcard,
  wrapText,
  type PostcardContent,
  type Drawable,
} from '@/services/postcardService';

function content(overrides: Partial<PostcardContent> = {}): PostcardContent {
  return {
    title: '尖峰时刻',
    meta: '1998 · 美国 · 动作',
    episodeLabel: '第 3 集',
    line: '我们走错路了。',
    positionSec: 102.6,
    durationSec: 600,
    posterUrl: 'https://example.test/p.jpg',
    frames: [],
    accent: null,
    ...overrides,
  };
}

function drawable(width = 600, height = 900, crop?: Drawable['crop']): Drawable {
  return { source: {} as CanvasImageSource, width, height, crop };
}

interface Recorded {
  op: string;
  args: unknown[];
}

/** 记账型假画布：只关心"调了什么、坐标是不是数"，不模拟任何真实绘制 */
function fakeCtx() {
  const calls: Recorded[] = [];
  const track = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const ctx = {
    canvas: { width: 1080, height: 1350 },
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineDashOffset: 0,
    textBaseline: '',
    globalAlpha: 1,
    filter: 'none',
    save: () => undefined,
    restore: () => undefined,
    clearRect: track('clearRect'),
    fillRect: track('fillRect'),
    beginPath: track('beginPath'),
    closePath: track('closePath'),
    moveTo: track('moveTo'),
    lineTo: track('lineTo'),
    quadraticCurveTo: track('quadraticCurveTo'),
    arc: track('arc'),
    fill: track('fill'),
    stroke: track('stroke'),
    clip: track('clip'),
    setLineDash: track('setLineDash'),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    measureText: (text: string) => ({ width: text.length * 22 }),
    fillText: track('fillText'),
    drawImage: track('drawImage'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D & typeof ctx, calls };
}

function nonFiniteOps(calls: Recorded[]): Recorded[] {
  return calls.filter((c) =>
    c.args.some((a) => typeof a === 'number' && !Number.isFinite(a)),
  );
}

beforeEach(() => {
  h.available.value = true;
  h.extract.mockReset();
  h.loadPoster.mockReset();
  h.ensureDir.mockReset();
  h.writeBase64.mockReset();
  h.fsAvailable.value = true;
  h.base64.value = 'AA==';
  h.shareAvailable.value = true;
  h.shareFile.mockReset();
});

describe('postcardFrameTimes', () => {
  it('中间是此刻，左右各推 6 秒', () => {
    expect(postcardFrameTimes(100, 600)).toEqual([94000, 100000, 106000]);
  });

  it('贴着片头/片尾时贴回边界，并去掉撞在一起的重复点', () => {
    expect(postcardFrameTimes(2, 600)).toEqual([0, 2000, 8000]);
    expect(postcardFrameTimes(599, 600)).toEqual([593000, 599000, 599999]);
    expect(postcardFrameTimes(0, 3)).toEqual([0, 2999]);
  });

  it('时长未知只取此刻：没有分母就不假装那是同一场戏的三格', () => {
    expect(postcardFrameTimes(180, 0)).toEqual([180000]);
  });
});

describe('fetchPostcardFrames', () => {
  it('没有抽帧桥：不碰原生', async () => {
    h.available.value = false;
    const result = await fetchPostcardFrames('downloads/m1/e2.mp4', 100, 600);
    expect(result).toEqual({ frames: [], reason: 'no-bridge' });
    expect(h.extract).not.toHaveBeenCalled();
  });

  it('在线源没有本机文件：给出可解释的原因', async () => {
    const result = await fetchPostcardFrames(null, 100, 600);
    expect(result).toEqual({ frames: [], reason: 'no-file' });
    expect(h.extract).not.toHaveBeenCalled();
  });

  it('按 256 长边、82 质量抽三帧', async () => {
    h.extract.mockResolvedValue(['data:image/jpeg;base64,A', 'data:image/jpeg;base64,B', 'data:image/jpeg;base64,C']);
    const result = await fetchPostcardFrames('downloads/m1/e2.mp4', 100, 600);

    expect(h.extract).toHaveBeenCalledWith('downloads/m1/e2.mp4', [94000, 100000, 106000], 256, 82);
    expect(result.reason).toBe('ok');
    expect(result.frames).toHaveLength(3);
  });

  it('原生回空/回失败都算抽不出，且不留下脏帧', async () => {
    h.extract.mockResolvedValue([null, '', 'data:image/jpeg;base64,B']);
    expect((await fetchPostcardFrames('p', 100, 600)).frames).toEqual(['data:image/jpeg;base64,B']);

    h.extract.mockRejectedValue(new Error('boom'));
    expect(await fetchPostcardFrames('p', 100, 600)).toEqual({ frames: [], reason: 'none' });

    h.extract.mockResolvedValue(null);
    expect(await fetchPostcardFrames('p', 100, 600)).toEqual({ frames: [], reason: 'none' });
  });
});

describe('loadPostcardAssets', () => {
  it('海报档：主图是海报，胶片格是同一张海报的上中下三窗', async () => {
    h.loadPoster.mockResolvedValue(drawable(600, 900));
    const assets = await loadPostcardAssets(content(), 'poster');

    expect(assets.hero).toBeTruthy();
    expect(assets.cells).toHaveLength(3);
    const ys = assets.cells.map((c) => c.crop?.y ?? -1);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
    for (const cell of assets.cells) expect(cell.crop!.h).toBeGreaterThan(0);
  });

  it('海报取不到（远程失败 / 地址不是图）：主图与格子都空，版式自己留空位', async () => {
    h.loadPoster.mockResolvedValue(null);
    const assets = await loadPostcardAssets(content({ posterUrl: null }), 'poster');
    expect(assets).toEqual({ hero: null, cells: [] });
  });

  it('画面档但没有本机帧：退回海报铺一张，不留一张空卡（UI 已把这档置灰）', async () => {
    h.loadPoster.mockResolvedValue(drawable(600, 900));
    const assets = await loadPostcardAssets(content({ frames: [] }), 'frame');

    expect(assets.hero).toBeTruthy();
    expect(assets.cells).toHaveLength(3);
  });

  it('画面档：三帧各自解码，主图取中间那一帧', async () => {
    class FakeImage {
      decoding = '';
      src = '';
      naturalWidth = 256;
      naturalHeight = 144;
      get width(): number {
        return this.naturalWidth;
      }

      decode(): Promise<void> {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    const assets = await loadPostcardAssets(content({ frames: ['data:a', 'data:b', 'data:c'] }), 'frame');

    expect(assets.cells).toHaveLength(3);
    // hero 是帧里靠中间的那一张，不是第一帧
    expect((assets.hero?.source as FakeImage).src).toBe('data:b');
    // 走画面档时不该再去拉海报
    expect(h.loadPoster).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('composePostcard 版式几何', () => {
  it('三种版式画到画布上的数字都是有限数', () => {
    const assets = { hero: drawable(), cells: [drawable(256, 144), drawable(256, 144), drawable(256, 144)] };
    for (const layout of ['ticket', 'minimal', 'film'] as const) {
      const { ctx, calls } = fakeCtx();
      composePostcard(ctx, layout, content(), assets);
      expect(nonFiniteOps(calls), `${layout} 版式出现非法坐标`).toEqual([]);
    }
  });

  it('时长未知只报已看到的位置，不编一个 00:00 的分母', () => {
    const { ctx, calls } = fakeCtx();
    composePostcard(ctx, 'ticket', content({ durationSec: 0 }), { hero: drawable(), cells: [] });

    const texts = calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
    expect(texts.some((t) => /^01:42$/.test(t))).toBe(true);
    expect(texts.some((t) => t.includes(' / '))).toBe(false);
  });

  it('台词关掉就不出现引号文本；开着才有', () => {
    const withOut = fakeCtx();
    composePostcard(withOut.ctx, 'ticket', content({ line: null }), { hero: drawable(), cells: [] });
    expect(withOut.calls.some((c) => c.op === 'fillText' && /「/.test(String(c.args[0])))).toBe(false);

    const withLine = fakeCtx();
    composePostcard(withLine.ctx, 'ticket', content(), { hero: drawable(), cells: [] });
    expect(withLine.calls.some((c) => c.op === 'fillText' && /「我们走错路了。」/.test(String(c.args[0])))).toBe(true);
  });

  it('没有主图时票根写「无封面」，并且不拿空图调 drawImage', () => {
    const { ctx, calls } = fakeCtx();
    composePostcard(ctx, 'ticket', content(), { hero: null, cells: [] });

    expect(calls.some((c) => c.op === 'fillText' && c.args[0] === '无封面')).toBe(true);
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(0);
  });

  it('胶片格数跟着实际抽到的走，只有两格就画两格', () => {
    const { ctx, calls } = fakeCtx();
    composePostcard(ctx, 'film', content(), { hero: drawable(256, 144), cells: [drawable(256, 144), drawable(256, 144)] });

    const cellDraws = calls.filter((c) => c.op === 'drawImage');
    expect(cellDraws).toHaveLength(2);
    // drawImage 的第 6 个参数才是目标 x（前 5 个是源裁剪矩形）
    const xs = cellDraws.map((c) => Number(c.args[5]));
    expect(xs[1]!).toBeGreaterThan(xs[0]!);
  });

  it('片名与元信息一定落在画布里，且集号出现在票根角上', () => {
    const { ctx, calls } = fakeCtx();
    composePostcard(ctx, 'ticket', content(), { hero: drawable(), cells: [] });

    const texts = calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('尖峰时刻');
    expect(texts.some((t) => t.includes('1998'))).toBe(true);
    expect(texts).toContain('第 3 集');
    expect(texts.some((t) => t.includes('01:42'))).toBe(true);
  });

  it('wrapText：英文词不断行，超行数末行加省略号', () => {
    const { ctx } = fakeCtx();
    expect(wrapText(ctx, 'Rainy  Drive 故事', 132, 4)).toEqual(['Rainy', 'Drive', '故事']);

    const long = wrapText(ctx, 'abcdefghijklmnopqrstuvwxyz', 88, 2);
    expect(long).toHaveLength(2);
    expect(long[1]!.endsWith('…')).toBe(true);
  });
});

describe('sharePostcard', () => {
  it('原生：固定文件名覆盖落盘后交给分享面板', async () => {
    h.shareFile.mockResolvedValue(true);
    const result = await sharePostcard(new Blob(['png'], { type: 'image/png' }), '尖峰时刻');

    expect(result.ok).toBe(true);
    expect(h.ensureDir).toHaveBeenCalledWith('postcards');
    expect(h.writeBase64).toHaveBeenCalledWith('postcards/postcard.png', 'AA==');
    expect(h.shareFile).toHaveBeenCalledWith({
      path: 'postcards/postcard.png',
      mime: 'image/png',
      title: '尖峰时刻',
    });
  });

  it('没有分享面板：说清没走通，而不是静默', async () => {
    h.shareAvailable.value = false;
    const result = await sharePostcard(new Blob(['png'], { type: 'image/png' }), 't');
    expect(result).toEqual({ ok: false, reason: 'no-target', message: '本机没有分享面板' });
    expect(h.shareFile).not.toHaveBeenCalled();
  });

  it('base64 通路缺失（老 WebView）：报编码问题，不落一个空文件', async () => {
    h.base64.value = '';
    const result = await sharePostcard(new Blob(['png'], { type: 'image/png' }), 't');
    expect(result.reason).toBe('encode');
    expect(h.writeBase64).not.toHaveBeenCalled();
  });

  it('分享面板抛错（用户取消也算失败一次）：原样回传原因', async () => {
    h.shareFile.mockRejectedValue(new Error('no activity'));
    const result = await sharePostcard(new Blob(['png'], { type: 'image/png' }), 't');
    expect(result).toMatchObject({ ok: false, reason: 'error', message: 'no activity' });
  });

  it('Web 环境退回浏览器下载', async () => {
    vi.useFakeTimers();
    h.fsAvailable.value = false;
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const realCreate = document.createElement.bind(document);
    // 只在 createElement 的回调里赋值，控制流分析看不到；用定身断言让类型保持在元素本身
    let anchor!: HTMLAnchorElement;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') {
        anchor = el as HTMLAnchorElement;
        el.click = () => undefined;
      }
      return el;
    });

    const result = await sharePostcard(new Blob(['png'], { type: 'image/png' }), 't');

    expect(result.ok).toBe(true);
    expect(anchor.download).toBe('postcard.png');
    expect(create).toHaveBeenCalled();
    expect(h.writeBase64).not.toHaveBeenCalled();
    // 立刻 revoke 会让部分 WebView 取消下载，所以留一段宽限
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledWith('blob:x');

    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
