/**
 * 进度条「镜头节奏」带单测（G-C05）
 *
 * 这个功能长在拖动取秒的那条链路上，所以底线只有一条是新的、其余全是"不许改动旧的"：
 * 1. 没有数据（`rhythm=null`）时，DOM 与升级前逐节点一致——不带一个节点、不占一行高度；
 * 2. 带子是纯装饰层：格子数、柱高、斜纹都只由数据决定，任何一格都不参与 seek 取值；
 * 3. "没看过"与"很平"画出来的东西不一样（斜纹 vs 矮柱），用户不会把没播的段落读成慢节奏。
 *
 * 几何与 `SeekBar.spec.ts` / `SeekBarDetent.spec.ts` 对齐：轨道 360px。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SeekBar from '@/components/player/SeekBar.vue';
import { RHYTHM_BINS, type RhythmBand } from '@/player/cutRhythm';

const TRACK_W = 360;
const DURATION = 240;

function band(parts: Partial<RhythmBand> & { values?: number[] } = {}): RhythmBand {
  const values =
    parts.values ??
    Array.from({ length: RHYTHM_BINS }, (_, i) => (i % 5 === 0 ? Number.NaN : (i % 10) / 10));
  return { values, peaks: parts.peaks ?? [] };
}

function stubGeometry(wrapper: VueWrapper): void {
  const hit = wrapper.find('.seekbar__hit').element;
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

function mountBar(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(SeekBar, {
    props: { currentTime: 0, duration: DURATION, ...props },
  });
  stubGeometry(wrapper);
  return wrapper;
}

/** 第 bin 格中点的客户端 X */
function xOfBin(bin: number): number {
  return ((bin + 0.5) / RHYTHM_BINS) * TRACK_W;
}

async function hoverAt(wrapper: VueWrapper, clientX: number): Promise<void> {
  await wrapper.find('.seekbar__hit').trigger('pointermove', { clientX, pointerId: 1 });
  await flushPromises();
}

describe('SeekBar 节奏带 · 默认态必须与升级前一致', () => {
  it('没有数据时整层不出现（rhythm 默认 null）', () => {
    const plain = mountBar({});
    expect(plain.find('.seekbar__rhythm').exists()).toBe(false);
    expect(plain.find('.seekbar__track').exists()).toBe(true);
  });

  it('时长还没报出来时也不出现：一条没有比例的带子是噪声', () => {
    const live = mountBar({ rhythm: band(), duration: 0 });
    expect(live.find('.seekbar__rhythm').exists()).toBe(false);
  });

  it('禁用（加载中/报错）时收起，不把装饰压在不可用的轨道上', () => {
    const disabled = mountBar({ rhythm: band(), disabled: true });
    expect(disabled.find('.seekbar__rhythm').exists()).toBe(false);
  });
});

describe('SeekBar 节奏带 · 图形只由数据决定', () => {
  it('一格一根柱子，数量与格数对齐', () => {
    const wrapper = mountBar({ rhythm: band() });
    expect(wrapper.findAll('.seekbar__rhythm-bar')).toHaveLength(RHYTHM_BINS);
  });

  it('没数据的格画斜纹位（全高透明），有数据的格按高度比例画', () => {
    const wrapper = mountBar({
      rhythm: band({ values: [Number.NaN, 0, 0.5, 1, ...Array(RHYTHM_BINS - 4).fill(0.2)] }),
    });
    const bars = wrapper.findAll('.seekbar__rhythm-bar');
    expect(bars[0]?.classes()).toContain('seekbar__rhythm-bar--blank');
    expect(bars[0]?.attributes('style')).toContain('height: 100%');

    // 0 也给一档最小高度：纯 0 会消失成一道缝，看起来像漏画
    expect(bars[1]?.attributes('style')).toContain('height: 8%');
    expect(bars[1]?.classes()).not.toContain('seekbar__rhythm-bar--blank');
    expect(bars[2]?.attributes('style')).toContain('height: 50%');
    expect(bars[3]?.attributes('style')).toContain('height: 100%');
    expect(bars[3]?.classes()).not.toContain('seekbar__rhythm-bar--blank');
  });

  it('换镜点用另一档底色点出来，其余格子不受影响', () => {
    const values = Array.from({ length: RHYTHM_BINS }, () => 0.9);
    const wrapper = mountBar({ rhythm: band({ values, peaks: [4, 30] }) });
    const bars = wrapper.findAll('.seekbar__rhythm-bar');
    expect(bars[4]?.classes()).toContain('seekbar__rhythm-bar--peak');
    expect(bars[30]?.classes()).toContain('seekbar__rhythm-bar--peak');
    expect(bars[5]?.classes()).not.toContain('seekbar__rhythm-bar--peak');
  });

  it('带子本身不带任何点击/命中语义：点击仍是进度条原来那一套', () => {
    const wrapper = mountBar({ rhythm: band({ peaks: [30] }) });
    const layer = wrapper.find('.seekbar__rhythm');
    expect(layer.element.tagName).toBe('DIV');
    expect(wrapper.findAll('.seekbar__rhythm button')).toHaveLength(0);
    expect(layer.attributes('aria-hidden')).toBe('true');
  });

  it('画了带子的轨道，拖动取秒的口径一个字节都没变', async () => {
    const withBand = mountBar({ rhythm: band({ peaks: [] }) });
    const plain = mountBar({});

    await withBand.find('.seekbar__hit').trigger('pointerdown', { clientX: 180, pointerId: 1 });
    await plain.find('.seekbar__hit').trigger('pointerdown', { clientX: 180, pointerId: 1 });
    await withBand.find('.seekbar__hit').trigger('pointerup', { clientX: 180, pointerId: 1 });
    await plain.find('.seekbar__hit').trigger('pointerup', { clientX: 180, pointerId: 1 });

    const mine = withBand.emitted('seek')?.at(-1)?.[0];
    const theirs = plain.emitted('seek')?.at(-1)?.[0];
    expect(mine).toBe(theirs);
    expect(mine).toBeCloseTo(DURATION / 2, 5);
  });
});

describe('SeekBar 节奏带 · 指针说明', () => {
  it('指针压在换镜点上时说出这一刻是什么', async () => {
    const wrapper = mountBar({ rhythm: band({ values: Array(RHYTHM_BINS).fill(0.9), peaks: [30] }) });
    await hoverAt(wrapper, xOfBin(30));

    const peak = wrapper.find('.seekbar__snap--peak');
    expect(peak.exists()).toBe(true);
    expect(peak.text()).toBe('换镜密集点');
  });

  it('压在普通格上就不啰嗦', async () => {
    const wrapper = mountBar({ rhythm: band({ values: Array(RHYTHM_BINS).fill(0.9), peaks: [30] }) });
    await hoverAt(wrapper, xOfBin(5));
    expect(wrapper.find('.seekbar__snap--peak').exists()).toBe(false);
  });

  it('吸附提示优先：已经告诉用户"停在片头结束"，就不再叠一句节奏', async () => {
    const wrapper = mountBar({
      rhythm: band({ values: Array(RHYTHM_BINS).fill(0.9), peaks: [10] }),
      detent: 100,
      marks: { introEndSec: (10.5 / RHYTHM_BINS) * DURATION, creditsStartSec: null },
      cells: 0,
    });
    // 拖到第 10 格里、又正好落进片头边界的吸附半径：两个标签都想说话，只留吸附那句
    await wrapper.find('.seekbar__hit').trigger('pointerdown', { clientX: xOfBin(10), pointerId: 1 });
    await flushPromises();

    expect(wrapper.find('.seekbar__snap--peak').exists()).toBe(false);
    expect(wrapper.text()).toContain('片头结束');
    await wrapper.find('.seekbar__hit').trigger('pointerup', { clientX: xOfBin(10), pointerId: 1 });
  });
});
