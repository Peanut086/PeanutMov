/**
 * 睡眠定时（B3）
 *
 * 断言：
 * - 分钟档按截止时间戳算剩余：切后台被节流后回到前台第一拍就补齐差额
 * - 到点只触发一次 onExpire，并自动复位
 * - 「播完本集」不计时，consumeEpisodeEnd 接管结束（调用方据此跳过连播）
 * - 取消 / 作用域销毁都停表，不留 interval
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import { useSleepTimer, type SleepTimerChoice } from '@/composables/useSleepTimer';

describe('睡眠定时（B3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const fired: SleepTimerChoice[] = [];
    const scope = effectScope();
    const api = scope.run(() => useSleepTimer({ onExpire: (c) => fired.push(c) }))!;
    return { api, fired, scope };
  }

  it('分钟档到点暂停一次并复位', () => {
    const { api, fired, scope } = setup();
    api.setMinutes(15);
    expect(api.active.value).toBe(true);
    expect(api.remainingSec.value).toBe(900);

    vi.advanceTimersByTime(14 * 60_000);
    expect(api.remainingSec.value).toBe(60);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([15]);
    expect(api.active.value).toBe(false);
    expect(api.label.value).toBe('关闭');

    // 复位后继续走时不应再触发
    vi.advanceTimersByTime(30 * 60_000);
    expect(fired).toEqual([15]);
    scope.stop();
  });

  it('定时器被节流后，回到前台第一拍按时间戳补齐差额', () => {
    const { api, fired, scope } = setup();
    const startedAt = Date.now();
    api.setMinutes(30);

    // 模拟切后台：系统时间跳到 29 分钟后，interval 只跑了一拍
    vi.setSystemTime(startedAt + 29 * 60_000);
    vi.advanceTimersByTime(1_000);
    expect(api.remainingSec.value).toBe(59);

    vi.setSystemTime(startedAt + 31 * 60_000);
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([30]);
    scope.stop();
  });

  it('「播完本集」不计时，结束时接管一次', () => {
    const { api, fired, scope } = setup();
    api.setFinishEpisode();
    expect(api.active.value).toBe(true);
    expect(api.label.value).toBe('播完本集');
    expect(api.remainingSec.value).toBe(0);

    vi.advanceTimersByTime(120 * 60_000);
    expect(fired).toEqual([]);

    expect(api.consumeEpisodeEnd()).toBe(true);
    expect(fired).toEqual(['episode']);
    expect(api.active.value).toBe(false);
    // 已复位：下一次结束不该再被接管
    expect(api.consumeEpisodeEnd()).toBe(false);
    scope.stop();
  });

  it('分钟档不接管本集结束', () => {
    const { api, fired, scope } = setup();
    api.setMinutes(45);
    expect(api.consumeEpisodeEnd()).toBe(false);
    expect(fired).toEqual([]);
    expect(api.active.value).toBe(true);
    scope.stop();
  });

  it('取消与作用域销毁都停表', () => {
    const { api, fired, scope } = setup();
    api.setMinutes(15);
    api.cancel();
    vi.advanceTimersByTime(20 * 60_000);
    expect(fired).toEqual([]);
    expect(api.active.value).toBe(false);

    api.setMinutes(15);
    scope.stop();
    vi.advanceTimersByTime(20 * 60_000);
    expect(fired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('改档位重置倒计时，不叠加旧表', () => {
    const { api, fired, scope } = setup();
    api.setMinutes(15);
    vi.advanceTimersByTime(10 * 60_000);
    api.setMinutes(60);
    expect(api.remainingSec.value).toBe(3600);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(50 * 60_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(fired).toEqual([60]);
    scope.stop();
  });
});