/**
 * 弹幕操作条（B-04 · UI 侧）
 *
 * 命中几何由渲染层给，这里只核对「挂得对不对」和「按钮各走各的出口」：
 * - 挂在弹幕头顶，头顶留白不足 56px 就翻到下方，别把半截裁掉；
 * - 横向锚点取弹幕矩形水平中点（贴边夹取写在 CSS 的 clamp 里，JS 不参与）；
 * - 点赞态（实心爱心 + aria-pressed + 数字）与四个出口互不串台。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import DanmakuActions from '@/components/player/DanmakuActions.vue';
import type { DanmakuPick } from '@/player/DanmakuOverlay';
import type { DanmakuComment } from '@/types';

function pick(left: number, top: number, time = 88.5, text = '名场面'): DanmakuPick {
  const comment: DanmakuComment = { text, time, mode: 'scroll', color: 0xffffff };
  return { comment, rect: { left, top, width: 60, height: 24 } };
}

function mountBar(p: DanmakuPick, liked = false, likeCount = 0): VueWrapper {
  return mount(DanmakuActions, { props: { pick: p, liked, likeCount } });
}

function styleOf(wrapper: VueWrapper): string {
  return wrapper.get('.danmaku-actions').attributes('style') ?? '';
}

function anchorX(wrapper: VueWrapper): string {
  return styleOf(wrapper).match(/--anchor-x:\s*([^;]+)/)?.[1] ?? '';
}

describe('DanmakuActions · 定位', () => {
  it('默认挂在弹幕头顶（上沿让开 10px），锚点取矩形水平中点', () => {
    const wrapper = mountBar(pick(300, 120));
    const style = styleOf(wrapper);

    expect(wrapper.get('.danmaku-actions').classes()).not.toContain('danmaku-actions--below');
    expect(style).toContain('top: 110px');
    expect(anchorX(wrapper)).toBe('330px');
  });

  it('贴近画面顶边：翻到弹幕下方', () => {
    const wrapper = mountBar(pick(300, 30));

    expect(wrapper.get('.danmaku-actions').classes()).toContain('danmaku-actions--below');
    expect(styleOf(wrapper)).toContain('top: 64px');
  });

  it('锚点四舍五入成整数像素：亚像素定位会让胶囊发虚', () => {
    expect(anchorX(mountBar(pick(300.4, 120)))).toBe('330px');
    expect(anchorX(mountBar(pick(300.6, 120)))).toBe('331px');
  });
});

describe('DanmakuActions · 点赞态与出口', () => {
  it('未赞：空心爱心、aria-pressed=false、计数原样显示', () => {
    const wrapper = mountBar(pick(300, 120), false, 3);

    expect(wrapper.get('.danmaku-actions__btn--like').classes()).not.toContain('is-liked');
    expect(wrapper.get('.danmaku-actions__btn--like').attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('.danmaku-actions__heart path').attributes('fill')).toBe('none');
    expect(wrapper.get('.danmaku-actions__count').text()).toBe('3');
  });

  it('已赞：实心 + is-liked + aria-pressed=true', () => {
    const wrapper = mountBar(pick(300, 120), true, 4);

    expect(wrapper.get('.danmaku-actions__btn--like').classes()).toContain('is-liked');
    expect(wrapper.get('.danmaku-actions__btn--like').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('.danmaku-actions__heart path').attributes('fill')).toBe('currentColor');
    expect(wrapper.get('.danmaku-actions__count').text()).toBe('4');
  });

  it('定位按钮直接写出目标时间', () => {
    expect(mountBar(pick(300, 120, 88.5)).text()).toContain('定位 1:28');
  });

  it('点赞 / 复制 / 定位 / 关闭四个出口互不串台', async () => {
    const wrapper = mountBar(pick(300, 120));
    const buttons = wrapper.findAll('button');

    await buttons[0]!.trigger('click');
    expect(wrapper.emitted('like')).toHaveLength(1);
    expect(wrapper.emitted('copy')).toBeUndefined();

    await buttons[1]!.trigger('click');
    expect(wrapper.emitted('copy')).toHaveLength(1);

    await buttons[2]!.trigger('click');
    expect(wrapper.emitted('locate')).toHaveLength(1);

    await buttons[3]!.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.emitted('locate')).toHaveLength(1);
  });
});
