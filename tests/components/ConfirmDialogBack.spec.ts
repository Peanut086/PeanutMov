import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import BottomSheet from '@/components/common/BottomSheet.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import { pressBackButton, setBackFallback } from '@/native/appLifecycle';
import { useUiStore } from '@/stores/uiStore';

/**
 * 确认对话框接返回键总线（P3-17）
 *
 * 对话框原本只有 Esc 与按钮：Android 上按物理返回键，对话框还挂着，页面却已经退了一层。
 * 这里验三件事——返回键等价于「取消」（promise 收到 false）、关闭后总线交回路由、
 * 以及与弹层叠在一起时按一次只退一层。
 */

let ui: ReturnType<typeof useUiStore>;
const mounted: Array<{ unmount: () => void }> = [];

function mountDialog(): VueWrapper {
  const wrapper = mount(ConfirmDialog, { global: { stubs: { Teleport: true } } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  ui = useUiStore();
});

afterEach(() => {
  for (const wrapper of mounted.reverse()) wrapper.unmount();
  mounted.length = 0;
  setBackFallback(null);
  ui.reset();
});

describe('ConfirmDialog 返回键总线', () => {
  it('返回键等同取消：promise 收到 false，对话框关闭', async () => {
    mountDialog();
    const pending = ui.confirm({ title: '删除该收藏？' });
    await nextTick();

    expect(pressBackButton()).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(ui.confirmState).toBeNull();
  });

  it('关闭后摘掉监听：返回键交回路由兜底', async () => {
    mountDialog();
    const pending = ui.confirm({ title: '清空全部数据？' });
    await nextTick();
    ui.resolveConfirm(false);
    await pending;

    const fallback = vi.fn(() => true);
    setBackFallback(fallback);
    expect(pressBackButton()).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('连续两次确认：只退当前这一层，Promise 各归各', async () => {
    mountDialog();
    const first = ui.confirm({ title: '第一次' });
    await nextTick();
    // 第一个还没答就再问：ui.confirm 会先把上一个按「取消」结掉
    const second = ui.confirm({ title: '第二次' });
    await nextTick();

    await expect(first).resolves.toBe(false);
    expect(pressBackButton()).toBe(true);
    await expect(second).resolves.toBe(false);
    expect(pressBackButton()).toBe(false);
  });

  it('弹层上再开对话框：返回键逐层退，不会一次穿回页面', async () => {
    const sheet = mount(BottomSheet, {
      props: { modelValue: false, title: '选集' },
      global: { stubs: { Teleport: true } },
    });
    mounted.push(sheet);
    await sheet.setProps({ modelValue: true });
    mountDialog();
    const pending = ui.confirm({ title: '删除已选分集？' });
    await nextTick();

    expect(pressBackButton()).toBe(true);
    await expect(pending).resolves.toBe(false);
    // 对话框退掉，弹层还在：再按一次才轮到它
    expect(sheet.emitted('update:modelValue')).toBeUndefined();
    expect(pressBackButton()).toBe(true);
    expect(sheet.emitted('update:modelValue')?.[0]).toEqual([false]);
  });
});
