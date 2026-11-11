/**
 * 主动返回出口（B-07 依赖）
 *
 * 验收写的是「与系统返回键走同一出口，返回栈行为完全一致」，所以这里只压两点：
 * 链路与 backButton 事件一样（页面监听器 → 路由兜底），以及手势**永远不该退出 App**——
 * 栈到底时返回 false，由调用方回弹，而不是把用户甩出应用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })), exitApp: vi.fn() },
}));

import { App } from '@capacitor/app';

import { onBackButton, pressBackButton, resetLifecycleState, setBackFallback } from '@/native/appLifecycle';

const exitMock = vi.mocked(App.exitApp);

beforeEach(() => {
  resetLifecycleState();
  setBackFallback(null);
  exitMock.mockClear();
});

describe('pressBackButton', () => {
  it('页面监听器先消费，兜底不参与（弹层 / 全屏同按返回键一致）', () => {
    const fallback = vi.fn(() => true);
    setBackFallback(fallback);
    const off = onBackButton(() => true);

    expect(pressBackButton()).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    off();
  });

  it('没人消费时交给路由兜底回退上一页', () => {
    const fallback = vi.fn(() => true);
    setBackFallback(fallback);

    expect(pressBackButton()).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('栈底（兜底说回不去）只返回 false，绝不退出 App', () => {
    setBackFallback(() => false);

    expect(pressBackButton()).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('没有兜底同样返回 false 而不是退出', () => {
    expect(pressBackButton()).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('兜底抛异常时吞掉并按未处理返回', () => {
    setBackFallback(() => {
      throw new Error('router 挂了');
    });

    expect(pressBackButton()).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('所有页面监听器都跑一遍，任一消费即算处理', () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    const offA = onBackButton(first);
    const offB = onBackButton(second);

    expect(pressBackButton()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });
});
