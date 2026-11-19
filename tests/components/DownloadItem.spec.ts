import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { DownloadTask } from '@/types';
import { burstSparks } from '@/services/sparkField';
import DownloadItem from '@/components/download/DownloadItem.vue';

vi.mock('@/services/sparkField', () => ({
  burstSparks: vi.fn(() => 16),
}));

const burstMock = vi.mocked(burstSparks);

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

  // P3-1：真机上下载页没有任何优先级入口（priority 创建时写成 now = 纯 FIFO）。
  it('等待中：额外显示置顶按钮，点击 emit front，且暂停按钮仍在', async () => {
    const task = makeTask({ status: 'queued' });
    const wrapper = mount(DownloadItem, { props: { task } });
    expect(actionLabels(wrapper)).toContain('置顶，下一个空位先下这一集');
    expect(actionLabels(wrapper)).toContain('暂停下载');

    const front = wrapper
      .findAll('.download-item__action')
      .find((b) => b.attributes('aria-label') === '置顶，下一个空位先下这一集');
    await front!.trigger('click');
    expect(wrapper.emitted('front')).toHaveLength(1);
    expect(wrapper.emitted('front')?.[0]?.[0]).toMatchObject({ id: task.id });
  });

  it('非等待中的任务不出置顶按钮（改顺序对它没有意义）', () => {
    for (const status of ['downloading', 'paused', 'failed', 'completed'] as const) {
      const wrapper = mount(DownloadItem, { props: { task: makeTask({ status }) } });
      expect(actionLabels(wrapper)).not.toContain('置顶，下一个空位先下这一集');
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

describe('DownloadItem · C-11 完成收尾仪式', () => {
  const completed = () =>
    makeTask({ status: 'completed', downloadedBytes: 285 * 1024 * 1024, speedBps: 0 });

  function rect(left: number, top: number, size: number): DOMRect {
    return {
      left,
      top,
      right: left + size,
      bottom: top + size,
      x: left,
      y: top,
      width: size,
      height: size,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it('已完成：勾与「可离线观看」徽章是常驻终态（reduced-motion 下就是它自己）', () => {
    const wrapper = mount(DownloadItem, { props: { task: completed() } });
    expect(wrapper.find('.download-item__check').exists()).toBe(true);
    expect(wrapper.text()).toContain('可离线观看');
    expect(wrapper.classes()).not.toContain('download-item--celebrate');
  });

  it('未完成：不放勾，也不撒火花', () => {
    const wrapper = mount(DownloadItem, { props: { task: makeTask(), celebrate: true } });
    expect(wrapper.find('.download-item__check').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('可离线观看');
  });

  it('celebrate：加收尾 class，并从勾的圆心撒一簇共享火花', async () => {
    burstMock.mockClear();
    const wrapper = mount(DownloadItem, { props: { task: completed(), celebrate: true } });
    const check = wrapper.find('.download-item__check').element;
    check.getBoundingClientRect = () => rect(100, 200, 22);
    await wrapper.vm.$nextTick();

    expect(wrapper.classes()).toContain('download-item--celebrate');
    expect(burstMock).toHaveBeenCalledTimes(1);
    expect(burstMock).toHaveBeenCalledWith(111, 211);
  });

  it('状态从下载中翻到完成的那一刻才庆祝；批量完成时（celebrate 为假）静默变勾', async () => {
    burstMock.mockClear();
    const wrapper = mount(DownloadItem, { props: { task: makeTask(), celebrate: false } });
    expect(wrapper.find('.download-item__check').exists()).toBe(false);

    await wrapper.setProps({ task: completed(), celebrate: false });
    expect(wrapper.find('.download-item__check').exists()).toBe(true);
    expect(wrapper.classes()).not.toContain('download-item--celebrate');
    await wrapper.vm.$nextTick();
    expect(burstMock).not.toHaveBeenCalled();
  });
});

/**
 * OPT-05：转封装阶段的行内文案
 *
 * 分片写完之后还有 TS→MP4 收尾，任务状态要到 runner 整体返回才迁移为 completed，
 * 长视频这中间可以有好几分钟——进度 100% + 「下载中…」看起来就是卡死。
 */
describe('OPT-05 转封装阶段文案', () => {
  const finished = (overrides: Partial<DownloadTask> = {}) =>
    makeTask({ status: 'completed', downloadedBytes: 285 * 1024 * 1024, totalBytes: 285 * 1024 * 1024, speedBps: 0, ...overrides });

  it('分片已写完但仍在转封装：显示「转封装中」而不是一直「下载中…」', () => {
    const wrapper = mount(DownloadItem, {
      props: {
        task: makeTask({ downloadedBytes: 200 * 1024 * 1024, speedBps: 0 }),
        postprocess: { stage: 'remux', state: 'start' },
      },
    });
    expect(wrapper.find('.download-item__status').text()).toBe('转封装中…');
  });

  it('转封装上报结束后瞬态不再粘在行上', () => {
    const wrapper = mount(DownloadItem, {
      props: { task: makeTask({ speedBps: 2 * 1024 * 1024 }), postprocess: { stage: 'remux', state: 'done' } },
    });
    expect(wrapper.find('.download-item__status').text()).toContain('剩余');

    const idle = mount(DownloadItem, {
      props: { task: makeTask({ speedBps: 0 }), postprocess: { stage: 'remux', state: 'skipped' } },
    });
    expect(idle.find('.download-item__status').text()).toBe('下载中…');
  });

  it('失败落库后：完成文案点明文件仍是 TS', () => {
    const wrapper = mount(DownloadItem, {
      props: { task: finished({ remux: { status: 'failed', reason: 'E_FFMPEG_EXIT' } }) },
    });
    expect(wrapper.find('.download-item__status').text()).toContain('转封装失败，仍为 TS');

    const done = mount(DownloadItem, { props: { task: finished({ remux: { status: 'done', durationMs: 900 } }) } });
    expect(done.find('.download-item__status').text()).not.toContain('转封装');
  });
});
