/**
 * 手势帮助自动弹出的去重策略
 *
 * 红线：同一次会话里长按最多自动弹 1 次；跨会话要过冷却期；
 * localStorage 异常（隐私模式 / 坏值）时退化成"仅会话内去重"，
 * 不能因为读不到标记就彻底不弹，也不能每按一次就弹一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canShowGestureHelp,
  markGestureHelpShown,
  resetGestureHelpSession,
} from '@/player/gestureHelpPolicy';

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'player-gesture-help-at';

describe('gestureHelpPolicy', () => {
  beforeEach(() => {
    localStorage.clear();
    resetGestureHelpSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetGestureHelpSession();
  });

  it('首装后允许自动弹出，弹出后同会话内不再弹', () => {
    expect(canShowGestureHelp()).toBe(true);
    markGestureHelpShown();
    expect(canShowGestureHelp()).toBe(false);
  });

  it('新会话仍在 7 天冷却期内不弹，期满恢复', () => {
    markGestureHelpShown(1_000_000);
    resetGestureHelpSession();
    expect(canShowGestureHelp(1_000_000 + 6 * DAY_MS)).toBe(false);
    expect(canShowGestureHelp(1_000_000 + 7 * DAY_MS)).toBe(true);
  });

  it('标记是坏值时按"没弹过"处理', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number');
    expect(canShowGestureHelp()).toBe(true);
  });

  it('localStorage 读写异常时退化为会话内去重', () => {
    const boom = () => {
      throw new Error('storage disabled');
    };
    vi.spyOn(localStorage, 'getItem').mockImplementation(boom);
    vi.spyOn(localStorage, 'setItem').mockImplementation(boom);

    expect(canShowGestureHelp()).toBe(true);
    markGestureHelpShown();
    expect(canShowGestureHelp()).toBe(false);
    // 会话内标记还在，但持久化写不进去 → 新会话又会放行一次（可接受的降级）
    resetGestureHelpSession();
    expect(canShowGestureHelp()).toBe(true);
  });
});
