import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PosterImage from '@/components/common/PosterImage.vue';

/**
 * 海报兜底（P2-7）
 *
 * 真机实测：设备缓存 947 条条目的 `posterUrl` 没有一条为空，但抽样 6 个海报主机
 * 有 3 个 `new Image()` 加载 timeout/error——字段有值不等于渲染得出来。
 * 所以「加载失败」这条路径也要有图，而不是满屏「无封面」。
 */

const OSS_URL = 'https://demo.oss-cn-hangzhou.aliyuncs.com/pic/a.jpg';

describe('PosterImage 失败兜底', () => {
  it('加载成功：用协商后的原地址，不出占位', () => {
    const wrapper = mount(PosterImage, {
      props: { src: OSS_URL, alt: '绝命毒师', fallbackTitle: '绝命毒师', widthPx: 160 },
    });
    const img = wrapper.get('img.poster-image__img');
    expect(img.attributes('src')).toContain('x-oss-process=');
    expect(wrapper.find('.poster-image__placeholder').exists()).toBe(false);
  });

  it('加载失败 + 有片名：换成生成图，不出现「无封面」', async () => {
    const wrapper = mount(PosterImage, {
      props: { src: 'https://dead.example.com/a.jpg', alt: '绝命毒师', fallbackTitle: '绝命毒师' },
    });
    await wrapper.get('img.poster-image__img').trigger('error');

    const img = wrapper.get('img.poster-image__img');
    expect(img.attributes('src')).toMatch(/^data:image\/svg\+xml/);
    expect(wrapper.find('.poster-image__placeholder').exists()).toBe(false);
  });

  it('加载失败 + 没片名：仍按老行为退占位', async () => {
    const wrapper = mount(PosterImage, { props: { src: 'https://dead.example.com/a.jpg', alt: '无题' } });
    await wrapper.get('img.poster-image__img').trigger('error');

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('.poster-image__placeholder').text()).toBe('无封面');
  });

  it('地址缺失但有片名：直接给生成图', () => {
    const wrapper = mount(PosterImage, { props: { src: null, alt: '猎罪图鉴', fallbackTitle: '猎罪图鉴' } });
    expect(wrapper.get('img.poster-image__img').attributes('src')).toMatch(/^data:image\/svg\+xml/);
    expect(wrapper.find('.poster-image__placeholder').exists()).toBe(false);
  });

  it('换条目后失败态清零，重新给网络图一次机会', async () => {
    const wrapper = mount(PosterImage, {
      props: { src: 'https://dead.example.com/a.jpg', alt: 'A', fallbackTitle: 'A' },
    });
    await wrapper.get('img.poster-image__img').trigger('error');
    expect(wrapper.get('img.poster-image__img').attributes('src')).toMatch(/^data:image\/svg\+xml/);

    await wrapper.setProps({ src: 'https://other.example.com/b.jpg', alt: 'B', fallbackTitle: 'B' });
    expect(wrapper.get('img.poster-image__img').attributes('src')).toBe('https://other.example.com/b.jpg');
  });

  it('生成图本身也渲染不出来才落到占位（不让破图露出来）', async () => {
    const wrapper = mount(PosterImage, { props: { src: null, alt: '甲', fallbackTitle: '甲' } });
    await wrapper.get('img.poster-image__img').trigger('error');

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.poster-image__placeholder').exists()).toBe(true);
  });
});
