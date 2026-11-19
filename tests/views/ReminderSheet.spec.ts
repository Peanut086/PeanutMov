import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ReminderSheet from '@/components/live/ReminderSheet.vue';
import type { ReminderDeliveryView } from '@/services/reminderService';
import type { Reminder } from '@/types';

/**
 * P2-2：提醒弹层的投递披露
 *
 * 弹层只渲染服务层算好的一行话（`describeReminderDelivery` 的产物），
 * 这里锁住的是界面契约：退化要说清、有缺口才给入口、探不到就别瞎说。
 */

const HOUR = 3_600_000;

function reminderOf(over: Partial<Reminder> = {}): Reminder {
  const startAt = Date.now() + HOUR;
  return {
    id: 'r_test',
    liveSourceId: 'live-a',
    epgSourceId: null,
    channelKey: 'id:cctv1',
    channelName: 'CCTV-1 综合',
    programmeKey: 'p1',
    programmeTitle: '新闻联播',
    startAt,
    endAt: startAt + HOUR,
    leadMinutes: 5,
    notifyAt: startAt - 300_000,
    state: 'scheduled',
    nativeId: 100,
    lastError: null,
    createdAt: startAt,
    updatedAt: startAt,
    ...over,
  };
}

function view(over: Partial<ReminderDeliveryView> = {}): ReminderDeliveryView {
  return {
    tier: 'delayed',
    text: '可能被系统延迟：未授权精确闹钟，待机或省电模式下可能延后触发',
    settingsTarget: 'exactAlarm',
    settingsLabel: '授权精确闹钟',
    ...over,
  };
}

function mountSheet(props: {
  reminder?: Reminder | null;
  deliveryView?: ReminderDeliveryView | null;
  startAt?: number;
  notice?: string | null;
}) {
  return mount(ReminderSheet, {
    props: {
      modelValue: true,
      title: '新闻联播',
      startAt: props.startAt ?? Date.now() + HOUR,
      reminder: props.reminder === undefined ? null : props.reminder,
      saving: false,
      notice: props.notice ?? null,
      deliveryView: props.deliveryView === undefined ? null : props.deliveryView,
    },
    global: {
      stubs: {
        BottomSheet: { template: '<div><slot /></div>' },
        LoadingSpinner: true,
      },
    },
  });
}

describe('ReminderSheet 投递档位披露（P2-2）', () => {
  it('可能被延迟：显示原因并给出对症的系统入口', async () => {
    const wrapper = mountSheet({ deliveryView: view() });
    const line = wrapper.get('[data-test="reminder-delivery"]');
    expect(line.text()).toContain('未授权精确闹钟');
    expect(line.classes()).toContain('reminder__delivery-text--delayed');

    const button = wrapper.get('[data-test="reminder-settings"]');
    expect(button.text()).toBe('授权精确闹钟');
    await button.trigger('click');
    expect(wrapper.emitted('open-settings')?.[0]).toEqual(['exactAlarm']);
  });

  it('可准时：只报档位，不给任何设置入口', () => {
    const wrapper = mountSheet({
      deliveryView: view({ tier: 'exact', text: '可准时提醒', settingsTarget: null, settingsLabel: null }),
    });
    expect(wrapper.get('[data-test="reminder-delivery"]').text()).toBe('可准时提醒');
    expect(wrapper.find('[data-test="reminder-settings"]').exists()).toBe(false);
  });

  it('仅 App 内提醒用告警色，台账口径没有可点的入口', () => {
    const wrapper = mountSheet({
      deliveryView: view({
        tier: 'in-app',
        text: '仅 App 内提醒：通知权限未授予，仅 App 内提醒（上次排期结果）',
        settingsTarget: null,
        settingsLabel: null,
      }),
    });
    expect(wrapper.get('[data-test="reminder-delivery"]').classes()).toContain(
      'reminder__delivery-text--in-app',
    );
    expect(wrapper.find('[data-test="reminder-settings"]').exists()).toBe(false);
  });

  it('探不到档位时退回通用说明，不编造档位', () => {
    const wrapper = mountSheet({ reminder: reminderOf(), deliveryView: null });
    expect(wrapper.find('[data-test="reminder-delivery"]').exists()).toBe(false);
    expect(wrapper.find('.reminder__hint').exists()).toBe(true);
  });

  it('节目已开播（不能再改提前量）仍显示档位说明', () => {
    const wrapper = mountSheet({
      startAt: Date.now() - HOUR,
      reminder: reminderOf({ startAt: Date.now() - HOUR, state: 'missed' }),
      deliveryView: view({ tier: 'exact', text: '可准时提醒', settingsLabel: null, settingsTarget: null }),
    });
    expect(wrapper.find('.reminder__blocked').exists()).toBe(true);
    expect(wrapper.get('[data-test="reminder-delivery"]').text()).toBe('可准时提醒');
  });
});
