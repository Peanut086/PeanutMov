/**
 * 播放画面层与氛围光层的挂载关系（C-09）
 *
 * 光晕层必须由设置决定存在与否——关掉以后不能只剩一个"看不见但仍在合成"的
 * 全屏模糊画布。取样行为本身在 `tests/unit/useAmbilight.spec.ts` 里压过。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import PlayerSurface from '@/components/player/PlayerSurface.vue';

const SUBTITLE = {
  size: 'medium',
  color: 'white',
  background: 'black',
  offsetSec: 0,
  preferredLang: null,
} as const;

function surface(props: Record<string, unknown> = {}) {
  return mount(PlayerSurface, {
    props: {
      subtitleText: '',
      subtitle: SUBTITLE,
      brightness: 100,
      mask: true,
      ...props,
    },
  });
}

describe('PlayerSurface 氛围光层', () => {
  it('开关打开时光晕画布挂在视频容器之前（画在画面之下）', () => {
    const wrapper = surface({ ambilightEnabled: true });
    const nodes = wrapper.findAll('[data-ambilight-canvas],[data-player-host]');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.attributes('data-ambilight-canvas')).toBeDefined();
    expect(nodes[1]?.attributes('data-player-host')).toBeDefined();
  });

  it('开关关闭时整层不存在，也不加 ambilight 类', () => {
    const wrapper = surface({ ambilightEnabled: false });
    expect(wrapper.find('[data-ambilight-canvas]').exists()).toBe(false);
    expect(wrapper.classes()).not.toContain('player-surface--ambilight');
  });

  it('取不到帧时只上报原因，画面容器与遮罩照常保留（不黑屏）', async () => {
    const wrapper = surface({ ambilightEnabled: true });
    expect(wrapper.find('[data-player-host]').exists()).toBe(true);
    expect(wrapper.find('[data-dim-layer]').exists()).toBe(true);
    // 没有 <video> 也不会抛错：blocked 由 composable 判定后向上 emit
    await wrapper.setProps({ ambilightEnabled: false });
    expect(wrapper.emitted('ambilight-blocked') ?? []).toHaveLength(0);
  });
});
