import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HueSpectrumBar from '@/components/media/HueSpectrumBar.vue';

/**
 * 色相条（G-B01）：窗口区间的拆分是唯一容易算错的地方——色相是环，尺是直的，
 * 跨过 0°/360° 必须拆成两段亮区 + 一段压暗区，否则会出现负宽度或超出轨道的色块。
 */
const TRACK_WIDTH = 200;

interface Range {
  left: number;
  width: number;
}

/** 角度 → 轨道百分比，和组件里同一个算式 */
const at = (deg: number): number => (deg / 360) * 100;

function expectRanges(actual: Range[], expected: Array<[number, number]>): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach(([left, width], index) => {
    expect(actual[index]!.left, `left ${index}`).toBeCloseTo(at(left), 4);
    expect(actual[index]!.width, `width ${index}`).toBeCloseTo(at(width), 4);
  });
}

function mountBar(hue: number, window: number) {
  const wrapper = mount(HueSpectrumBar, { props: { hue, window } });
  const track = wrapper.get('[role="slider"]');

  const read = (selector: string): Range[] =>
    wrapper.findAll(selector).map((el) => {
      const style = el.attributes('style') ?? '';
      const one = (prop: string): number => {
        const match = new RegExp(`${prop}:\\s*([\\d.]+)%`).exec(style);
        return match ? Number(match[1]) : Number.NaN;
      };
      return { left: one('left'), width: one('width') };
    });

  return {
    wrapper,
    track,
    windows: () => read('.hue-spectrum__window'),
    dims: () => read('.hue-spectrum__dim'),
    setHue: (value: number) => wrapper.setProps({ hue: value }),
  };
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        left: 0,
        top: 0,
        width: TRACK_WIDTH,
        height: 44,
        right: TRACK_WIDTH,
        bottom: 44,
        x: 0,
        y: 0,
      }) as unknown as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HueSpectrumBar · 区间', () => {
  it('窗口不跨界时一段亮区、两段压暗', () => {
    const bar = mountBar(210, 60);
    expectRanges(bar.windows(), [[150, 120]]);
    expectRanges(bar.dims(), [
      [0, 150],
      [270, 90],
    ]);
  });

  it('跨过 360° 边界时亮区拆两段，压暗区只剩中间一段', () => {
    const bar = mountBar(350, 30);
    expectRanges(bar.windows(), [
      [320, 40],
      [0, 20],
    ]);
    expectRanges(bar.dims(), [[20, 300]]);
  });

  it('跨过 0° 边界时同样拆两段，且没有负宽度', () => {
    const bar = mountBar(10, 30);
    expect(bar.windows().every((range) => range.width > 0)).toBe(true);
    expectRanges(bar.windows(), [
      [0, 40],
      [340, 20],
    ]);
    expectRanges(bar.dims(), [[40, 300]]);
  });

  it('窗宽 360 时整条都不压暗', () => {
    const bar = mountBar(210, 360);
    expect(bar.windows()).toEqual([]);
    expect(bar.dims()).toEqual([]);
  });

  it('任意中心与窗宽组合，区间都不超出轨道', () => {
    for (const [hue, win] of [
      [0, 30],
      [5, 60],
      [180, 120],
      [355, 60],
      [359, 120],
      [120, 179],
      [210, 360],
    ] as const) {
      const bar = mountBar(hue, win);
      for (const range of [...bar.windows(), ...bar.dims()]) {
        expect(range.left, `hue=${hue} win=${win}`).toBeGreaterThanOrEqual(0);
        expect(range.left + range.width, `hue=${hue} win=${win}`).toBeLessThanOrEqual(100.01);
        expect(range.width, `hue=${hue} win=${win}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('HueSpectrumBar · 输入', () => {
  it('语义：slider + 当前角度读得出来', () => {
    const { track } = mountBar(210.4, 60);
    expect(track.attributes('aria-label')).toBe('色相');
    expect(track.attributes('aria-valuemin')).toBe('0');
    expect(track.attributes('aria-valuemax')).toBe('360');
    expect(track.attributes('aria-valuenow')).toBe('210');
    expect(track.attributes('aria-valuetext')).toContain('210 度');
    expect(track.attributes('tabindex')).toBe('0');
  });

  it('点按与拖动按横向位置换算色相', async () => {
    const { wrapper, track } = mountBar(0, 60);
    await track.trigger('pointerdown', { clientX: 50 });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([90]);

    await track.trigger('pointermove', { clientX: 100 });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([180]);

    await track.trigger('pointerup', { clientX: 100 });
    await track.trigger('pointermove', { clientX: 150 });
    expect(wrapper.emitted('update:hue')).toHaveLength(2);
  });

  it('超出轨道的位置钳在两端（右端回到红）', async () => {
    const { wrapper, track } = mountBar(180, 60);
    await track.trigger('pointerdown', { clientX: -40 });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([0]);

    await track.trigger('pointerdown', { clientX: TRACK_WIDTH + 40 });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([0]);
  });

  it('方向键走 6 度，Shift 走 30 度', async () => {
    const { wrapper, track, setHue } = mountBar(3, 60);
    await track.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([9]);

    await setHue(9);
    await track.trigger('keydown', { key: 'ArrowUp', shiftKey: true });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([39]);
  });

  it('两端环绕：越过 0 从 360 那头回来', async () => {
    const { wrapper, track, setHue } = mountBar(3, 60);
    await track.trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([357]);

    await setHue(355);
    await track.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([1]);
  });

  it('Home / End 跳到两端', async () => {
    const { wrapper, track, setHue } = mountBar(180, 60);
    await track.trigger('keydown', { key: 'Home' });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([0]);

    await setHue(0);
    await track.trigger('keydown', { key: 'End' });
    expect(wrapper.emitted('update:hue')?.at(-1)).toEqual([354]);
  });

  it('无关按键不动作', async () => {
    const { wrapper, track } = mountBar(100, 60);
    await track.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:hue')).toBeUndefined();
  });
});
