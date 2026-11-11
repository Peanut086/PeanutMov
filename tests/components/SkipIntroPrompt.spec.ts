/**
 * 跳过片头/片尾胶囊（B-06 · UI 侧）
 *
 * 逻辑在 composable，这里只核对两件真机最容易翻车的事：
 * 文案有没有跟错区段，以及关了自动跳之后环还在不在转（环在转就等于还会自己跳）。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SkipIntroPrompt from '@/components/player/SkipIntroPrompt.vue';

type PillProps = { zone: 'intro' | 'credits'; countdown?: number; total?: number; auto?: boolean };

function mountPill(props: PillProps): VueWrapper {
  return mount(SkipIntroPrompt, { props });
}

function ringOffset(wrapper: VueWrapper): number {
  return Number(wrapper.get('.countdown-ring__fill').attributes('stroke-dashoffset'));
}

describe('SkipIntroPrompt', () => {
  it('按区段切文案：片头/片尾各叫各的', () => {
    expect(mountPill({ zone: 'intro', countdown: 3 }).text()).toContain('跳过片头');
    expect(mountPill({ zone: 'credits', countdown: 3 }).text()).toContain('跳过片尾');
  });

  it('倒计时中的环按剩余比例收圈（3s 走满一圈）', () => {
    const full = mountPill({ zone: 'intro', countdown: 3, total: 3 });
    expect(full.find('.countdown-ring__fill').exists()).toBe(true);
    expect(ringOffset(full)).toBeCloseTo(0, 6);

    const half = mountPill({ zone: 'intro', countdown: 2, total: 3 });
    expect(ringOffset(half)).toBeCloseTo(94.2 / 3, 4);
  });

  it('关掉自动跳：不画环，胶囊停在「点了才跳」的状态', () => {
    const wrapper = mountPill({ zone: 'intro', countdown: 0, auto: false });

    expect(wrapper.find('.countdown-ring__fill').exists()).toBe(false);
    expect(wrapper.get('.skip-prompt__pill').classes()).toContain('skip-prompt__pill--still');
  });

  it('不自动跳但倒计时归零时也不画环', () => {
    const wrapper = mountPill({ zone: 'intro', countdown: 0, auto: true });

    expect(wrapper.find('.countdown-ring__fill').exists()).toBe(false);
    expect(wrapper.get('.skip-prompt__pill').classes()).not.toContain('skip-prompt__pill--still');
  });

  it('点文字跳过、点 ✕ 关闭，两个出口互不串台', async () => {
    const wrapper = mountPill({ zone: 'intro', countdown: 3 });

    await wrapper.get('.skip-prompt__text').trigger('click');
    expect(wrapper.emitted('skip')).toHaveLength(1);
    expect(wrapper.emitted('dismiss')).toBeUndefined();

    await wrapper.get('.skip-prompt__close').trigger('click');
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
    expect(wrapper.emitted('skip')).toHaveLength(1);
  });
});
