/**
 * 方向感知转场（OPT-02 · B-07 的前置）
 *
 * 这个 bug 藏了很久：`router.beforeEach` 的第一个参数是 `to` 不是 `from`，
 * 于是 prevDepth 拿到的是目标深度，`toDepth === from` 恒成立 → 所有导航都退化成
 * fade，slide-left / slide-right 一次都没跑过。边缘返回的"松手后交给现有 pop"
 * 要能看出视差，这条判断必须先能被断言。
 *
 * 断言取的是 `<Transition>` 的 name：VTU 在测试里把 Transition 替成
 * `transition-stub name="…"`，正好只校验外壳的选择逻辑，不掺 CSS 过渡时序。
 * （转场期间新旧页重叠由 transitions.css 负责，浏览器实测过，不在这里断言。）
 */
import { createPinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import App from '@/App.vue';
import router, { setComplianceGate } from '@/router';
import { sharedCoverActive } from '@/composables/useSharedElement';
import { mockSettingsService } from '@/mocks/mockServices';
import { COMPLIANCE_VERSION } from '@/shared/constants';

let wrapper: VueWrapper | null = null;

/** 外壳 `<Transition>` 当前选中的动画名 */
function transitionName(): string {
  const el = document.querySelector('.app-content transition-stub, .app-content > transition-stub');
  return el?.getAttribute('name') ?? '';
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

beforeEach(async () => {
  mockSettingsService.__reset();
  setComplianceGate(mockSettingsService);
  await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
  await router.replace('/');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [createPinia(), router] }, attachTo: document.body });
  await settle();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  sharedCoverActive.value = false;
});

describe('路由转场方向', () => {
  it('一级 → 二级（depth 变大）用 slide-left', async () => {
    await router.push('/legal/compliance');
    await settle();

    expect(transitionName()).toBe('slide-left');
  });

  it('depth 变小一律 slide-right（返回键 / 边缘手势的退场就是这一条）', async () => {
    await router.push('/legal/compliance');
    await settle();
    // happy-dom 的 history.back() 不派发 popstate，这里用同样的 depth 变化来验：
    // 方向只看 depth，不看历史栈，两条路走的是同一个判断
    await router.push('/');
    await settle();

    expect(router.currentRoute.value.name).toBe('home');
    expect(transitionName()).toBe('slide-right');
  });

  it('同 depth 的 Tab 切换仍是 fade', async () => {
    await router.push('/library');
    await settle();

    expect(transitionName()).toBe('fade');
  });

  it('封面共享元素转场进行中强制 fade，页面位移不会把浮层封面带走', async () => {
    sharedCoverActive.value = true;
    await router.push('/detail/abc');
    await settle();

    expect(transitionName()).toBe('fade');
  });
});

/**
 * B-07 的开关挂在外壳上：验收要求「播放器 / 全屏内不误触发」，而判定用的是
 * `meta.immersive` + 有没有可回退的历史，两者都在 App.vue 里算。
 */
describe('边缘返回的可用范围', () => {
  function fire(type: string, x: number): void {
    const el = document.querySelector('.app-content');
    if (!el) return;
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: 400, pointerId: 1, pointerType: 'touch' });
    el.dispatchEvent(ev);
  }

  /** 左边缘起步 → 拖到 300px（happy-dom 屏宽 1024，40% 提交线在 409.6）→ 松手 */
  function edgeDrag(): void {
    fire('pointerdown', 6);
    fire('pointermove', 120);
    fire('pointermove', 300);
    fire('pointerup', 300);
  }

  function dragged(): string {
    return (document.querySelector('.app-content') as HTMLElement).style.transform;
  }

  it('二级页有上一页可回：边缘右滑跟手', async () => {
    await router.push('/legal/compliance');
    await settle();
    edgeDrag();

    expect(dragged()).toContain('translate3d');
  });

  it('播放器（meta.immersive）不接管边缘手势：横向拖动留给播放控制', async () => {
    await router.push('/player/abc/ep1');
    await settle();
    edgeDrag();

    expect(dragged()).toBe('');
  });
});
