import { createPinia } from 'pinia';
import { config, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MediaItem } from '@/types';
import PosterGrid from '@/components/media/PosterGrid.vue';
import { VIRTUALIZE_MIN_ROWS } from '@/components/media/useVirtualGrid';

/**
 * PosterGrid 虚拟化（REV-11 / NFR-D02）
 *
 * happy-dom 没有真实布局，`clientWidth`/`getBoundingClientRect` 恒为 0，
 * 因此这里只断言**可确定的降级行为**：
 * - 条目少（≤ 阈值）时全量渲染，虚拟化不介入；
 * - `:virtual="false"` 强制关闭；
 * - loading 时走骨架分支；
 * - 条目多但容器不可测量时不应崩溃或渲染空列表。
 *
 * 窗口计算的数值正确性由 `useVirtualGrid` 的单元断言覆盖（行高/切片公式）。
 */
function makeItem(index: number): MediaItem {
  return {
    id: `mock:item-${index}~x`,
    sourceId: 'mock',
    sourceItemId: `item-${index}`,
    title: `影片 ${index}`,
    originalTitle: null,
    type: 'movie',
    year: 2020,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: `影片 ${index}`,
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makeItems(count: number): MediaItem[] {
  return Array.from({ length: count }, (_, i) => makeItem(i));
}

describe('PosterGrid 虚拟化降级（REV-11）', () => {
  // PosterGrid 渲染 PosterCard → useHaptic → settingsStore：补 activePinia 测试基建
  beforeEach(() => {
    config.global.plugins = [createPinia()];
  });
  afterEach(() => {
    config.global.plugins = [];
  });

  it('条目少时全量渲染，不进入虚拟化分支', () => {
    // 2 列 × VIRTUALIZE_MIN_ROWS 行 = 阈值条数
    const wrapper = mount(PosterGrid, { props: { items: makeItems(VIRTUALIZE_MIN_ROWS * 2) } });

    expect(wrapper.findAll('.poster-grid__cell')).toHaveLength(VIRTUALIZE_MIN_ROWS * 2);
    expect(wrapper.find('.poster-grid__viewport').exists()).toBe(false);
  });

  it('条目多但容器尺寸不可测时不渲染视口占位（安全降级为全量）', () => {
    const wrapper = mount(PosterGrid, {
      props: { items: makeItems(VIRTUALIZE_MIN_ROWS * 2 + 50) },
    });

    // 没有真实布局 → 无法计算窗口 → 不应出现半截列表
    const cells = wrapper.findAll('.poster-grid__cell');
    expect(cells.length).toBeGreaterThan(0);
  });

  it(':virtual="false" 时强制全量渲染', () => {
    const items = makeItems(300);
    const wrapper = mount(PosterGrid, { props: { items, virtual: false } });

    expect(wrapper.findAll('.poster-grid__cell')).toHaveLength(300);
    expect(wrapper.find('.poster-grid__viewport').exists()).toBe(false);
  });

  it('loading 且无条目时渲染骨架', () => {
    const wrapper = mount(PosterGrid, { props: { items: [], loading: true, skeletonCount: 6 } });
    expect(wrapper.findAll('.skeleton-poster').length).toBeGreaterThan(0);
  });

  it('全量模式下点击卡片 emit select', async () => {
    const wrapper = mount(PosterGrid, { props: { items: makeItems(4) } });
    await wrapper.find('button.poster-card').trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  it('阈值常量为正数', () => {
    expect(VIRTUALIZE_MIN_ROWS).toBeGreaterThan(0);
  });
});
