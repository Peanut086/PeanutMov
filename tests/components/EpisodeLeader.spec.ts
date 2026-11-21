/**
 * 过片幕布的渲染层单测 —— G 批次·G-A06
 *
 * 幕布是盖在播放页上的一层纸，最要命的两个退化是：留在屏幕上不走、连点攒出多层。
 * 这里只核对 DOM 形态（动效本身是 CSS，happy-dom 不跑动画），计时由状态层负责。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EpisodeLeader from '@/components/player/EpisodeLeader.vue';
import {
  LEADER_MS,
  __resetEpisodeLeaderForTest,
  playEpisodeLeader,
} from '@/composables/useEpisodeLeader';

let wrapper: VueWrapper | null = null;

function render(): VueWrapper {
  wrapper = mount(EpisodeLeader);
  return wrapper;
}

beforeEach(() => {
  __resetEpisodeLeaderForTest();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  __resetEpisodeLeaderForTest();
  vi.unstubAllGlobals();
});

describe('EpisodeLeader', () => {
  it('没换集时 DOM 里一层都不挂', () => {
    const view = render();
    expect(view.find('.ep-leader').exists()).toBe(false);
  });

  it('换集后挂出片门与集号，到点自动撤干净', async () => {
    vi.useFakeTimers();
    const view = render();
    playEpisodeLeader(7);
    await view.vm.$nextTick();

    expect(view.find('.ep-leader').exists()).toBe(true);
    expect(view.get('.ep-leader__label').text()).toBe('EP 07');
    expect(view.findAll('.ep-leader__perf')).toHaveLength(2);

    vi.advanceTimersByTime(LEADER_MS);
    await view.vm.$nextTick();
    expect(view.find('.ep-leader').exists()).toBe(false);
    vi.useRealTimers();
  });

  it('连点三次仍只有一层（靠 seq 换 key 重播，不是叠加）', async () => {
    const view = render();
    playEpisodeLeader(1);
    await view.vm.$nextTick();
    playEpisodeLeader(2);
    await view.vm.$nextTick();
    playEpisodeLeader(3);
    await view.vm.$nextTick();

    expect(view.findAll('.ep-leader')).toHaveLength(1);
    expect(view.get('.ep-leader__label').text()).toBe('EP 03');
  });

  it('集号未知时只走过片，不编一个假号码', async () => {
    const view = render();
    playEpisodeLeader(null);
    await view.vm.$nextTick();

    expect(view.find('.ep-leader').exists()).toBe(true);
    expect(view.find('.ep-leader__label').exists()).toBe(false);
  });

  it('整层对辅助技术与手势都是隐形的：aria-hidden + 无按钮可聚焦', async () => {
    const view = render();
    playEpisodeLeader(5);
    await view.vm.$nextTick();

    expect(view.get('.ep-leader').attributes('aria-hidden')).toBe('true');
    expect(view.find('button').exists()).toBe(false);
  });
});
