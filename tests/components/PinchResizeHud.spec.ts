/**
 * G-A09 · 画幅尺 HUD
 *
 * 这是捏合过程中唯一的可读反馈，验收点是"三档都在、说的是同一套话、当前档认得出来"。
 * 刻意不断言 computed style：VTU 不把 SFC `<style>` 注进 jsdom/happy-dom，
 * 只断言内联 style 与类名这些真的落在 DOM 上的东西。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PinchResizeHud from '@/components/player/PinchResizeHud.vue';

function render(pos: number, mode: 'contain' | 'cover' | 'fill') {
  return mount(PinchResizeHud, { props: { pos, mode } });
}

const NOTCH_LABELS = ['适应', '铺满', '拉伸'];

describe('画幅尺内容', () => {
  it('三档标签齐全，与画面弹层同一套话', () => {
    const wrapper = render(0.5, 'cover');
    const notches = wrapper.findAll('.pinch-hud__notch');
    expect(notches).toHaveLength(3);
    expect(notches.map((n) => n.text())).toEqual(NOTCH_LABELS);
  });

  it('标题显示当前档位名', () => {
    expect(render(0.5, 'cover').get('.pinch-hud__title').text()).toBe('画幅 · 铺满');
    expect(render(0, 'contain').get('.pinch-hud__title').text()).toBe('画幅 · 适应');
    expect(render(1, 'fill').get('.pinch-hud__title').text()).toBe('画幅 · 拉伸');
  });

  it('只亮当前档，其余两档保持可读但压暗', () => {
    const wrapper = render(0.9, 'fill');
    const lit = wrapper.findAll('.pinch-hud__notch--on');
    expect(lit).toHaveLength(1);
    expect(lit[0]?.text()).toBe('拉伸');
  });

  it('带 live 区域语义，方便读屏跟上档位变化', () => {
    const wrapper = render(0, 'contain');
    expect(wrapper.get('.pinch-hud').attributes('role')).toBe('status');
    expect(wrapper.get('.pinch-hud').attributes('aria-live')).toBe('polite');
  });

  it('整块尺不吃指针、也没有可聚焦控件', () => {
    const wrapper = render(0.5, 'cover');
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('a').exists()).toBe(false);
  });
});

describe('尺上的定位', () => {
  it('三档停靠位在 0% / 50% / 100%', () => {
    const notches = render(0, 'contain').findAll('.pinch-hud__notch');
    expect(notches.map((n) => n.attributes('style'))).toEqual([
      'left: 0%;',
      'left: 50%;',
      'left: 100%;',
    ]);
  });

  it('尺端两档改成内侧对齐，中间那档居中', () => {
    const notches = render(0, 'contain').findAll('.pinch-hud__notch');
    expect(notches[0]?.classes()).toContain('pinch-hud__notch--left');
    expect(notches[1]?.classes()).not.toContain('pinch-hud__notch--left');
    expect(notches[1]?.classes()).not.toContain('pinch-hud__notch--right');
    expect(notches[2]?.classes()).toContain('pinch-hud__notch--right');
  });

  it('滑块按画幅尺位置线性落位', () => {
    expect(render(0.5, 'cover').get('.pinch-hud__marker').attributes('style')).toBe('left: 50%;');
    expect(render(0, 'contain').get('.pinch-hud__marker').attributes('style')).toBe('left: 0%;');
  });
});
