import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import EmptyState from '@/components/common/EmptyState.vue';

/**
 * C-12：空态光圈（aperture）变体
 *
 * 锁的是"动效挂点存在"而不是"动效跑起来了"：happy-dom 不跑 CSS 动画，
 * 但叶片数量、六等分旋转、art 上的 --aperture 类一旦丢了，SearchView 的对焦动画就静默失效。
 */
function mountAperture(slots: Record<string, string> = {}) {
  return mount(EmptyState, {
    props: { variant: 'aperture', title: '没找到「庆余年」', description: '换个关键词试试' },
    slots,
  });
}

describe('EmptyState aperture 变体', () => {
  it('六片叶片 + 外圈 + 中心孔，构成开屏同款虹膜', () => {
    const wrapper = mountAperture();
    expect(wrapper.findAll('.empty-state__blade')).toHaveLength(6);
    expect(wrapper.find('.empty-state__iris-ring').exists()).toBe(true);
    expect(wrapper.find('.empty-state__pupil').exists()).toBe(true);
  });

  it('叶片各自挂在 60° 等分的旋转容器上，叶片本体不写基姿态', () => {
    const groups = mountAperture().findAll('.empty-state__iris');
    expect(groups.map((g) => g.attributes('transform'))).toEqual([
      'rotate(0 48 48)',
      'rotate(60 48 48)',
      'rotate(120 48 48)',
      'rotate(180 48 48)',
      'rotate(240 48 48)',
      'rotate(300 48 48)',
    ]);
  });

  it('叶片按琥珀透明度分层，并带 30ms 递延制造机械感', () => {
    const styles = mountAperture()
      .findAll('.empty-state__blade')
      .map((b) => b.attributes('style') ?? '');
    expect(new Set(styles.map((s) => s.match(/opacity:\s*([\d.]+)/)?.[1])).size).toBe(3);
    expect(styles[5]).toContain('150ms');
  });

  it('只有 aperture 变体挂对焦钩子类，其它变体不受影响', () => {
    expect(mountAperture().find('.empty-state__art--aperture').exists()).toBe(true);
    const plain = mount(EmptyState, { props: { variant: 'search' } });
    expect(plain.find('.empty-state__art--aperture').exists()).toBe(false);
    expect(plain.findAll('.empty-state__blade')).toHaveLength(0);
  });

  it('插槽落在说明与按钮之间，尾词芯片不会顶掉可执行按钮', () => {
    const wrapper = mount(EmptyState, {
      props: { variant: 'aperture', title: '没找到「庆余年」', description: '换个关键词试试', actionText: '返回' },
      slots: { default: '<div class="tail-chips"><button type="button">庆余</button></div>' },
    });
    const children = [...(wrapper.find('.empty-state').element as HTMLElement).children];
    const indexOf = (cls: string) => children.findIndex((el) => el.classList.contains(cls));
    expect(indexOf('empty-state__desc')).toBeGreaterThan(-1);
    expect(indexOf('tail-chips')).toBe(indexOf('empty-state__desc') + 1);
    expect(indexOf('empty-state__action')).toBe(children.length - 1);
    expect(wrapper.find('.tail-chips button').text()).toBe('庆余');
  });
});
