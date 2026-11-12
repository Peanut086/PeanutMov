/**
 * 横屏屏幕锁（B4 · UI 侧）
 *
 * 只核对真机上最容易翻车的三件事：
 * 锁定态有没有真的铺出拦截片、胶囊隐藏后还能不能靠轻触画面唤回、
 * 以及点胶囊到底发的是 toggle 还是 reveal（发错就永远解不开）。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PlayerScreenLock from '@/components/player/PlayerScreenLock.vue';

describe('PlayerScreenLock', () => {
  it('未锁定：不铺拦截片，胶囊发 toggle', async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: false, revealed: true } });

    expect(wrapper.find('.lock-shield').exists()).toBe(false);
    const pill = wrapper.get('.lock-pill');
    expect(pill.text()).toContain('锁屏');
    expect(pill.attributes('aria-pressed')).toBe('false');

    await pill.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
    expect(wrapper.emitted('reveal')).toBeUndefined();
  });

  it('锁定：铺拦截片，轻触画面只发 reveal，不解锁', async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: true, revealed: false } });

    const shield = wrapper.get('.lock-shield');
    expect(wrapper.find('.lock-pill').exists()).toBe(false);

    await shield.trigger('click');
    expect(wrapper.emitted('reveal')).toHaveLength(1);
    expect(wrapper.emitted('toggle')).toBeUndefined();
  });

  it('锁定 + 胶囊露出：点胶囊发 toggle，不会穿透成 reveal', async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: true, revealed: true } });

    const pill = wrapper.get('.lock-pill');
    expect(pill.text()).toContain('已锁定');
    expect(pill.attributes('aria-pressed')).toBe('true');
    expect(pill.attributes('aria-label')).toBe('解锁屏幕');

    await pill.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
    expect(wrapper.emitted('reveal')).toBeUndefined();
  });

  it('胶囊按 revealed 显隐', async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: false, revealed: true } });
    expect(wrapper.find('.lock-pill').exists()).toBe(true);

    await wrapper.setProps({ revealed: false });
    expect(wrapper.find('.lock-pill').exists()).toBe(false);
  });
});