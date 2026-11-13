/**
 * 删除分组的二次确认门（P3-19）
 *
 * `removeGroup` 顺带把组内频道的归属清掉：频道本身还在源分组里，但用户手工整理的
 * 分组结构一次误点就没了，而重建只能一个个「重新分配到组」——没有撤销路径。
 * 所以入口必须先过 `ui.confirm`，取消时既不能写库也不能广播 changed。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
  removeGroup: vi.fn(async () => undefined),
}));

vi.mock('@/services/channelPrefsService', () => ({
  channelPrefsService: {
    removeGroup: prefsMocks.removeGroup,
    countOrphans: vi.fn(async () => 0),
    prune: vi.fn(async () => ({ removedOrders: 0, removedAssignments: 0 })),
    createGroup: vi.fn(async () => undefined),
    renameGroup: vi.fn(async () => undefined),
    reorderGroups: vi.fn(async () => undefined),
    assign: vi.fn(async () => undefined),
  },
}));

import ChannelGroupSheet from '@/components/live/ChannelGroupSheet.vue';
import { useUiStore } from '@/stores/uiStore';
import type { ChannelPrefs } from '@/types';

const PREFS: ChannelPrefs = {
  liveSourceId: 'live-1',
  groups: [
    { id: 'g-1', name: '我的收藏组', order: 0, createdAt: 1 },
    { id: 'g-2', name: '体育', order: 1, createdAt: 1 },
  ],
  assignments: { 'id:cctv1': 'g-1', 'id:hunan': 'g-1' },
  orders: {},
  updatedAt: 1,
};

function mountSheet(): VueWrapper {
  return mount(ChannelGroupSheet, {
    props: {
      modelValue: true,
      liveSourceId: 'live-1',
      prefs: PREFS,
      channelKey: 'id:cctv1',
      channelName: 'CCTV-1 综合',
      channelKeys: ['id:cctv1', 'id:hunan'],
    },
    global: {
      stubs: {
        BottomSheet: {
          props: ['modelValue', 'title'],
          template: '<div class="sheet-stub"><slot /></div>',
        },
        LoadingSpinner: true,
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  prefsMocks.removeGroup.mockClear();
});

describe('ChannelGroupSheet 删除分组', () => {
  it('点「删除」先弹确认，而不是直接写库', async () => {
    const wrapper = mountSheet();
    const ui = useUiStore();
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(false);

    await wrapper.findAll('.groups__danger')[0]!.trigger('click');
    await wrapper.vm.$nextTick();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(prefsMocks.removeGroup).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('确认文案说清「频道不删、只退回源分组」，并带上组内数量', async () => {
    const wrapper = mountSheet();
    const ui = useUiStore();
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(false);

    await wrapper.findAll('.groups__danger')[0]!.trigger('click');

    const options = confirm.mock.calls[0]![0];
    expect(options.title).toContain('我的收藏组');
    expect(options.message).toContain('2 个频道');
    expect(options.message).toContain('退回源分组');
    expect(options.confirmText).toBe('删除');
    expect(options.danger).toBe(true);
    wrapper.unmount();
  });

  it('空分组的文案不谎报数量', async () => {
    const wrapper = mount(ChannelGroupSheet, {
      props: {
        modelValue: true,
        liveSourceId: 'live-1',
        prefs: { ...PREFS, assignments: {} },
        channelKey: 'id:cctv1',
        channelName: 'CCTV-1 综合',
        channelKeys: ['id:cctv1'],
      },
      global: {
        stubs: {
          BottomSheet: { props: ['modelValue', 'title'], template: '<div><slot /></div>' },
          LoadingSpinner: true,
        },
      },
    });
    const ui = useUiStore();
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(false);

    await wrapper.findAll('.groups__danger')[1]!.trigger('click');

    expect(confirm.mock.calls[0]![0].message).toContain('还没有频道');
    wrapper.unmount();
  });

  it('取消确认：分组仍在、也不广播 changed（列表不会自己刷新）', async () => {
    const wrapper = mountSheet();
    const ui = useUiStore();
    vi.spyOn(ui, 'confirm').mockResolvedValue(false);

    await wrapper.findAll('.groups__danger')[0]!.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('changed')).toBeUndefined();
    wrapper.unmount();
  });

  it('确认才删：写入一次并广播 changed', async () => {
    const wrapper = mountSheet();
    const ui = useUiStore();
    vi.spyOn(ui, 'confirm').mockResolvedValue(true);

    await wrapper.findAll('.groups__danger')[0]!.trigger('click');
    await wrapper.vm.$nextTick();

    expect(prefsMocks.removeGroup).toHaveBeenCalledTimes(1);
    expect(prefsMocks.removeGroup).toHaveBeenCalledWith('live-1', 'g-1');
    expect(wrapper.emitted('changed')).toBeTruthy();
    wrapper.unmount();
  });
});
