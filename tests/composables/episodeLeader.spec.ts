/**
 * 换集过片幕布的状态单测 —— G 批次·G-A06
 *
 * 这个功能最容易出的事故是"幕布留在画面上不走"和"连点攒出好几层"，
 * 所以重点盯三件事：撤层时机、多次触发只有一层、减弱动效压根不触发。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEADER_MS,
  __resetEpisodeLeaderForTest,
  leaderLabelFor,
  playEpisodeLeader,
  stopEpisodeLeader,
  useEpisodeLeader,
} from '@/composables/useEpisodeLeader';

const leader = useEpisodeLeader();

function stubReducedMotion(on: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () => ({ matches: on } as MediaQueryList),
  );
}

beforeEach(() => {
  __resetEpisodeLeaderForTest();
  vi.useFakeTimers();
  vi.restoreAllMocks();
  stubReducedMotion(false);
});

describe('集号文案', () => {
  it('个位补零：第 7 集写成 EP 07，两位数照常', () => {
    expect(leaderLabelFor(7)).toBe('EP 07');
    expect(leaderLabelFor(12)).toBe('EP 12');
    expect(leaderLabelFor(120)).toBe('EP 120');
  });

  it('集号未知/非法就不编号码（只放过片，不编一个假的 EP 01）', () => {
    expect(leaderLabelFor(null)).toBe('');
    expect(leaderLabelFor(0)).toBe('');
    expect(leaderLabelFor(-3)).toBe('');
    expect(leaderLabelFor(Number.NaN)).toBe('');
  });
});

describe('触发与撤层', () => {
  it('触发即亮，到 LEADER_MS 必撤', () => {
    playEpisodeLeader(7);
    expect(leader.visible.value).toBe(true);
    expect(leader.label.value).toBe('EP 07');

    vi.advanceTimersByTime(LEADER_MS - 1);
    expect(leader.visible.value).toBe(true);

    vi.advanceTimersByTime(1);
    expect(leader.visible.value).toBe(false);
  });

  it('连续换集：后一次的计时器接管前一次，幕布不会在上一次到点时提前消失', () => {
    playEpisodeLeader(7);
    vi.advanceTimersByTime(100);
    playEpisodeLeader(8);

    // 第一次的 300ms 到点（累计 300ms），此时第二次才走了 200ms，必须还在
    vi.advanceTimersByTime(200);
    expect(leader.visible.value).toBe(true);
    expect(leader.label.value).toBe('EP 08');

    vi.advanceTimersByTime(100);
    expect(leader.visible.value).toBe(false);
  });

  it('每次触发 seq 递增（渲染层靠它换 key 重播），但状态只有一份', () => {
    playEpisodeLeader(1);
    const afterFirst = leader.seq.value;
    playEpisodeLeader(2);
    expect(leader.seq.value).toBe(afterFirst + 1);
  });

  it('stopEpisodeLeader 立即撤层并清掉挂起的计时器', () => {
    playEpisodeLeader(9);
    stopEpisodeLeader();
    expect(leader.visible.value).toBe(false);

    // 计时器已回收：再推进到点时间也不会把状态翻回来
    vi.advanceTimersByTime(LEADER_MS * 2);
    expect(leader.visible.value).toBe(false);
  });
});

describe('减弱动效', () => {
  it('reduce 下完全不触发：不是变慢，是不演', () => {
    stubReducedMotion(true);
    playEpisodeLeader(7);

    expect(leader.visible.value).toBe(false);
    expect(leader.seq.value).toBe(0);
    expect(leader.label.value).toBe('');
  });
});
