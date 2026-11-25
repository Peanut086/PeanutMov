import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';

import PlayerControls from '@/components/player/PlayerControls.vue';
import SeekBar from '@/components/player/SeekBar.vue';

function mountControls(overrides: Record<string, unknown> = {}) {
  return mount(PlayerControls, {
    props: {
      visible: true,
      title: '测试剧集',
      playing: false,
      waiting: false,
      currentTime: 12,
      duration: 100,
      buffered: 40,
      rate: 1,
      canPrev: false,
      canNext: false,
      showEpisodeNav: false,
      fullscreen: false,
      subtitleActive: false,
      qualityLabel: '自动',
      ...overrides,
    },
  });
}

describe('PlayerControls 播放能力', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('总时长未知时诚实提示，并禁用进度条定位', () => {
    const wrapper = mountControls({ duration: 0, seekReliable: false });

    expect(wrapper.text()).toContain('总时长未知');
    expect(wrapper.findComponent(SeekBar).props('seekEnabled')).toBe(false);
  });

  it('时长与定位能力已知时恢复进度条定位', () => {
    const wrapper = mountControls();

    expect(wrapper.text()).toContain('剩余 01:28');
    expect(wrapper.findComponent(SeekBar).props('seekEnabled')).toBe(true);
  });
});
