import { config, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import type { MediaItem } from '@/types';
import PosterGrid from '@/components/media/PosterGrid.vue';

/**
 * G-B01：`flip` 是 PosterGrid 的新可选开关，默认关。
 *
 * 开关关掉时，同一批卡片换顺序必须和以前逐字节一致（不写任何内联样式）——
 * 媒体库、搜索、下载等调用方都没传这个 prop，这是「不破坏现有功能」的那半边。
 * 打开时位移只落在 `.poster-grid__cell` 上：卡片自己会用内联 transform 做按压缩放，
 * 位移写在 cell 层才不会互相覆盖。
 */
const COLS = 2;

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

function installLayoutStub(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const parent = this.parentElement;
    const idx = parent ? (Array.prototype.indexOf.call(parent.children, this) as number) : 0;
    const left = (idx % COLS) * 100;
    const top = Math.floor(idx / COLS) * 150;
    return { left, top, width: 100, height: 150, right: left + 100, bottom: top + 150, x: left, y: top } as unknown as DOMRect;
  });
}

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

function cellStyles(wrapper: { element: Element }): Array<{ key: string; transition: string }> {
  return Array.from(wrapper.element.querySelectorAll<HTMLElement>('[data-flip-key]')).map((el) => ({
    key: el.dataset.flipKey as string,
    transition: el.style.transition,
  }));
}

beforeEach(() => {
  config.global.plugins = [createPinia()];
  installLayoutStub();
});

afterEach(() => {
  config.global.plugins = [];
  vi.restoreAllMocks();
});

describe('PosterGrid · flip 开关', () => {
  it('默认关闭：重排不写任何内联样式', async () => {
    const items = ref([makeItem(0), makeItem(1), makeItem(2)]);
    const wrapper = mount(PosterGrid, { props: { items: items.value, virtual: false } });

    items.value = [makeItem(2), makeItem(0), makeItem(1)];
    await wrapper.setProps({ items: items.value });
    await flush();

    const cells = wrapper.findAll('.poster-grid__cell');
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      const el = cell.element as HTMLElement;
      expect(el.style.transition).toBe('');
      expect(el.style.transform).toBe('');
    }
  });

  it('打开后：重排给挪动的格子写上 transform 过渡', async () => {
    const items = ref([makeItem(0), makeItem(1), makeItem(2)]);
    const wrapper = mount(PosterGrid, { props: { items: items.value, virtual: false, flip: true } });

    items.value = [makeItem(2), makeItem(0), makeItem(1)];
    await wrapper.setProps({ items: items.value });
    await flush();

    const moved = cellStyles(wrapper).filter((c) => c.transition !== '');
    expect(moved.length).toBeGreaterThan(0);
    for (const cell of moved) {
      expect(cell.transition).toContain('transform');
      expect(cell.transition).not.toContain('width');
    }
    // 卡片自己那套按压缩放的内联 transform 没有被 FLIP 侵占
    for (const card of wrapper.findAll('.poster-card')) {
      expect((card.element as HTMLElement).style.transition).toBe('');
    }
  });
});
