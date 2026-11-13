import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PosterImage from '@/components/common/PosterImage.vue';
import { IMG_W_CARD } from '@/shared/imageSize';

/**
 * 海报尺寸协商落到 DOM（P2-15）
 *
 * `PosterImage` 是全站唯一的海报出口，`widthPx` 只在这里被消费一次；
 * 组件级断言保证「档位传了真的用上了」，而不只是 helper 单测里自洽。
 */

const OSS = 'https://b.oss-cn-shenzhen.aliyuncs.com/p/1.jpg';
const OTHER = 'https://img.other-host.com/p/1.jpg';

function srcOf(src: string, widthPx = 0): string | undefined {
  return mount(PosterImage, { props: { src, alt: '海报', widthPx } }).get('.poster-image__img').attributes('src');
}

describe('PosterImage widthPx', () => {
  it('给了 widthPx 且主机认得：请求缩放后的地址', () => {
    expect(srcOf(OSS, IMG_W_CARD)).toBe(
      'https://b.oss-cn-shenzhen.aliyuncs.com/p/1.jpg?x-oss-process=image/resize,w_540/quality,q_80',
    );
  });

  it('给了 widthPx 但主机不认得：保持原地址（不能因为协商而图裂）', () => {
    expect(srcOf(OTHER, IMG_W_CARD)).toBe(OTHER);
  });

  it('不指定档位（默认 0）：一律原样请求', () => {
    expect(srcOf(OSS)).toBe(OSS);
  });

  it('协商后的地址出错仍然切占位，不会因为 query 变化丢掉失败态', async () => {
    const wrapper = mount(PosterImage, { props: { src: OSS, alt: '海报', widthPx: IMG_W_CARD } });
    await wrapper.get('.poster-image__img').trigger('error');

    expect(wrapper.find('.poster-image__img').exists()).toBe(false);
    expect(wrapper.find('.poster-image__placeholder').exists()).toBe(true);
  });

  it('换海报时重置加载态，query 参数不干扰 src 变化的观测', async () => {
    const wrapper = mount(PosterImage, { props: { src: OSS, alt: '海报', widthPx: IMG_W_CARD } });
    await wrapper.get('.poster-image__img').trigger('error');

    await wrapper.setProps({ src: `${OSS}?Expires=1` });
    const img = wrapper.get('.poster-image__img');
    expect(img.attributes('src')).toBe(
      'https://b.oss-cn-shenzhen.aliyuncs.com/p/1.jpg?Expires=1&x-oss-process=image/resize,w_540/quality,q_80',
    );
  });
});
