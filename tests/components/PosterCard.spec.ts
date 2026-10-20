import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { MediaItem } from '@/types';
import PosterCard from '@/components/media/PosterCard.vue';

/**
 * PosterCard 测试（设计规范 8.4 / AC-17 / AC-19）
 *
 * - 2:3 海报容器与懒加载属性
 * - 标题 2 行截断、元信息格式
 * - 角标：集数 / 演示 / 已下载
 * - 进度条 aria 属性
 * - 点击 emit select；长按 emit longpress（500ms）
 */
function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'mock:demo-001~a1',
    sourceId: 'mock',
    sourceItemId: 'demo-001',
    title: 'Big Buck Bunny',
    originalTitle: null,
    type: 'movie',
    year: 2008,
    area: '美国',
    genres: ['动画', '喜剧'],
    tags: ['mock'],
    rating: null,
    posterUrl: 'https://example.test/poster.jpg',
    backdropUrl: null,
    description: '公开版权样片',
    durationSec: 596,
    episodeCount: null,
    titleLower: 'big buck bunny',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('PosterCard', () => {
  it('渲染 2:3 海报、懒加载属性与无障碍标签', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem() } });
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
    expect(img.attributes('alt')).toBe('Big Buck Bunny');

    const button = wrapper.find('button.poster-card');
    expect(button.attributes('aria-label')).toBe('Big Buck Bunny，2008');
  });

  it('标题使用 2 行截断，元信息为「年份 · 类型」', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem({ type: 'series', year: 2021 }) } });
    expect(wrapper.find('.poster-card__title').classes()).toContain('clamp-2');
    expect(wrapper.find('.poster-card__meta').text()).toBe('2021 · 剧集');
  });

  it('集数角标：多集时显示「全 N 集」，演示时显示演示角标', () => {
    const withEpisodes = mount(PosterCard, {
      props: { item: makeItem({ type: 'series', episodeCount: 24 }) },
    });
    expect(withEpisodes.text()).toContain('全 24 集');

    const demo = mount(PosterCard, { props: { item: makeItem({ isDemo: true }) } });
    expect(demo.text()).toContain('演示');
    expect(demo.find('.poster-card__badge--demo').exists()).toBe(true);
  });

  it('进度条按 0~1 换算为百分比并写入 aria', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem(), progress: 0.456 } });
    const bar = wrapper.find('[role="progressbar"]');
    expect(bar.exists()).toBe(true);
    expect(bar.attributes('aria-valuenow')).toBe('46');
    expect(bar.attributes('aria-valuemax')).toBe('100');
  });

  it('无进度时不渲染进度条', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem() } });
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
  });

  it('点击卡片 emit select，携带完整 item', async () => {
    const item = makeItem();
    const wrapper = mount(PosterCard, { props: { item } });
    await wrapper.find('button.poster-card').trigger('click');
    const emitted = wrapper.emitted('select');
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]?.[0]).toMatchObject({ id: item.id, title: item.title });
  });

  it('图片加载失败时显示占位（不出现破图）', async () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem() } });
    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('无封面');
  });

  it('长按 500ms 触发 longpress', async () => {
    const item = makeItem();
    const wrapper = mount(PosterCard, { props: { item }, attachTo: document.body });
    const btn = wrapper.find('button.poster-card');

    await btn.trigger('pointerdown');
    await new Promise((resolve) => setTimeout(resolve, 520));
    await btn.trigger('pointerup');

    expect(wrapper.emitted('longpress')).toHaveLength(1);
    // 长按后松手不应同时触发点击导航
    await btn.trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    wrapper.unmount();
  });
});
