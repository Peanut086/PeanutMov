/**
 * 全屏控制器测试（AC-52）
 *
 * 断言：
 * - 进入全屏触发 `onEnter`（View 在此隐藏状态栏）、退出触发 `onExit`（恢复状态栏）
 * - 原生 fullscreenchange 事件驱动的显隐同样触发对应钩子
 * - 钩子抛错（同步异常或 Promise reject）**不阻断**全屏状态流转
 */
import { describe, expect, it, vi } from 'vitest';

import { FullscreenController } from '@/player/FullscreenController';

/** Web 环境（无原生电容桥）下的容器元素 */
function makeElement(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** 触发原生 fullscreenchange（`element` 与 fullscreenElement 一致才视为进入） */
function emitFullscreenChange(el: HTMLElement, active: boolean): void {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  doc.webkitFullscreenElement = active ? el : null;
  doc.dispatchEvent(new Event('webkitfullscreenchange'));
  doc.webkitFullscreenElement = null;
}

describe('FullscreenController 状态栏钩子（AC-52）', () => {
  it('进入全屏调用 onEnter（隐藏状态栏），退出调用 onExit（恢复状态栏）', async () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const ctl = new FullscreenController({ onChange, onEnter, onExit });
    ctl.setElement(makeElement());

    await ctl.enter();
    expect(ctl.isActive).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();

    await ctl.exit();
    expect(ctl.isActive).toBe(false);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('CSS 兜底全屏（原生环境）也触发同一对钩子', async () => {
    const onEnter = vi.fn();
    const onExit = vi.fn();
    // 不 setElement → 进入即走 CSS fallback
    const ctl = new FullscreenController({ onChange: vi.fn(), onEnter, onExit });

    await ctl.enter();
    expect(ctl.isActive).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);

    await ctl.exit();
    expect(ctl.isActive).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('原生 fullscreenchange 进入/退出同样触发钩子', () => {
    const el = makeElement();
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const ctl = new FullscreenController({ onChange: vi.fn(), onEnter, onExit });
    ctl.setElement(el);
    ctl.bind();

    emitFullscreenChange(el, true);
    expect(ctl.isActive).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);

    emitFullscreenChange(el, false);
    expect(ctl.isActive).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
    ctl.destroy();
  });

  it('toggle 在不活跃 → 活跃 → 不活跃 之间成对调用钩子', async () => {
    const onEnter = vi.fn();
    const onExit = vi.fn();
    const ctl = new FullscreenController({ onChange: vi.fn(), onEnter, onExit });
    ctl.setElement(makeElement());

    await ctl.toggle();
    await ctl.toggle();
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('FullscreenController 钩子异常隔离（AC-52 不得阻断全屏）', () => {
  it('onEnter 同步抛错时仍进入全屏', async () => {
    const ctl = new FullscreenController({
      onChange: vi.fn(),
      onEnter: () => {
        throw new Error('StatusBar hide failed');
      },
    });
    ctl.setElement(makeElement());

    await expect(ctl.enter()).resolves.toBeUndefined();
    expect(ctl.isActive).toBe(true);
  });

  it('onExit 同步抛错时仍退出全屏', async () => {
    const ctl = new FullscreenController({
      onChange: vi.fn(),
      onExit: () => {
        throw new Error('StatusBar show failed');
      },
    });
    ctl.setElement(makeElement());

    await ctl.enter();
    await expect(ctl.exit()).resolves.toBeUndefined();
    expect(ctl.isActive).toBe(false);
  });

  it('onEnter 返回 rejected Promise 时仍进入全屏', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctl = new FullscreenController({
      onChange: vi.fn(),
      onEnter: () => Promise.reject(new Error('native plugin unavailable')),
    });
    ctl.setElement(makeElement());

    await expect(ctl.enter()).resolves.toBeUndefined();
    expect(ctl.isActive).toBe(true);
    // 让 microtask 跑完，reject 由控制器兜底
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('钩子缺失时全屏流程正常（Web 未注入 deviceService 的场景）', async () => {
    const ctl = new FullscreenController({ onChange: vi.fn() });
    ctl.setElement(makeElement());
    await ctl.enter();
    expect(ctl.isActive).toBe(true);
    await ctl.exit();
    expect(ctl.isActive).toBe(false);
  });
});
