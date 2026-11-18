import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { DownloadSummary } from '@/types';
import DownloadSummaryCard from '@/components/download/DownloadSummary.vue';
import { formatBytes } from '@/components/common/format';

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
    progress: 1,
    unknownSizeTasks: 0,
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

/**
 * P2-1 / P2-2（真机实测）：批次进度的口径。
 *
 * 旧实现把进度算成 `downloadedBytes / totalBytes`，而分母只累加**已经拿到体积**的任务：
 * 13 集批次刚开始 6s 时是「2 完成 + 2 在跑 + 9 没开始」，分子分母都由那两项已知体积
 * 撑起，头部显示 100%；断网后再次出现 4.2 MB / 4.2 MB / 100% 而实际 5 完成 3 失败。
 * 现在进度按任务加权，分母还在估的时候要么标「约」、要么在体积未知时干脆不给分母。
 */
describe('DownloadSummary · 批次进度口径（P2-1/P2-2）', () => {
  it('13 集只完成 2 集：显示按任务加权的 23%，不再报 100%，也不给估出来的分母', () => {
    const wrapper = mount(DownloadSummaryCard, {
      props: {
        summary: summary({
          total: 13,
          downloading: 2,
          queued: 9,
          completed: 2,
          totalBytes: 1_763_440,
          downloadedBytes: 1_763_440,
          progress: 3 / 13,
          unknownSizeTasks: 9,
        }),
      },
    });

    expect(wrapper.text()).toContain('23%');
    expect(wrapper.text()).not.toContain('100%');
    expect(wrapper.get('.download-summary__bar').attributes('aria-valuenow')).toBe('23');
    // 9 项体积未知 → 分母是 2 项凑出来的，报出来读起来像"下满了"
    expect(wrapper.text()).toContain('已下载 1.7 MB');
    expect(wrapper.text()).not.toContain('1.7 MB / ');
  });

  it('体积未知的批次不给 ETA（剩余量是从一个偏小的分母减出来的）', () => {
    const wrapper = mount(DownloadSummaryCard, {
      props: {
        summary: summary({ total: 13, downloading: 2, queued: 9, completed: 2, unknownSizeTasks: 9, progress: 0.2 }),
        speedBps: 4 * 1024 * 1024,
      },
    });
    expect(wrapper.text()).not.toContain('剩余');
  });

  it('全部完成：分子分母都是落盘实际字节，不带「约」，进度 100%', () => {
    const wrapper = mount(DownloadSummaryCard, {
      props: {
        summary: summary({
          total: 13,
          completed: 13,
          totalBytes: 11_462_360,
          downloadedBytes: 11_462_360,
          progress: 1,
        }),
      },
    });

    expect(wrapper.text()).toContain('100%');
    expect(wrapper.text()).not.toContain('约');
    expect(wrapper.text()).toContain(`${formatBytes(11_462_360)} / ${formatBytes(11_462_360)}`);
  });

  it('每项体积都已知但批次未完：分母照给，前缀标「约」，有速度就给 ETA', () => {
    const wrapper = mount(DownloadSummaryCard, {
      props: {
        summary: summary({
          total: 4,
          downloading: 2,
          queued: 2,
          completed: 2,
          totalBytes: 881_720 * 4,
          downloadedBytes: 881_720 * 3,
          progress: 2.5 / 4,
          unknownSizeTasks: 0,
        }),
        speedBps: 881_720,
      },
    });

    expect(wrapper.text()).toContain(`约 ${formatBytes(881_720 * 3)} / ${formatBytes(881_720 * 4)}`);
    expect(wrapper.text()).toContain('63%');
    expect(wrapper.text()).toContain('剩余');
  });
});
