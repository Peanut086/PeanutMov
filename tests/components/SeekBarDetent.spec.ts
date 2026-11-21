/**
 * 进度条刻度与章节磁吸单测 —— G 批次·G-A03
 *
 * 这个功能动的是「拖动取秒」这条链路，也就是 AC-43（误差 ≤2s）本身，所以三条底线必须钉住：
 * 1. `detent=0` 时逐字节回退到升级前的取值（刻度不画、不吸附、一个事件都不发）；
 * 2. 吸附只在边界半径内改值，半径外仍然是指针那一带的原始秒数——不能被理解成"按格取整"；
 * 3. 刻度只给反馈，绝不参与 seek 取值（一格 ≈ 5% 时长，取整直接把精度打穿）。
 *
 * 几何常量与 `tests/components/SeekBar.spec.ts` 对齐：轨道 360px、时长 200s。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SeekBar from '@/components/player/SeekBar.vue';

const TRACK_W = 360;
const DURATION = 200;
const CELLS = 20;

/** 强度 60% → 吸附半径 9.6px；轨道 360px、时长 200s → 约 5.33s */
const RADIUS_SEC = (16 * 0.6 * DURATION) / TRACK_W;

function stubGeometry(hit: Element): void {
  hit.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: TRACK_W,
      bottom: 44,
      width: TRACK_W,
      height: 44,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function mountBar(options: {
  detent: number;
  cells?: number;
  marks?: { introEndSec: number | null; creditsStartSec: number | null } | null;
}): VueWrapper {
  const wrapper = mount(SeekBar, {
    props: {
      currentTime: 0,
      duration: DURATION,
      detent: options.detent,
      cells: options.cells ?? 0,
      marks: options.marks ?? null,
    },
  });
  stubGeometry(wrapper.get('.seekbar__hit').element);
  return wrapper;
}

async function press(wrapper: VueWrapper, clientX: number): Promise<void> {
  await wrapper.get('.seekbar__hit').trigger('pointerdown', { clientX });
  await wrapper.vm.$nextTick();
}

async function move(wrapper: VueWrapper, clientX: number): Promise<void> {
  await wrapper.get('.seekbar__hit').trigger('pointermove', { clientX });
  await wrapper.vm.$nextTick();
}

async function release(wrapper: VueWrapper, clientX: number): Promise<void> {
  await wrapper.get('.seekbar__hit').trigger('pointerup', { clientX });
  await wrapper.vm.$nextTick();
}

/** 最近一次 emit 的 seeking 秒数 */
function lastSeeking(wrapper: VueWrapper): number {
  const events = wrapper.emitted('seeking');
  return Number(events?.[events.length - 1]?.[0]);
}

function detentEvents(wrapper: VueWrapper): string[] {
  return (wrapper.emitted('detent') ?? []).map((args) => String(args[0]));
}

const secAt = (clientX: number): number => (clientX / TRACK_W) * DURATION;

describe('SeekBar · 磁吸关闭时逐字节回退', () => {
  it('detent=0：不画刻度，取值与指针位置完全一致，一个 detent 事件都不发', async () => {
    const wrapper = mountBar({ detent: 0, cells: CELLS, marks: { introEndSec: 100, creditsStartSec: null } });
    // 半径内的那个像素：关闭磁吸就必须还是 97.22s，不能被吸到 100s
    await press(wrapper, 175);

    expect(wrapper.find('.seekbar__ticks').exists()).toBe(false);
    expect(lastSeeking(wrapper)).toBeCloseTo(secAt(175), 6);
    await move(wrapper, 108);
    await release(wrapper, 108);

    expect(lastSeeking(wrapper)).toBeCloseTo(secAt(108), 6);
    expect(wrapper.emitted('seek')?.[0]?.[0]).toBeCloseTo(secAt(108), 6);
    expect(detentEvents(wrapper)).toEqual([]);
  });
});

describe('SeekBar · 刻度层', () => {
  it('开启磁吸后按格画刻度：20 格画 19 齿（两端不画）', async () => {
    const wrapper = mountBar({ detent: 60, cells: CELLS });

    const ticks = wrapper.findAll('.seekbar__tick');
    expect(ticks).toHaveLength(CELLS - 1);
    expect(ticks[0]!.attributes('style')).toContain('left: 5%');
    expect(ticks[18]!.attributes('style')).toContain('left: 95%');
  });

  it('没有分段（在线源格数为 0）时不画假刻度', () => {
    const wrapper = mountBar({ detent: 60, cells: 0 });

    expect(wrapper.find('.seekbar__ticks').exists()).toBe(false);
  });

  it('刻度不改 seek 取值：无分段照样能拖（回归护栏）', () => {
    const wrapper = mountBar({ detent: 60, cells: 1 });

    expect(wrapper.find('.seekbar__ticks').exists()).toBe(false);
  });
});

describe('SeekBar · 片头/片尾边界吸附', () => {
  it('半径内吸到边界，并上报一次 boundary', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 100, creditsStartSec: null } });
    await press(wrapper, 175);

    expect(lastSeeking(wrapper)).toBe(100);
    expect(detentEvents(wrapper)).toEqual(['boundary']);
    expect(wrapper.get('.seekbar__snap').text()).toBe('片头结束');
  });

  it('半径 98% 处吸附：留两位浮点余量，不靠边界值本身赌精度', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 100, creditsStartSec: null } });
    const insideX = ((100 - RADIUS_SEC * 0.98) / DURATION) * TRACK_W;
    await press(wrapper, insideX);

    expect(lastSeeking(wrapper)).toBe(100);
  });

  it('半径外一个像素都不改：远离边界的拖动保持原始精度', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 100, creditsStartSec: null } });
    const outsideX = ((100 - RADIUS_SEC * 1.05) / DURATION) * TRACK_W;
    await press(wrapper, outsideX);

    expect(lastSeeking(wrapper)).toBeCloseTo(secAt(outsideX), 4);
    expect(detentEvents(wrapper)).toEqual([]);
    expect(wrapper.find('.seekbar__snap').exists()).toBe(false);
  });

  it('离开边界后标签撤掉，再进去算一次新的吸附', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 100, creditsStartSec: null } });
    await press(wrapper, 175);
    await move(wrapper, 260);
    expect(wrapper.find('.seekbar__snap').exists()).toBe(false);

    await move(wrapper, 175);
    expect(detentEvents(wrapper)).toEqual(['boundary', 'boundary']);
    expect(lastSeeking(wrapper)).toBe(100);
  });

  it('同一边界内连续停留只报一次，不会把振动连成一串', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 100, creditsStartSec: null } });
    await press(wrapper, 175);
    await move(wrapper, 176);
    await move(wrapper, 177);

    expect(detentEvents(wrapper)).toEqual(['boundary']);
  });

  it('越界的脏标记不参与吸附：宁可不吸，也不吸到一个没画出来的位置', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 260, creditsStartSec: -5 } });
    await press(wrapper, 175);

    expect(lastSeeking(wrapper)).toBeCloseTo(secAt(175), 6);
    expect(detentEvents(wrapper)).toEqual([]);
  });

  it('松手提交的秒数等于最后看到的预览值', async () => {
    const wrapper = mountBar({ detent: 60, marks: { introEndSec: 100, creditsStartSec: null } });
    await press(wrapper, 175);
    await release(wrapper, 178);

    expect(wrapper.emitted('seek')?.[0]?.[0]).toBe(lastSeeking(wrapper));
    expect(wrapper.emitted('seek')?.[0]?.[0]).toBe(100);
  });
});

describe('SeekBar · 跨界刻度反馈', () => {
  it('按下不算跨界，拖动跨过一格才报一次 tick', async () => {
    const wrapper = mountBar({ detent: 60, cells: CELLS });
    await press(wrapper, 90); // 50s → 第 5 格
    expect(detentEvents(wrapper)).toEqual([]);

    await move(wrapper, 108); // 60s → 第 6 格
    expect(detentEvents(wrapper)).toEqual(['tick']);
  });

  it('同一格内来回微动不重复报，跨两格也只报一次（同帧多次由宿主节流）', async () => {
    const wrapper = mountBar({ detent: 60, cells: CELLS });
    await press(wrapper, 90);
    await move(wrapper, 95);
    await move(wrapper, 99);
    expect(detentEvents(wrapper)).toEqual([]);

    await move(wrapper, 130); // 一步跨到第 13 格
    expect(detentEvents(wrapper)).toEqual(['tick']);
  });

  it('刻度不改 seek 取值：跨界前后都是指针原始秒数', async () => {
    const wrapper = mountBar({ detent: 60, cells: CELLS });
    await press(wrapper, 90);
    expect(lastSeeking(wrapper)).toBeCloseTo(secAt(90), 6);
    await move(wrapper, 108);
    expect(lastSeeking(wrapper)).toBeCloseTo(secAt(108), 6);
  });

  it('无分段时完全不报 tick', async () => {
    const wrapper = mountBar({ detent: 60, cells: 0 });
    await press(wrapper, 90);
    await move(wrapper, 200);
    await move(wrapper, 300);

    expect(detentEvents(wrapper)).toEqual([]);
  });

  it('吸附优先于刻度：落在边界上时报 boundary 而不是 tick', async () => {
    const wrapper = mountBar({ detent: 60, cells: CELLS, marks: { introEndSec: 100, creditsStartSec: null } });
    await press(wrapper, 90);
    await move(wrapper, 180); // 正好是 100s = 片头边界，同时也在格界上

    expect(detentEvents(wrapper)).toEqual(['boundary']);
    expect(lastSeeking(wrapper)).toBe(100);
  });
});
