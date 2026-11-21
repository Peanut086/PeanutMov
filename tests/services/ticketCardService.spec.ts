/**
 * 观影口令「票根卡」（G-C10）的版式几何与导出通路。
 *
 * 两块最要紧的事各按一条断言钉住：
 * 1. **协议没被版式改动**——卡上印的就是 `encodeShareCode` 那串原文，
 *    正常情况下整串一行画完，不会被省略号截成一条粘了也没用的口令；
 * 2. **条码不假装能扫**——44 根条由正文散列出确定形状，同时卡面直接印「装饰条码 · 不可扫描」。
 *
 * 版式几何用记账型假画布核对：坐标 NaN 在真画布上只是静默不画，肉眼要翻很久。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadPoster: vi.fn(),
  ensureDir: vi.fn(),
  writeBase64: vi.fn(),
  fsAvailable: { value: true },
  base64: { value: 'AA==' },
  shareAvailable: { value: true },
  shareFile: vi.fn(),
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
  TICKET_BARCODE_NOTE,
  TICKET_BARS,
  TICKET_CAPTION,
  TICKET_H,
  TICKET_W,
  composeTicketCard,
  renderTicketCard,
  shareTicketCard,
  ticketBarWidths,
  type TicketContent,
} from '@/services/ticketCardService';
import { encodeShareCode } from '@/services/shareCodeService';
import { formatDateStamp } from '@/shared/time';

function codeOf(title = '庆余年 第二季'): string {
  return encodeShareCode({ title, year: 2024, episodeNumber: 5, positionSec: 312 });
}

function ticket(overrides: Partial<TicketContent> = {}): TicketContent {
  return {
    title: '庆余年 第二季',
    meta: '2024 · 中国大陆 · 古装',
    episodeLabel: '第 5 集',
    code: codeOf(),
    positionSec: 312,
    durationSec: 2700,
    posterUrl: null,
    accent: null,
    viewer: 'owner',
    ...overrides,
  };
}

interface Recorded {
  op: string;
  args: unknown[];
}

/** 假画布：只记账，外加一个按字号估宽的 measureText（字号阶梯要靠它） */
function fakeCtx() {
  const calls: Recorded[] = [];
  const track = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const state = { font: '' };
  const ctx = {
    canvas: { width: TICKET_W, height: TICKET_H },
    get font(): string {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textBaseline: '',
    globalAlpha: 1,
    filter: 'none',
    save: track('save'),
    restore: track('restore'),
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
    measureText: (text: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 0);
      let width = 0;
      for (const ch of String(text)) width += ch.charCodeAt(0) <= 0xff ? size * 0.55 : size;
      return { width };
    },
    fillText: track('fillText'),
    drawImage: track('drawImage'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, drawn: () => state.font };
}

function nonFiniteOps(calls: Recorded[]): Recorded[] {
  return calls.filter((c) => c.args.some((a) => typeof a === 'number' && !Number.isFinite(a)));
}

function texts(calls: Recorded[]): string[] {
  return calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
}

beforeEach(() => {
  h.loadPoster.mockReset();
  h.ensureDir.mockReset();
  h.writeBase64.mockReset();
  h.shareFile.mockReset();
  h.fsAvailable.value = true;
  h.base64.value = 'AA==';
  h.shareAvailable.value = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ticketBarWidths', () => {
  it('固定 44 根，每根 1~3 个整数单位', () => {
    const widths = ticketBarWidths(codeOf());
    expect(widths).toHaveLength(TICKET_BARS);
    for (const w of widths) {
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(3);
    }
  });

  it('同一串口令永远画出同一副条码', () => {
    expect(ticketBarWidths(codeOf())).toEqual(ticketBarWidths(codeOf()));
  });

  it('正文换一个字符就换一副样子（它跟着口令走，不是一串固定花纹）', () => {
    expect(ticketBarWidths(codeOf('庆余年 第二季'))).not.toEqual(ticketBarWidths(codeOf('庆余年 第三季')));
  });

  it('空正文也不炸：照样给 44 根', () => {
    expect(ticketBarWidths('')).toHaveLength(TICKET_BARS);
  });
});

describe('composeTicketCard 版式几何', () => {
  it('两种视角画到画布上的数字都是有限数', () => {
    for (const viewer of ['owner', 'receiver'] as const) {
      const { ctx, calls } = fakeCtx();
      composeTicketCard(ctx, ticket({ viewer }), { hero: { source: {} as CanvasImageSource, width: 600, height: 900 }, cells: [] });
      expect(nonFiniteOps(calls), `${viewer} 视角出现非法坐标`).toEqual([]);
    }
  });

  it('卡上印的就是口令原文，一整个字符串、没有省略号', () => {
    const { ctx, calls } = fakeCtx();
    const code = codeOf();
    composeTicketCard(ctx, ticket({ code }), { hero: null, cells: [] });

    expect(texts(calls)).toContain(code);
    expect(texts(calls).some((t) => t.endsWith('…') && t.includes('PeanutMov'))).toBe(false);
  });

  it('降到最小字号仍装不下才截断，且只画一行（base64 串断不开，折行会画到卡外）', () => {
    const { ctx, calls } = fakeCtx();
    const huge = `#PeanutMov1.${'a'.repeat(300)}#`;
    composeTicketCard(ctx, ticket({ code: huge }), { hero: null, cells: [] });

    const codeLines = texts(calls).filter((t) => t.startsWith('#PeanutMov1.'));
    expect(codeLines).toHaveLength(1);
    expect(codeLines[0]!.endsWith('…')).toBe(true);
    expect(codeLines[0]!.length).toBeLessThan(huge.length);
  });

  it('直接印上「装饰条码 · 不可扫描」，不给任何可扫的暗示', () => {
    const { ctx, calls } = fakeCtx();
    composeTicketCard(ctx, ticket(), { hero: null, cells: [] });
    expect(texts(calls)).toContain(TICKET_BARCODE_NOTE);
  });

  it('条码画出 44 根竖条，全部落在白底板内', () => {
    const { ctx, calls } = fakeCtx();
    composeTicketCard(ctx, ticket(), { hero: null, cells: [] });

    // 竖条高 = 底板高 112 − 上下各 18
    const bars = calls.filter((c) => c.op === 'fillRect' && c.args[3] === 112 - 36);
    expect(bars).toHaveLength(TICKET_BARS);
    for (const bar of bars) {
      expect(Number(bar.args[0])).toBeGreaterThanOrEqual(752);
      expect(Number(bar.args[2])).toBeLessThanOrEqual(264);
    }
  });

  it('视角只换那句说明，坐标信息两边完全一致', () => {
    const owner = fakeCtx();
    composeTicketCard(owner.ctx, ticket({ viewer: 'owner' }), { hero: null, cells: [] });
    const receiver = fakeCtx();
    composeTicketCard(receiver.ctx, ticket({ viewer: 'receiver' }), { hero: null, cells: [] });

    expect(texts(owner.calls)).toContain(TICKET_CAPTION.owner);
    expect(texts(owner.calls)).not.toContain(TICKET_CAPTION.receiver);
    expect(texts(receiver.calls)).toContain(TICKET_CAPTION.receiver);

    const ownerInfo = texts(owner.calls).filter((t) => !Object.values(TICKET_CAPTION).includes(t as never));
    const receiverInfo = texts(receiver.calls).filter((t) => !Object.values(TICKET_CAPTION).includes(t as never));
    expect(ownerInfo).toEqual(receiverInfo);
  });

  it('片名、集号、元信息与这一刻都在卡上', () => {
    const { ctx, calls } = fakeCtx();
    composeTicketCard(ctx, ticket(), { hero: null, cells: [] });

    const all = texts(calls);
    expect(all).toContain('庆余年 第二季');
    expect(all.some((t) => t.includes('第 5 集') && t.includes('2024'))).toBe(true);
    expect(all).toContain('05:12');
    expect(all.some((t) => t.startsWith('/ '))).toBe(true);
    expect(all).toContain(formatDateStamp());
  });

  it('时长未知只写已看到的位置，不编一个分母、也不画假进度', () => {
    const known = fakeCtx();
    composeTicketCard(known.ctx, ticket(), { hero: null, cells: [] });
    const unknown = fakeCtx();
    composeTicketCard(unknown.ctx, ticket({ durationSec: 0 }), { hero: null, cells: [] });

    expect(texts(unknown.calls).some((t) => t.startsWith('/ '))).toBe(false);
    // 轨道永远画， filled 段只在时长已知时画
    expect(known.calls.filter((c) => c.op === 'fillRect' && c.args[3] === 7)).toHaveLength(0);
    const trackOf = (calls: Recorded[]) =>
      calls.filter((c) => c.op === 'quadraticCurveTo').length;
    expect(trackOf(unknown.calls)).toBeLessThan(trackOf(known.calls));
  });

  it('撕票线的两枚缺口压在卡边上，画得出才叫缺口（整圆在卡外等于没画）', () => {
    const { ctx, calls } = fakeCtx();
    composeTicketCard(ctx, ticket(), { hero: null, cells: [] });

    const notches = calls.filter((c) => c.op === 'arc');
    expect(notches.map((c) => [Number(c.args[0]), Number(c.args[1])])).toEqual([
      [712, 0],
      [712, TICKET_H],
    ]);
    // 只取撕票线上那两段（底栏分隔线也是 moveTo/lineTo，但 x 不在 712）
    const tear = calls.filter((c) => (c.op === 'moveTo' || c.op === 'lineTo') && Number(c.args[0]) === 712);
    expect(tear.map((c) => Number(c.args[1]))).toEqual([40, TICKET_H - 40]);
  });

  it('没有海报就没有任何 drawImage，不拿别的图凑氛围底', () => {
    const { ctx, calls } = fakeCtx();
    composeTicketCard(ctx, ticket(), { hero: null, cells: [] });
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(0);

    const withPoster = fakeCtx();
    composeTicketCard(withPoster.ctx, ticket(), {
      hero: { source: {} as CanvasImageSource, width: 600, height: 900 },
      cells: [],
    });
    expect(withPoster.calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(0);
  });

  it('标题超长也只占两行，其余交给省略号（口令那行才是不能截的）', () => {
    const { ctx, calls } = fakeCtx();
    composeTicketCard(ctx, ticket({ title: '一二三四五六七八'.repeat(6) }), { hero: null, cells: [] });
    const titleLines = texts(calls).filter((t) => /^[一二三四五六七八…]+$/.test(t));
    expect(titleLines).toHaveLength(2);
    expect(titleLines[1]!.endsWith('…')).toBe(true);
  });
});

describe('renderTicketCard / shareTicketCard', () => {
  it('画布尺寸就是 1080 × 540，导出就是一张 PNG', async () => {
    const ctx = fakeCtx();
    let canvas: { width: number; height: number } | null = null;
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return realCreate(tag);
      const stub = {
        width: 0,
        height: 0,
        getContext: () => ctx.ctx,
        toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
      };
      canvas = stub;
      return stub as unknown as HTMLCanvasElement;
    });

    const blob = await renderTicketCard(ticket());

    expect(canvas).not.toBeNull();
    expect(canvas!.width).toBe(TICKET_W);
    expect(canvas!.height).toBe(TICKET_H);
    expect(blob.type).toBe('image/png');
    // 海报取数走的是明信片同一条字节通路
    expect(h.loadPoster).not.toHaveBeenCalled();
  });

  it('原生：落盘到 tickets/，绝不覆盖明信片那一张', async () => {
    h.shareFile.mockResolvedValue(true);
    const result = await shareTicketCard(new Blob(['png'], { type: 'image/png' }), '庆余年');

    expect(result.ok).toBe(true);
    expect(h.ensureDir).toHaveBeenCalledWith('tickets');
    expect(h.writeBase64).toHaveBeenCalledWith('tickets/ticket.png', 'AA==');
    expect(h.shareFile).toHaveBeenCalledWith({
      path: 'tickets/ticket.png',
      mime: 'image/png',
      title: '庆余年',
    });
  });

  it('没有分享面板：说清没走通，而不是静默', async () => {
    h.shareAvailable.value = false;
    const result = await shareTicketCard(new Blob(['png']), 't');
    expect(result).toEqual({ ok: false, reason: 'no-target', message: '本机没有分享面板' });
  });

  it('Web 环境退回浏览器下载，文件名是票根不是明信片', async () => {
    vi.useFakeTimers();
    h.fsAvailable.value = false;
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

    const result = await shareTicketCard(new Blob(['png']), 't');

    expect(result.ok).toBe(true);
    expect(anchor.download).toBe('ticket.png');
    expect(h.writeBase64).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
