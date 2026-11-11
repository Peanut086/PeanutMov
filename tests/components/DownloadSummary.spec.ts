import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { DownloadSummary } from '@/types';
import DownloadSummaryCard from '@/components/download/DownloadSummary.vue';

/**
 * C-11：批量完成时的庆祝只发生在汇总卡上
 *
 * 组件本身只负责"有 celebrate 就挂 class"，判定在 useCompletionCeremony；
 * 这里锁住契约的两端：不庆祝时必须是干净的常态。
 */
function summary(overrides: Partial<DownloadSummary> = {}): DownloadSummary {
  return {
    total: 3,
    downloading: 0,
    queued: 0,
    paused: 0,
    completed: 3,
    failed: 0,
    totalBytes: 300 * 1024 * 1024,
    downloadedBytes: 300 * 1024 * 1024,
    ...overrides,
  };
}

describe('DownloadSummary · 批量完成庆祝', () => {
  it('celebrate 为真时挂上一次性庆祝 class', () => {
    const wrapper = mount(DownloadSummaryCard, { props: { summary: summary(), celebrate: true } });
    expect(wrapper.classes()).toContain('download-summary--celebrate');
  });

  it('默认不庆祝，且已完成 3 项的文案照常汇总', () => {
    const wrapper = mount(DownloadSummaryCard, { props: { summary: summary() } });
    expect(wrapper.classes()).not.toContain('download-summary--celebrate');
    expect(wrapper.text()).toContain('共 3 个任务');
    expect(wrapper.text()).toContain('已完成 3');
  });

  it('celebrate 撤下后回到常态（收尾动画不常驻）', async () => {
    const wrapper = mount(DownloadSummaryCard, { props: { summary: summary(), celebrate: true } });
    await wrapper.setProps({ celebrate: false });
    expect(wrapper.classes()).not.toContain('download-summary--celebrate');
  });
});
