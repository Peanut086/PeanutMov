import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { DownloadTask } from '@/types';
import DownloadItem from '@/components/download/DownloadItem.vue';

/**
 * DownloadItem 测试（页面蓝图 §7 / AC-69、AC-70、AC-73、AC-79）
 *
 * - 状态 → 操作按钮映射（下载中=暂停，已暂停=继续，失败=重试，完成=播放）
 * - 进度 与 体积/速度文案
 * - 删除按钮始终存在并 emit remove
 */
function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    sourceId: 'mock',
    mediaId: 'mock:demo-101~x',
    episodeId: 'ep-3',
    episodeNumber: 3,
    title: '示例剧集：四季',
    episodeTitle: '第 3 集',
    posterUrl: null,
    url: 'https://example.test/v.mp4',
    headers: {},
    format: 'mp4',
    quality: '720p',
    status: 'downloading',
    priority: 1,
    totalBytes: 200 * 1024 * 1024,
    downloadedBytes: 90 * 1024 * 1024,
    speedBps: 2 * 1024 * 1024,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

function actionLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper
    .findAll('.download-item__action')
    .map((b) => b.attributes('aria-label') ?? '');
}

describe('DownloadItem', () => {
  it('下载中：显示暂停按钮与进度条，进度属于 0~100', () => {
    const wrapper = mount(DownloadItem, { props: { task: makeTask() } });
    expect(actionLabels(wrapper)).toContain('暂停下载');

    const bar = wrapper.find('[role="progressbar"]');
    expect(bar.exists()).toBe(true);
    expect(bar.attributes('aria-valuenow')).toBe('45');
    expect(wrapper.text()).toContain('示例剧集：四季');
    expect(wrapper.text()).toContain('第 3 集');
  });

  it('已暂停：显示继续按钮，状态文案含「已暂停」', async () => {
    const task = makeTask({ status: 'paused', speedBps: 0 });
    const wrapper = mount(DownloadItem, { props: { task } });
    expect(actionLabels(wrapper)).toContain('继续下载');
    expect(wrapper.text()).toContain('已暂停');

    const resume = wrapper.findAll('.download-item__action').find((b) => b.attributes('aria-label') === '继续下载');
    await resume!.trigger('click');
    expect(wrapper.emitted('resume')?.[0]?.[0]).toMatchObject({ id: task.id });
  });

  it('失败：显示重试按钮与错误文案', async () => {
    const task = makeTask({ status: 'failed', errorMessage: '网络不可用，请检查网络后重试', speedBps: 0 });
    const wrapper = mount(DownloadItem, { props: { task } });
    expect(actionLabels(wrapper)).toContain('重试下载');
    expect(wrapper.text()).toContain('网络不可用，请检查网络后重试');

    const retry = wrapper.findAll('.download-item__action').find((b) => b.attributes('aria-label') === '重试下载');
    await retry!.trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('已完成：显示播放按钮、100% 与「可离线观看」', async () => {
    const task = makeTask({ status: 'completed', downloadedBytes: 285 * 1024 * 1024, speedBps: 0 });
    const wrapper = mount(DownloadItem, { props: { task } });
    expect(actionLabels(wrapper)).toContain('播放已下载内容');
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('100');
    expect(wrapper.text()).toContain('可离线观看');

    const play = wrapper.findAll('.download-item__action').find((b) => b.attributes('aria-label') === '播放已下载内容');
    await play!.trigger('click');
    expect(wrapper.emitted('play')).toHaveLength(1);
  });

  it('删除按钮在任意状态下存在，并 emit remove（AC-79）', async () => {
    for (const status of ['downloading', 'paused', 'failed', 'completed'] as const) {
      const wrapper = mount(DownloadItem, { props: { task: makeTask({ status }) } });
      const remove = wrapper.findAll('.download-item__action').find((b) => b.attributes('aria-label') === '删除下载');
      expect(remove, `status=${status}`).toBeTruthy();
      await remove!.trigger('click');
      expect(wrapper.emitted('remove')).toHaveLength(1);
    }
  });

  it('离线时暂停任务文案标注「等待网络」（AC-77 的 UI 提示）', () => {
    const wrapper = mount(DownloadItem, {
      props: { task: makeTask({ status: 'paused' }), offline: true },
    });
    expect(wrapper.text()).toContain('等待网络');
  });

  it('点击主体 emit select（非完成任务打开详情）', async () => {
    const wrapper = mount(DownloadItem, { props: { task: makeTask({ status: 'paused' }) } });
    await wrapper.find('.download-item__main').trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
  });
});
