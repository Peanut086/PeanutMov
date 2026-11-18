import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 11-14 #1：播放中设备仍会熄屏。
 *
 * 常亮锁的真实状态是原生窗口的 FLAG_KEEP_SCREEN_ON，而 JS 侧只缓存「我开过了」。
 * 窗口一旦重建（MainActivity 在 WebView 渲染进程崩溃时 recreate）flag 就没了，
 * 缓存却还说亮着 → 之后再也不补，整集播完都在熄屏。
 * 另一条：Vue 先挂新页再卸旧页，旧页的释放会把新页刚拿到的锁清掉。
 */

const mocks = vi.hoisted(() => {
  const state = { flag: false };
  return {
    state,
    logs: [] as string[],
    keepAwake: vi.fn(async () => {
      state.flag = true;
    }),
    allowSleep: vi.fn(async () => {
      state.flag = false;
    }),
    isKeptAwake: vi.fn(async () => ({ isKeptAwake: state.flag })),
  };
});

vi.mock('@capacitor-community/keep-awake', () => ({
  KeepAwake: {
    keepAwake: mocks.keepAwake,
    allowSleep: mocks.allowSleep,
    isKeptAwake: mocks.isKeptAwake,
  },
}));
vi.mock('@/shared/platform', () => ({ isNative: () => true }));
vi.mock('@/shared/logger', () => ({
  logger: {
    info: (msg: string) => mocks.logs.push(msg),
    warn: () => {},
  },
}));

import { deviceService } from '@/services/deviceService';

const ownerA = { page: 'A' };
const ownerB = { page: 'B' };

describe('常亮锁：以窗口 flag 为准 + 归属判定', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.state.flag = false;
    mocks.logs.length = 0;
    mocks.keepAwake.mockClear();
    mocks.allowSleep.mockClear();
    mocks.isKeptAwake.mockClear();
    // 模块级期望态跨用例保留，先显式释放回到干净起点
    await deviceService.keepAwake(false);
    mocks.keepAwake.mockClear();
    mocks.allowSleep.mockClear();
    mocks.isKeptAwake.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('持锁期间窗口 flag 被清掉 → 看门狗周期内自动补回', async () => {
    await deviceService.keepAwake(true, ownerA);
    expect(mocks.state.flag).toBe(true);
    expect(mocks.keepAwake).toHaveBeenCalledTimes(1);

    // Activity 重建：flag 没了，JS 侧期望态仍是 true
    mocks.state.flag = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.keepAwake).toHaveBeenCalledTimes(2);
    expect(mocks.state.flag).toBe(true);
  });

  it('起播瞬间 true→false→true 三连并发 → 锁最终仍在（首集熄屏回归）', async () => {
    // 让 isKeptAwake 悬挂住，模拟桥往返期间状态又跳了两次
    let release: ((v: { isKeptAwake: boolean }) => void) | null = null;
    // 赋值发生在 Promise 执行器里，TS 看不见，用闭包按声明类型取值
    const settle = (value: { isKeptAwake: boolean }): void => {
      release?.(value);
    };
    mocks.isKeptAwake.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const first = deviceService.keepAwake(true, ownerA);
    const second = deviceService.keepAwake(false, ownerA);
    const third = deviceService.keepAwake(true, ownerA);
    await Promise.resolve();
    settle({ isKeptAwake: false });
    await Promise.all([first, second, third]);

    // 过期那一轮读到的 false 不能把刚拿到的锁撤掉
    expect(mocks.state.flag).toBe(true);
    expect(mocks.allowSleep).not.toHaveBeenCalled();
  });

  it('对齐日志按本轮意图记，不被对齐期间到达的新意图改写', async () => {
    await deviceService.keepAwake(true, ownerA);
    mocks.logs.length = 0;

    let release: ((v: { isKeptAwake: boolean }) => void) | null = null;
    const settle = (value: { isKeptAwake: boolean }): void => {
      release?.(value);
    };
    mocks.isKeptAwake.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    // 释放轮已在路上（原生往返悬挂，读到的仍是持锁时的 flag），此时起播又下了持锁意图
    const releasing = deviceService.keepAwake(false, ownerA);
    await Promise.resolve();
    const holding = deviceService.keepAwake(true, ownerA);
    settle({ isKeptAwake: true });
    await Promise.all([releasing, holding]);

    const lines = mocks.logs.filter((s) => s.startsWith('屏幕常亮'));
    expect(lines).toEqual([
      expect.stringContaining('释放（意图 离开释放'),
      expect.stringContaining('持锁（意图 起播持锁'),
    ]);
  });

  it('原生调用抛错 → 退避重试后仍然持锁', async () => {
    mocks.keepAwake.mockRejectedValueOnce(new Error('bridge busy'));
    await deviceService.keepAwake(true, ownerA);
    expect(mocks.state.flag).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.state.flag).toBe(true);
  });

  it('旧页卸载不能清掉新页刚拿到的锁', async () => {
    await deviceService.keepAwake(true, ownerA);
    await deviceService.keepAwake(true, ownerB);
    await deviceService.keepAwake(false, ownerA);

    expect(mocks.allowSleep).not.toHaveBeenCalled();
    expect(mocks.state.flag).toBe(true);

    await deviceService.keepAwake(false, ownerB);
    expect(mocks.allowSleep).toHaveBeenCalledTimes(1);
    expect(mocks.state.flag).toBe(false);
  });

  it('释放后看门狗停摆，不再周期性打扰原生', async () => {
    await deviceService.keepAwake(true, ownerA);
    await deviceService.keepAwake(false, ownerA);
    mocks.keepAwake.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mocks.keepAwake).not.toHaveBeenCalled();
    expect(mocks.state.flag).toBe(false);
  });

  it('期望态未变且刚核对过 → 不重复下发原生调用', async () => {
    await deviceService.keepAwake(true, ownerA);
    await deviceService.keepAwake(true, ownerA);
    await deviceService.keepAwake(true, ownerA);

    expect(mocks.keepAwake).toHaveBeenCalledTimes(1);
  });

  it('原生已经亮着时不再重复 addFlags，只对齐缓存', async () => {
    mocks.state.flag = true;
    await deviceService.keepAwake(true, ownerA);

    expect(mocks.keepAwake).not.toHaveBeenCalled();
    expect(mocks.isKeptAwake).toHaveBeenCalled();
  });
});
