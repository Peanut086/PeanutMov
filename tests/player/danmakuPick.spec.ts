/**
 * 弹幕命中与单条冻结（B-04 · 渲染层）
 *
 * 这块全是几何，真机上"点不中/点错行/冻结后瞬移"都只能靠坐标核对，所以：
 * 1. 命中框按绘制坐标算（含触控放大余量），点空白必须返回 null；
 * 2. 点中只有那一条停住，其余照常滚；
 * 3. 放行时从冻结处续接，不回头、不瞬移；
 * 4. seek 清场时冻结状态跟着丢，别让操作条悬空。
 *
 * 时钟用假 `performance.now()` 与媒体时间同步推进，这样锚点外插值不引入误差，
 * 断言可以写成精确像素。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DanmakuOverlay } from '@/player/DanmakuOverlay';
import type { DanmakuComment, DanmakuSettings } from '@/types';

const STAGE_W = 720;
const STAGE_H = 405;
/** 假字号下每个字符 8px：'AAAA' → 32、'BBBBBBBB' → 64 */
const CHAR_W = 8;
/** 位图比文字四周留白：strokeStyle=shadow 时 pad = ceil(2/2) + 2，drawImage 的 x 即基线 x − pad */
const PAD = 3;

const SETTINGS: DanmakuSettings = {
  enabled: true,
  fontSize: 16,
  opacity: 0.8,
  speed: 1,
  areaPercent: 50,
  merge: true,
  safeBottomPercent: 15,
  bold: false,
  strokeStyle: 'shadow',
  density: 'normal',
  filterTop: false,
  filterBottom: false,
  interactive: true,
};

interface FakeCtx {
  /** 最近一帧所有 drawImage 的位图左上角 x（= 基线 x − pad，按轨道顺序） */
  draws: number[];
  font: string;
  globalAlpha: number;
}

function makeCtx(): FakeCtx {
  return {
    draws: [],
    font: '',
    globalAlpha: 1,
  };
}

const ctx = makeCtx();
let clockMs = 0;
let mediaSec = 0;
/** 手动喂帧：attach 之前就要装好，否则第一帧跑到真 rAF 上、进不了队列 */
let queue: Array<(t: number) => void> = [];

function rectStub(): DOMRect {
  return {
    left: 0,
    top: 0,
    right: STAGE_W,
    bottom: STAGE_H,
    width: STAGE_W,
    height: STAGE_H,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

interface Rig {
  overlay: DanmakuOverlay;
  /** 走到某个媒体时间并画一帧，返回该帧所有贴图的 x */
  step: (to: number) => number[];
  /** 单帧跨过大段时间：模拟 seek/换集（插值锚点撑不住，渲染层会清场） */
  jump: (to: number) => void;
}

function scrollComment(text: string, time: number, mode: DanmakuComment['mode'] = 'scroll'): DanmakuComment {
  return { text, time, mode, color: 0xffffff };
}

function mount(comments: DanmakuComment[]): Rig {
  mediaSec = 0;
  clockMs = 0;
  const overlay = new DanmakuOverlay({
    settings: SETTINGS,
    getTime: () => mediaSec,
    // 暂停态：绘制时间就是 getTime()，几何可精确断言
    isPlaying: () => false,
    getRate: () => 1,
  });
  const stage = document.createElement('div');
  document.body.appendChild(stage);
  overlay.attach(stage);
  overlay.load(comments);

  function frame(): number[] {
    overlay.tick(mediaSec);
    ctx.draws = [];
    // attach 起的 rAF 循环：喂一帧就够（loop 里会重新排队）
    const pending = queue.splice(0, queue.length);
    pending.forEach((cb) => cb(clockMs));
    return ctx.draws;
  }

  // 每次最多推进 1s：跨太久外推锚点会把它当成 seek 大跳，轨道被清空
  function step(to: number): number[] {
    let last: number[] = [];
    do {
      const next = Math.min(to, mediaSec + 1);
      clockMs += (next - mediaSec) * 1000;
      mediaSec = next;
      last = frame();
    } while (mediaSec < to);
    return last;
  }

  function jump(to: number): void {
    clockMs += (to - mediaSec) * 1000;
    mediaSec = to;
    frame();
  }

  return { overlay, step, jump };
}

beforeEach(() => {
  ctx.draws = [];
  queue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue.length = 0;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectStub);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  // FakeCtx 只需要被 DanmakuOverlay 用到的那几个方法
  Object.assign(ctx, {
    setTransform: () => {},
    clearRect: () => {},
    measureText: (text: string) => ({ width: text.length * CHAR_W }),
    drawImage: (_img: unknown, dx: number) => {
      ctx.draws.push(dx);
    },
    fillText: () => {},
    strokeText: () => {},
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DanmakuOverlay · 命中测试', () => {
  it('点中滚动条目：返回原文与贴图矩形', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5), scrollComment('BBBBBBBB', 5.6)]);
    step(6);
    // 走到中点：A 的 x = 720 - 0.5 * (720 + 32) = 344，基线 y = 20 + 8 = 28
    step(11);

    const hit = overlay.pick(360, 28);
    expect(hit?.comment.text).toBe('AAAA');
    // 位图留白 pad = ceil(2/2) + 2 = 3，高度 = ceil(16 * 1.5) = 24
    expect(hit?.rect).toEqual({ left: 341, top: 16, width: 38, height: 24 });
  });

  it('点空白返回 null，不冻结任何东西', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5), scrollComment('BBBBBBBB', 5.6)]);
    step(6);
    step(11);

    // 第二条在第 1 行（y ≈ 76.6），点到 y=150 属空区
    expect(overlay.pick(360, 150)).toBeNull();
    expect(overlay.pickedComment).toBeNull();
  });

  it('点画面外不算命中：越界坐标直接拒掉', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5)]);
    step(6);
    step(11);

    expect(overlay.pick(-4, 28)).toBeNull();
    expect(overlay.pick(STAGE_W + 40, 28)).toBeNull();
  });

  it('顶部固定弹幕按槽位居中，命中框同样算得准', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5, 'top')]);
    step(6);
    // 顶/底固定条只驻留 4s，必须在过期前点
    step(9);

    // slotH = 202.5 / 8 = 25.3125 → 基线 12.656，x = (720 - 32) / 2 = 344
    const hit = overlay.pick(360, 20);
    expect(hit?.comment.mode).toBe('top');
    expect(hit?.rect.left).toBeCloseTo(341, 6);
    expect(hit?.rect.top).toBeCloseTo(0.656, 3);
  });
});

describe('DanmakuOverlay · 单条冻结', () => {
  it('点中后只有它停住，其余照常滚', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5), scrollComment('BBBBBBBB', 5.6)]);
    step(6);
    step(11);
    expect(overlay.pick(360, 28)).not.toBeNull();

    const frozen = step(12);
    // A 冻在基线 344，B 继续走：0.6 → 720 - 0.6 * (720 + 64) = 249.6
    expect(frozen[0]).toBeCloseTo(344 - PAD, 6);
    expect(frozen[1]).toBeCloseTo(249.6 - PAD, 6);

    const again = step(13);
    expect(again[0]).toBeCloseTo(344 - PAD, 6);
    expect(again[1]).toBeLessThan(frozen[1]!);
  });

  it('放行后按冻结时的比例续接：不倒回起点、也不瞬移到前头', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5)]);
    step(6);
    step(11);
    overlay.pick(360, 28);
    step(13);

    overlay.releasePick();
    // bornAt 被改写为 8：解冻后 1s 只推进 0.1 路程（没改写会是 115.4）
    const moved = step(14);
    expect(moved[0]).toBeCloseTo(268.8 - PAD, 6);
    expect(overlay.pickedComment).toBeNull();
  });

  it('放行后命中框回到（并停在）解冻处：不留一段空白', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5)]);
    step(6);
    step(11);
    overlay.pick(360, 28);
    step(12);
    overlay.releasePick();

    // bornAt 被改写成 12 - 0.5 * 10 = 7，此刻 x 仍是 720 - 0.5 * 752 = 344
    expect(overlay.pick(360, 28)?.comment.text).toBe('AAAA');
    expect(overlay.pick(270, 28)).toBeNull();
  });

  it('再点另一条：前一条立刻放行，冻结的只有新点中的', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5), scrollComment('BBBBBBBB', 5.6)]);
    step(6);
    step(11);
    overlay.pick(360, 28);

    // 第二条在第 1 行：y ≈ 76.6，x = 720 - 0.5 * (720 + 64) = 328
    const second = overlay.pick(340, 76);
    expect(second?.comment.text).toBe('BBBBBBBB');
    expect(overlay.pickedComment?.text).toBe('BBBBBBBB');

    const frames = step(12);
    expect(frames[0]).toBeCloseTo(268.8 - PAD, 6); // A 恢复滚动
    expect(frames[1]).toBeCloseTo(328 - PAD, 6); // B 停在被点中处
  });

  it('seek 清场时冻结状态一起丢掉', () => {
    const { overlay, step, jump } = mount([scrollComment('AAAA', 5.5)]);
    step(6);
    step(11);
    overlay.pick(360, 28);
    expect(overlay.pickedComment).not.toBeNull();

    jump(40);
    expect(overlay.pickedComment).toBeNull();
  });

  it('换弹幕数据（load/clear）不残留上一次的冻结', () => {
    const { overlay, step } = mount([scrollComment('AAAA', 5.5)]);
    step(6);
    step(11);
    overlay.pick(360, 28);

    overlay.load([scrollComment('CCCC', 5.5)]);
    expect(overlay.pickedComment).toBeNull();
  });

  it('未挂载 canvas 时点击不会炸', () => {
    const overlay = new DanmakuOverlay({ settings: SETTINGS, getTime: () => 0 });
    expect(overlay.pick(100, 100)).toBeNull();
    overlay.releasePick();
    expect(overlay.pickedComment).toBeNull();
  });
});
