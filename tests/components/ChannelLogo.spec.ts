/**
 * 频道台标（C1）
 *
 * 断言三层降级都不留破图：有图走 img，失败/无图退号牌；
 * 号牌取频道号而不是首字母（CCTV 全家都姓 C，首字母等于没信息）；
 * 同名同色、异名大概率异色，列表才是可分辨的色块。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ChannelLogo from '@/components/live/ChannelLogo.vue';

describe('ChannelLogo', () => {
  it('有台标：渲染 img，号牌打底不空窗', () => {
    const wrapper = mount(ChannelLogo, {
      props: { src: 'https://cdn.example.com/cctv1.png', name: 'CCTV-1 综合' },
    });

    const img = wrapper.get('.channel-logo__img');
    expect(img.attributes('src')).toBe('https://cdn.example.com/cctv1.png');
    expect(img.attributes('loading')).toBe('lazy');
    expect(wrapper.get('.channel-logo__badge').text()).toBe('1');
  });

  it('加载失败：撤掉 img，只留号牌', async () => {
    const wrapper = mount(ChannelLogo, {
      props: { src: 'https://cdn.example.com/404.png', name: 'CCTV-13 新闻' },
    });

    await wrapper.get('.channel-logo__img').trigger('error');
    expect(wrapper.find('.channel-logo__img').exists()).toBe(false);
    expect(wrapper.get('.channel-logo__badge').text()).toBe('13');
  });

  it('换台标地址后重新给机会加载，不沿用上一张的失败态', async () => {
    const wrapper = mount(ChannelLogo, {
      props: { src: 'https://cdn.example.com/a.png', name: '湖南卫视' },
    });
    await wrapper.get('.channel-logo__img').trigger('error');
    expect(wrapper.find('.channel-logo__img').exists()).toBe(false);

    await wrapper.setProps({ src: 'https://cdn.example.com/b.png' });
    expect(wrapper.find('.channel-logo__img').exists()).toBe(true);
  });

  it('无台标：中文台取首字，带号台取频道号', () => {
    expect(
      mount(ChannelLogo, { props: { src: null, name: '湖南卫视' } }).get('.channel-logo__badge').text(),
    ).toBe('湖');
    expect(
      mount(ChannelLogo, { props: { src: null, name: 'CCTV-5+ 体育赛事' } }).get('.channel-logo__badge').text(),
    ).toBe('5');
    expect(
      mount(ChannelLogo, { props: { src: null, name: 'phoenix' } }).get('.channel-logo__badge').text(),
    ).toBe('P');
  });

  it('同名恒定同色，色板内取值', () => {
    const styleOf = (name: string) =>
      mount(ChannelLogo, { props: { src: null, name } }).get('.channel-logo__badge').attributes('style') ?? '';

    expect(styleOf('浙江卫视')).toBe(styleOf('浙江卫视'));
    expect(styleOf('浙江卫视')).toContain('hsl(');

    const hues = new Set(
      ['CCTV-1', '湖南卫视', '浙江卫视', '东方卫视', '北京卫视', '江苏卫视', '广东卫视', '深圳卫视']
        .map(styleOf)
        .map((s) => /hsl\((\d+)/.exec(s)?.[1]),
    );
    // 8 支色板散列，8 个台至少铺开 4 种色，不会整屏一个灰
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });

  it('尺寸按 size 落到容器上', () => {
    const wrapper = mount(ChannelLogo, { props: { src: null, name: 'CCTV-1', size: 40 } });
    const style = wrapper.get('.channel-logo').attributes('style') ?? '';
    expect(style).toContain('width: 40px');
    expect(style).toContain('height: 40px');
  });
});