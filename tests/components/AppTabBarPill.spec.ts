/**
 * 底部导航滑动胶囊（C4）
 *
 * 验收红线：进场不许看到胶囊从最左边飞过来；切 Tab 要走弹簧而不是瞬移；
 * 位置必须量真实按钮矩形（安全区/不等宽都不能错位）；连点不叠加动画；
 * 系统「减少动态效果」时退化成瞬时吸附；卸载后不留帧回调。
 *
 * 另锁一条路由契约：5 个 Tab 路由的 `meta.tab` 必须与 AppTabBar 的 TabKey 一一对应——
 * 配错的值不会报错，只会让那个 Tab 永远不高亮、胶囊卡住不动。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppTabBar from '@/components/layout/AppTabBar.vue';
import { routes } from '@/router';
import type { TabKey } from '@/stores/uiStore';

const NAV_LEFT = 16;
const TAB_ROUTES: Array<{ path: string; tab: TabKey }> = [
  { path: '/', tab: 'home' },
  { path: '/library', tab: 'library' },
  { path: '/live', tab: 'live' },
  { path: '/downloads', tab: 'downloads' },
  { path: '/settings', tab: 'me' },
];

const Blank = { template: '<div />' };

let widths = [72, 72, 72, 72, 72];
let queue: Array<(now: number) => void> = [];
let now = 0;
let wrapper: VueWrapper | null = null;
let router: Router | null = null;

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 56,
    height: 56,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** happy-dom 无布局：按 class 现算矩形，故意让 nav 左偏 16px 以验证用的是相对位移 */
function stubGeometry(): void {
  vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement): DOMRect {
      if (this.classList.contains('tabbar')) {
        return rect(NAV_LEFT, widths.reduce((sum, w) => sum + w, 0));
      }
      if (!this.classList.contains('tabbar__item')) return rect(0, 0);
      const siblings = Array.from(this.parentElement?.querySelectorAll('.tabbar__item') ?? []);
      const index = siblings.indexOf(this);
      if (index < 0) return rect(0, 0);
      const left = NAV_LEFT + widths.slice(0, index).reduce((sum, w) => sum + w, 0);
      return rect(left, widths[index] ?? 0);
    },
  );
}

function pump(frameMs: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    now += frameMs;
    const pending = queue;
    queue = [];
    pending.forEach((cb) => cb(now));
    if (queue.length === 0) return;
  }
}

function pillStyle(): string {
  return wrapper?.find('.tabbar__pill').attributes('style') ?? '';
}

function pillX(): number {
  const match = /translate\((-?[\d.]+)px/.exec(pillStyle());
  return match ? Number(match[1]) : Number.NaN;
}

function pillWidth(): number {
  const match = /width:\s*(-?[\d.]+)px/.exec(pillStyle());
  return match ? Number(match[1]) : Number.NaN;
}

async function mountAt(path: string): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: TAB_ROUTES.map((r) => ({ path: r.path, component: Blank, meta: { tab: r.tab } })),
  });
  await router.push(path);
  await router.isReady();
  wrapper = mount(AppTabBar, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
}

async function goTo(path: string): Promise<void> {
  await router?.push(path);
  await flushPromises();
}

beforeEach(() => {
  widths = [72, 72, 72, 72, 72];
  queue = [];
  now = 0;
  stubGeometry();
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  router = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AppTabBar 滑动胶囊', () => {
  it('首次定位直接吸附到当前 Tab，不排任何动画帧', async () => {
    await mountAt('/live');
    expect(wrapper?.find('.tabbar__pill').classes()).toContain('tabbar__pill--ready');
    expect(pillX()).toBe(144);
    expect(pillWidth()).toBe(72);
    expect(queue).toHaveLength(0);
  });

  it('切 Tab 时走弹簧：中途在两端之间，最终停在目标位', async () => {
    await mountAt('/');
    expect(pillX()).toBe(0);

    await goTo('/settings');
    expect(queue).toHaveLength(1);

    pump(16, 1);
    await flushPromises();
    const midway = pillX();
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(288);

    pump(16, 120);
    await flushPromises();
    expect(pillX()).toBe(288);
    expect(queue).toHaveLength(0);
  });

  it('量真实按钮宽度，不等宽时也不按 1/5 猜', async () => {
    widths = [60, 80, 100, 64, 56];
    await mountAt('/downloads');
    // 60 + 80 + 100 = 240 才是第 4 个 Tab 的相对左边界
    expect(pillX()).toBe(240);
    expect(pillWidth()).toBe(64);
  });

  it('连续切 Tab 只保留一条弹簧，最终停在最后一次的 Tab 上', async () => {
    await mountAt('/');
    await goTo('/live');
    pump(16, 2);
    await goTo('/downloads');
    expect(queue).toHaveLength(1);
    pump(16, 120);
    await flushPromises();
    expect(pillX()).toBe(216);
  });

  it('系统减少动态效果时瞬时吸附，不排帧', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await mountAt('/');
    await goTo('/settings');
    expect(queue).toHaveLength(0);
    expect(pillX()).toBe(288);
  });

  it('卸载时掐掉在跑的弹簧，不留帧回调', async () => {
    await mountAt('/');
    await goTo('/settings');
    expect(queue).toHaveLength(1);
    wrapper?.unmount();
    wrapper = null;
    expect(queue).toHaveLength(0);
  });

  it.each(TAB_ROUTES)('停在 $path 时只有对应按钮是选中态', async ({ path }) => {
    await mountAt(path);
    const items = wrapper?.findAll('.tabbar__item') ?? [];
    const index = TAB_ROUTES.findIndex((r) => r.path === path);
    const activeIndexes = items
      .map((item, i) => (item.classes().includes('tabbar__item--active') ? i : -1))
      .filter((i) => i >= 0);
    expect(activeIndexes).toEqual([index]);
    expect(items[index]?.attributes('aria-current')).toBe('page');
    expect(pillX()).toBe(widths.slice(0, index).reduce((sum, w) => sum + w, 0));
  });
});

/** 选中态的唯一来源是路由元数据，这里把「TabKey ↔ 路由」的对应关系钉死。 */
describe('路由 meta.tab 契约', () => {
  const expectedByPath: Record<string, TabKey> = {
    '/': 'home',
    '/library': 'library',
    '/live': 'live',
    '/downloads': 'downloads',
    '/settings': 'me',
  };

  it('每个带布局的一级路由都声明了正确的 meta.tab', () => {
    const actual = routes
      .filter((r) => r.meta?.requiresLayout === true)
      .map((r) => [r.path, r.meta?.tab] as const);
    expect(new Map(actual)).toEqual(new Map(Object.entries(expectedByPath)));
  });

  it('TabKey 全部有路由承载，也不存在路由指向未知 Tab', () => {
    const declared = routes.map((r) => r.meta?.tab).filter((tab): tab is TabKey => tab !== undefined);
    expect([...new Set(declared)].sort()).toEqual(Object.values(expectedByPath).sort());
  });
});