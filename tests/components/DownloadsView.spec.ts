import { flushPromises, shallowMount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DownloadTask } from '@/types';
import DownloadsView from '@/views/DownloadsView.vue';

const h = vi.hoisted(() => ({
  tasks: [] as DownloadTask[],
  removeMany: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/stores/downloadStore', () => ({
  useDownloadStore: () => ({
    state: 'ready',
    tasks: h.tasks,
    summary: {},
    error: null,
    postprocess: {},
    load: vi.fn().mockResolvedValue(undefined),
    calculateStorageUsage: vi.fn().mockResolvedValue({ totalBytes: 0, fileCount: 0, partialBytes: 0 }),
    removeMany: h.removeMany,
    remove: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    clearFailed: vi.fn(),
    clearCompleted: vi.fn(),
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/stores/uiStore', () => ({
  useUiStore: () => ({ confirm: h.confirm }),
}));

vi.mock('@/composables/useOnlineStatus', () => ({
  useOnlineStatus: () => ({ isOffline: false }),
}));

vi.mock('@/composables/useHaptic', () => ({
  useHaptic: () => ({ haptic: vi.fn() }),
}));

vi.mock('@/composables/useCompletionCeremony', () => ({
  useCompletionCeremony: () => ({
    celebrateId: null,
    celebrateSummary: false,
    observe: vi.fn(() => ({ fresh: [] })),
  }),
}));

vi.mock('@/composables/useDebounce', () => ({
  useDebounce: (fn: () => void) => Object.assign(fn, { flush: vi.fn(), cancel: vi.fn() }),
}));

vi.mock('@/services/sparkField', () => ({ attachSparkCanvas: vi.fn() }));
vi.mock('@/services/events', () => ({ appEvents: { on: vi.fn(() => vi.fn()) } }));
vi.mock('@/services/offlineRemuxMigration', () => ({
  getOfflineOptimizeState: () => ({ active: false, done: 0, total: 0, percent: 0 }),
}));
vi.mock('@/services/downloadService', () => ({
  downloadService: {
    getSpeedLimit: () => ({ limit: 'unlimited' }),
    getCurrentSpeed: () => ({ totalBps: 0 }),
    bringToFront: vi.fn(),
    retryBatch: vi.fn(),
  },
}));

const NOW = 1_700_000_000_000;

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '士兵突击',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.ts',
    headers: {},
    format: 'hls',
    quality: null,
    status: 'completed',
    priority: NOW,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'filesystem',
    filePath: 'downloads/task-1.ts',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function mountView() {
  return shallowMount(DownloadsView, {
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        SafeArea: { template: '<div><slot /></div>' },
        PullToRefresh: { template: '<div><slot /></div>' },
        EmptyState: {
          props: ['title'],
          template: '<div class="empty-stub">{{ title }}</div>',
        },
        DownloadItem: {
          props: ['task'],
          template: '<div class="download-item" :data-task-id="task.id">{{ task.title }} 第 {{ task.episodeNumber }} 集</div>',
        },
        DownloadBatchGroup: { template: '<div class="batch-stub" />' },
        SegmentedControl: {
          props: ['modelValue', 'options'],
          emits: ['update:modelValue'],
          template: `<div class="filter-stub">
            <button
              v-for="option in options"
              :key="option.value"
              type="button"
              :data-filter="option.value"
              @click="$emit('update:modelValue', option.value)"
            >
              {{ option.label }}
            </button>
          </div>`,
        },
      },
    },
  });
}

function renderedTaskIds(wrapper: ReturnType<typeof mountView>, selector: string): string[] {
  return wrapper.findAll(selector).map((row) => row.attributes('data-task-id') ?? '');
}

describe('DownloadsView 展示排序', () => {
  beforeEach(() => {
    h.tasks = [];
    h.removeMany.mockReset().mockResolvedValue({ removed: 0, filesLeftBehind: 0, failed: 0 });
    h.confirm.mockReset().mockResolvedValue(true);
  });

  it('全部页先展示剩余队列，再跨批次展示已完成媒体库', async () => {
    h.tasks = [
      task({ id: 'e16', episodeNumber: 16, batchId: 'batch-new', priority: 3 }),
      task({ id: 'active', episodeNumber: 8, status: 'downloading', priority: 1 }),
      task({ id: 'e2', episodeNumber: 2, batchId: 'batch-old', priority: 4 }),
      task({ id: 'e10', episodeNumber: 10, batchId: 'batch-old', priority: 5 }),
    ];
    const wrapper = mountView();
    await flushPromises();

    expect(renderedTaskIds(wrapper, '.batch-group .download-item')).toEqual(['active']);
    expect(renderedTaskIds(wrapper, '.completed-media .download-item')).toEqual(['e2', 'e10', 'e16']);
    expect(wrapper.findAll('.completed-media')).toHaveLength(1);
  });

  it('下载中筛选只展示当前队列，不混入已完成媒体', async () => {
    h.tasks = [
      task({ id: 'active', status: 'downloading', priority: 2 }),
      task({ id: 'paused', status: 'paused', priority: 1 }),
      task({ id: 'done', episodeNumber: 2 }),
    ];
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-filter="active"]').trigger('click');
    await flushPromises();

    expect(renderedTaskIds(wrapper, '.downloads-batches .download-item')).toEqual(['paused', 'active']);
    expect(wrapper.findAll('.completed-media')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('该状态下没有任务');
  });

  it('失败筛选为空时显示空状态，不残留已完成媒体', async () => {
    h.tasks = [task({ id: 'done' })];
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-filter="failed"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('.downloads-batches').exists()).toBe(false);
    expect(wrapper.findAll('.completed-media')).toHaveLength(0);
    expect(wrapper.text()).toContain('该状态下没有任务');

    await wrapper.find('[data-filter="completed"]').trigger('click');
    await flushPromises();

    expect(renderedTaskIds(wrapper, '.completed-media .download-item')).toEqual(['done']);
    expect(wrapper.text()).not.toContain('该状态下没有任务');
  });

  it('删除本剧已完成时只传该媒体的任务 ID', async () => {
    h.tasks = [
      task({ id: 'a1', mediaId: 'demo:a', episodeNumber: 1 }),
      task({ id: 'b1', mediaId: 'demo:b', title: '绝命毒师', episodeNumber: 1 }),
    ];
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('.completed-media__head button').trigger('click');
    await flushPromises();

    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(h.removeMany).toHaveBeenCalledWith(['b1'], true);
  });
});
