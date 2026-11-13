import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CategoryTabs from '@/components/media/CategoryTabs.vue';
import { scrollToTop } from '@/shared/scroll';
import type { Category } from '@/types';

/**
 * 「减少动态效果」的 JS 侧收口（P3-20）
 *
 * reset.css 的全局降级只管 CSS 动画 / 过渡 / `scroll-behavior`，而
 * `scrollTo({ behavior: 'smooth' })` 与 `scrollIntoView({ behavior: 'smooth' })` 是
 * 浏览器行为，那条媒体查询管不到——系统开了「减少动态效果」后仍然会平滑滚动。
 * 这里钉住两处入口都按媒体查询降级成瞬时。
 */

const CATEGORIES: Category[] = [
  { id: 'c-1', name: '电影', kind: 'movie' },
  { id: 'c-2', name: '剧集', kind: 'series' },
] as unknown as Category[];

function reduceMotionFlag(reduce: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const listeners = new Set<(ev: MediaQueryListEvent) => void>();
    return {
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: (cb: (ev: MediaQueryListEvent) => void) => listeners.add(cb),
      removeListener: (cb: (ev: MediaQueryListEvent) => void) => listeners.delete(cb),
      addEventListener: (_t: string, cb: (ev: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (ev: MediaQueryListEvent) => void) => listeners.delete(cb),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('减少动态效果下的滚动', () => {
  it('未开启：回顶部仍然平滑滚动', () => {
    reduceMotionFlag(false);
    const spy = vi.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: spy });

    scrollToTop(window);

    expect(spy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('开启：回顶部瞬时到位（CSS 那条降级管不到 JS 滚动）', () => {
    reduceMotionFlag(true);
    const spy = vi.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: spy });

    scrollToTop(window);

    expect(spy).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('开启：分类 Tab 把选中项滚进视野也不做平滑滚动', async () => {
    reduceMotionFlag(true);
    const seen: ScrollIntoViewOptions[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: (options?: ScrollIntoViewOptions) => {
        seen.push(options ?? {});
      },
    });

    const wrapper = mount(CategoryTabs, {
      props: { categories: CATEGORIES, modelValue: 'c-1', withAll: false },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();

    // 挂载后由 modelValue 的 watch 触发一次同步；换选中项再触发一次
    await wrapper.setProps({ modelValue: 'c-2' });
    await wrapper.vm.$nextTick();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((o) => o.behavior === 'auto')).toBe(true);
    wrapper.unmount();
  });

  it('未开启：分类 Tab 仍走平滑滚动', async () => {
    reduceMotionFlag(false);
    const seen: ScrollIntoViewOptions[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: (options?: ScrollIntoViewOptions) => {
        seen.push(options ?? {});
      },
    });

    const wrapper = mount(CategoryTabs, {
      props: { categories: CATEGORIES, modelValue: 'c-1', withAll: false },
      attachTo: document.body,
    });
    await wrapper.setProps({ modelValue: 'c-2' });
    await wrapper.vm.$nextTick();

    expect(seen.some((o) => o.behavior === 'smooth')).toBe(true);
    wrapper.unmount();
  });
});
