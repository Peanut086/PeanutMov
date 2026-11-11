/**
 * 片头/片尾标记面板（B-06 · 唯一的手动标记入口）
 *
 * 源站没有章节数据，这块面板就是整条功能的入口，所以要点全在「按钮该不该按得下去」：
 * 没时长不许标、没标过不许清、点「此刻」拿到的是取整后的当前秒。
 */
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import SkipMarkSheet from '@/components/player/SkipMarkSheet.vue';

function mountSheet(props: Record<string, unknown>): VueWrapper {
  return mount(SkipMarkSheet, {
    props: { modelValue: true, marks: null, currentTime: 0, duration: 0, ...props },
    global: { stubs: { Teleport: true } },
  });
}

function row(wrapper: VueWrapper, index: number): DOMWrapper<Element> {
  return wrapper.findAll('.skip-sheet__row')[index]!;
}

describe('SkipMarkSheet', () => {
  // BottomSheet 里用了触觉反馈，起个 pinia 就够（标记面板本身不碰 store）
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('未标记时两行都写「未标记」，清除按钮按不下去', () => {
    const wrapper = mountSheet({ duration: 600, currentTime: 90 });
    const intro = row(wrapper, 0);
    const credits = row(wrapper, 1);

    expect(intro.get('.skip-sheet__value').text()).toBe('未标记');
    expect(credits.get('.skip-sheet__value').text()).toBe('未标记');
    expect(intro.findAll('button')[1]!.attributes('disabled')).toBeDefined();
    expect(credits.findAll('button')[1]!.attributes('disabled')).toBeDefined();
  });

  it('已标记时显示时间，并可单侧清除', async () => {
    const wrapper = mountSheet({ duration: 600, marks: { introEndSec: 90, creditsStartSec: null, updatedAt: 1 } });

    expect(row(wrapper, 0).get('.skip-sheet__value').text()).toBe('1:30');
    expect(row(wrapper, 1).get('.skip-sheet__value').text()).toBe('未标记');

    await row(wrapper, 0).findAll('button')[1]!.trigger('click');
    expect(wrapper.emitted('clear')).toEqual([['intro']]);
  });

  it('点「此刻」按取整后的当前秒标记', async () => {
    const wrapper = mountSheet({ duration: 600, currentTime: 85.4 });

    await row(wrapper, 0).findAll('button')[0]!.trigger('click');
    expect(wrapper.emitted('mark')).toEqual([['intro', 85]]);
  });

  it('时长未知时不给标：没有分母，标出来的边界毫无意义', async () => {
    const wrapper = mountSheet({ duration: 0, currentTime: 85 });
    const markButton = row(wrapper, 0).findAll('button')[0]!;

    expect(markButton.attributes('disabled')).toBeDefined();
    await markButton.trigger('click');
    expect(wrapper.emitted('mark')).toBeUndefined();
  });

  it('自动跳开关透传给设置', async () => {
    const wrapper = mountSheet({ duration: 600, autoSkip: true });

    await wrapper.get('.skip-sheet__switch [role="switch"]').trigger('click');
    expect(wrapper.emitted('update:autoSkip')).toEqual([[false]]);
  });
});
