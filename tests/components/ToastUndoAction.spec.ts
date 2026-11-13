import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ToastHost from '@/components/common/ToastHost.vue';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';

/**
 * 撤销入口可聚焦（P3-18）
 *
 * 撤销原本是套在「整条 toast 都是 button」里的一个 `<span @click>`：手指点得动，
 * 键盘 / 读屏够不着——嵌套交互控件本身也不合法。现在容器退回 div，撤销才是真按钮。
 */

let ui: ReturnType<typeof useUiStore>;
let wrapper: VueWrapper | null = null;

function render(): VueWrapper {
  // attachTo 才有 document.activeElement：挂在游离节点上 focus() 是空操作
  const w = mount(ToastHost, { attachTo: document.body });
  wrapper = w;
  return w;
}

function pushActionToast(onClick = vi.fn()): void {
  useToast().action('已取消收藏', { label: '撤销', onClick }, 'success');
}

beforeEach(() => {
  setActivePinia(createPinia());
  ui = useUiStore();
  wrapper = null;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  ui.reset();
});

describe('ToastHost 撤销按钮', () => {
  it('撤销是真按钮：能拿到焦点，键盘回车即触发', async () => {
    const onClick = vi.fn();
    const w = render();
    pushActionToast(onClick);
    await w.vm.$nextTick();

    const action = w.get('button.toast__action');
    (action.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(action.element);
    expect(action.attributes('type')).toBe('button');

    await action.trigger('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ui.toasts).toHaveLength(0);
  });

  it('不再嵌套交互控件：toast 容器不是 button，里面只有一个 button', async () => {
    const w = render();
    pushActionToast();
    await w.vm.$nextTick();

    expect(w.find('button.toast').exists()).toBe(false);
    expect(w.findAll('button button')).toHaveLength(0);
    expect(w.findAll('.toast button')).toHaveLength(1);
  });

  it('点空白处仍是关闭：不会顺手触发撤销', async () => {
    const onClick = vi.fn();
    const w = render();
    pushActionToast(onClick);
    await w.vm.$nextTick();

    await w.get('.toast__text').trigger('click');

    expect(onClick).not.toHaveBeenCalled();
    expect(ui.toasts).toHaveLength(0);
  });

  it('没有 action 的 toast 里不该凭空长出一个按钮', async () => {
    const w = render();
    useToast().success('已保存');
    await w.vm.$nextTick();

    expect(w.findAll('button')).toHaveLength(0);
    expect(w.get('.toast').element.tagName).toBe('DIV');
  });
});
