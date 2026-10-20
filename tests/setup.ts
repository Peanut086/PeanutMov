import 'fake-indexeddb/auto';

import { afterEach, vi } from 'vitest';

/**
 * Vitest 全局初始化（SCF 交付，两包共用）
 *
 * 1. `fake-indexeddb/auto` 注册全局 IndexedDB，使 `idb` 可在 Node 中运行
 * 2. 补齐 happy-dom 缺失的浏览器 API：`matchMedia`、`ResizeObserver`、
 *    `IntersectionObserver`、`scrollTo`、`URL.createObjectURL`
 * 3. 静默 Vue 的 warn（组件测试关注断言，不关注噪音）
 * 4. 每个用例后清理 DOM
 */

/* ---------- matchMedia ---------- */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const listeners = new Set<(ev: MediaQueryListEvent) => void>();
      const mql = {
        matches: false,
        media: query,
        onchange: null,
        addListener: (cb: (ev: MediaQueryListEvent) => void) => listeners.add(cb),
        removeListener: (cb: (ev: MediaQueryListEvent) => void) => listeners.delete(cb),
        addEventListener: (_type: string, cb: (ev: MediaQueryListEvent) => void) => listeners.add(cb),
        removeEventListener: (_type: string, cb: (ev: MediaQueryListEvent) => void) => listeners.delete(cb),
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
      return mql;
    },
  });
}

/* ---------- ResizeObserver ---------- */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

/* ---------- IntersectionObserver（海报懒加载用） ---------- */
class IntersectionObserverStub {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds: number[] = [];
  constructor(private readonly cb?: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** 测试辅助：手动触发回调 */
  trigger(entries: Partial<IntersectionObserverEntry>[]): void {
    this.cb?.(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IntersectionObserverStub;
}

/* ---------- 其它 DOM API ---------- */
if (typeof window !== 'undefined') {
  if (typeof window.scrollTo !== 'function') {
    Object.defineProperty(window, 'scrollTo', { writable: true, value: () => {} });
  }
  if (typeof window.HTMLElement.prototype.scrollIntoView !== 'function') {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
}

if (typeof URL !== 'undefined' && typeof URL.createObjectURL !== 'function') {
  let counter = 0;
  URL.createObjectURL = (): string => `blob:test/${(counter += 1)}`;
  URL.revokeObjectURL = (): void => {};
}

/* ---------- 静默 Vue 生产提示噪音 ---------- */
if (typeof console !== 'undefined') {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
  }
});
