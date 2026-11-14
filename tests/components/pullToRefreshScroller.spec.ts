/**
 * 11-14 #4：下拉刷新图标显示异常。
 *
 * 本 App 的骨架是 `min-height:100%`（没有确定高度），内层 body 的 `overflow-y:auto`
 * 从不溢出——真正在滚的是**文档**。组件原先只在挂载时找"插槽里 scrollHeight>clientHeight
 * 的子元素"，找不到就把"是否在顶部"恒判为真，于是：
 *   1) 页面滚到一半下拉也会触发刷新；
 *   2) 指示器 absolute 钉在内容区上沿，跟着文档滚出视口，还被 overflow:hidden 裁掉，
 *      用户看到的就是"图标不见了/位置不对"。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import PullToRefresh from '@/components/common/PullToRefresh.vue';
import SkipIntroPrompt from '@/components/player/SkipIntroPrompt.vue';

function setWindowScroll(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
}

/** 阻尼 0.5：要过 60px 阈值，手指得走 120px 以上 */
async function pull(wrapper: VueWrapper, fingerDistance: number): Promise<void> {
  await wrapper.trigger('touchstart', { touches: [{ clientY: 100 }] });
  await wrapper.trigger('touchmove', { touches: [{ clientY: 100 + fingerDistance }] });
  await wrapper.trigger('touchend', { touches: [] });
}

function indicatorEl(wrapper: VueWrapper): HTMLElement {
  return wrapper.get('.ptr-indicator').element as HTMLElement;
}

function mountWithScroller(): { wrapper: VueWrapper; scroller: HTMLElement } {
  const wrapper = mount(PullToRefresh, {
    slots: { default: '<div class="scroller" style="overflow-y: auto"><p>内容</p></div>' },
    attachTo: document.body,
  });
  const scroller = wrapper.get('.scroller').element as HTMLElement;
  Object.defineProperty(scroller, 'scrollHeight', { value: 800, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
  return { wrapper, scroller };
}

beforeEach(() => {
  // useHaptic 读设置 store
  setActivePinia(createPinia());
});

afterEach(() => {
  setWindowScroll(0);
  document.body.innerHTML = '';
});

describe('下拉刷新：谁在滚就按谁判顶部（#4）', () => {
  it('文档已下滚时下拉不触发刷新（此前恒判在顶部）', async () => {
    setWindowScroll(600);
    const wrapper = mount(PullToRefresh, { slots: { default: '<div class="body"><p>内容</p></div>' } });

    await pull(wrapper, 160);

    expect(wrapper.emitted('refresh')).toBeUndefined();
  });

  it('文档在顶部时正常触发，指示器钉在视口上而不是随文档滚走', async () => {
    setWindowScroll(0);
    const wrapper = mount(PullToRefresh, { slots: { default: '<div class="body"><p>内容</p></div>' } });

    await pull(wrapper, 160);

    expect(wrapper.emitted('refresh')).toHaveLength(1);
    const indicator = indicatorEl(wrapper);
    expect(indicator.style.position).toBe('fixed');
    expect(indicator.style.transform).toContain('translateY(60px)');
  });

  it('文档模式空闲时指示器透明，不常驻盖在顶栏/筛选条上', () => {
    setWindowScroll(0);
    const wrapper = mount(PullToRefresh, { slots: { default: '<div class="body"><p>内容</p></div>' } });

    // 先下拉再松手不足阈值 → 收回，指示器必须隐藏
    return pull(wrapper, 40).then(() => {
      expect(wrapper.emitted('refresh')).toBeUndefined();
      expect(indicatorEl(wrapper).style.opacity).toBe('0');
    });
  });

  it('插槽内自带滚动容器时沿用容器判定：容器下滚则不触发', async () => {
    setWindowScroll(0);
    const { wrapper, scroller } = mountWithScroller();
    scroller.scrollTop = 300;

    await pull(wrapper, 160);

    expect(wrapper.emitted('refresh')).toBeUndefined();
  });

  it('容器在顶部时触发，且指示器仍是 absolute（不改原有布局）', async () => {
    setWindowScroll(600); // 文档位置无关：判的是容器
    const { wrapper, scroller } = mountWithScroller();
    scroller.scrollTop = 0;

    await pull(wrapper, 160);

    expect(wrapper.emitted('refresh')).toHaveLength(1);
    expect(indicatorEl(wrapper).style.position).not.toBe('fixed');
  });
});

describe('下拉进度环底轨跟随主题（#4）', () => {
  it('下拉环用主题轨道色，浅色主题下不再隐形', async () => {
    const wrapper = mount(PullToRefresh, { slots: { default: '<div class="body"><p>内容</p></div>' } });
    await wrapper.trigger('touchstart', { touches: [{ clientY: 100 }] });
    await wrapper.trigger('touchmove', { touches: [{ clientY: 160 }] });

    const track = wrapper.get('.countdown-ring circle');
    expect(track.attributes('stroke')).toBe('var(--color-overlay-track)');
  });

  it('播放器 HUD 恒为深色底，默认底轨保持不变', () => {
    const wrapper = mount(SkipIntroPrompt, { props: { zone: 'intro', countdown: 3, total: 3 } });
    expect(wrapper.get('.countdown-ring circle').attributes('stroke')).toBe('rgba(255, 255, 255, 0.2)');
  });
});