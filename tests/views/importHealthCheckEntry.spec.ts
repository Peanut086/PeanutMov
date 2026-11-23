/**
 * P1-1：导入结果弹层里的「体检刚导入的 N 个源」
 *
 * 钉住：
 * 1. 按钮只在"这次真的写入了源"时出现，数量取 `ImportResult.sourceIds`；
 * 2. 点它只把本批 id 交给 `sourceStore.checkSources`（不是全量体检，也不新建探测实现）；
 * 3. 结果按「可用 x / 失效 y」播报并留在面板上，失效时不用成功语气；
 * 4. 检测中可取消，取消复用 `cancelHealthCheck`。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), back: vi.fn() }),
  useRoute: () => ({ query: {} }),
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => mocks.toast }));

import ImportSubscriptionView from '@/views/ImportSubscriptionView.vue';
import { healthService, type HealthSnapshot } from '@/services/healthService';
import { useImportStore } from '@/stores/importStore';
import { useSourceStore } from '@/stores/sourceStore';
import { AppError } from '@/shared/errors';
import type { ImportPreview, ImportPreviewEntry, ImportResult } from '@/types';

import { resetAll } from '../unit/helpers';

function makeEntry(key: string): ImportPreviewEntry {
  return {
    key,
    name: `源 ${key}`,
    type: 'site',
    baseUrl: `https://${key}.example.com`,
    enabled: true,
    selected: true,
    valid: true,
    duplicateOf: null,
    warning: null,
    issues: [],
    normalized: {
      name: `源 ${key}`,
      type: 'site',
      baseUrl: `https://${key}.example.com`,
      pathPrefix: null,
      auth: { mode: 'none', username: null, password: null, token: null },
      headers: {},
      ext: null,
      enabled: true,
      sort: 0,
    },
  };
}

function fakePreview(entries: ImportPreviewEntry[]): ImportPreview {
  return {
    origin: 'url',
    sourceUrl: 'https://sub.example.com/a.json',
    fileName: null,
    fetchedAt: Date.now(),
    name: '我的订阅',
    total: entries.length,
    entries,
    globalIssues: [],
    repos: [],
    lives: [],
  };
}

function makeResult(sourceIds: string[]): ImportResult {
  return { success: sourceIds.length, skipped: 0, failed: 0, sourceIds, issues: [] };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 走到"导入完成、结果面板已打开"这一步 */
async function openResultModal(
  wrapper: VueWrapper,
  result: ImportResult,
): Promise<void> {
  vi.spyOn(useImportStore(), 'commit').mockResolvedValue(result);
  useImportStore().preview = fakePreview([makeEntry('k1'), makeEntry('k2')]);
  await settle();
  const importButton = wrapper
    .findAll('button')
    .find((node) => node.text().replace(/\s+/g, '').startsWith('导入'));
  expect(importButton, '有效预览应给出导入按钮').toBeTruthy();
  expect(importButton!.attributes('disabled')).toBeUndefined();
  await importButton!.trigger('click');
  await settle();
  expect(wrapper.find('.import-result').exists(), '导入后应弹出结果面板').toBe(true);
}

function checkButton(wrapper: VueWrapper) {
  return wrapper
    .findAll('.import-result__check button')
    .find((node) => node.text().includes('体检刚导入'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
});

describe('导入后体检入口（P1-1）', () => {
  it('按钮给出本批源数，点它只体检这些 id 并播报可用/失效', async () => {
    setActivePinia(createPinia());
    const wrapper = mount(ImportSubscriptionView);
    await settle();
    const checkSources = vi
      .spyOn(useSourceStore(), 'checkSources')
      .mockResolvedValue({ aborted: false, checked: 2, ok: 1, bad: 1 });

    await openResultModal(wrapper, makeResult(['s1', 's2']));

    const button = checkButton(wrapper);
    expect(button, '写入成功必须有体检入口').toBeTruthy();
    expect(button!.text().replace(/\s+/g, ' ')).toContain('体检刚导入的 2 个源');

    await button!.trigger('click');
    await settle();

    expect(checkSources).toHaveBeenCalledTimes(1);
    expect(checkSources).toHaveBeenCalledWith(['s1', 's2']);
    expect(wrapper.get('.import-result__check-note').text().replace(/\s+/g, '')).toContain(
      '可用1·失效1（失效原因见源列表的健康徽章）',
    );
    // 有失效就不算全绿：成绩用 info 播报，不用导入那条成功语气
    expect(mocks.toast.info).toHaveBeenCalledWith('刚导入的 2 个源：可用 1，失效 1');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('全部可用走成功语气', async () => {
    setActivePinia(createPinia());
    const wrapper = mount(ImportSubscriptionView);
    await settle();
    vi.spyOn(useSourceStore(), 'checkSources').mockResolvedValue({
      aborted: false,
      checked: 2,
      ok: 2,
      bad: 0,
    });
    await openResultModal(wrapper, makeResult(['s1', 's2']));
    await checkButton(wrapper)!.trigger('click');
    await settle();

    expect(mocks.toast.success).toHaveBeenCalledWith('刚导入的 2 个源：可用 2，失效 0');
    expect(wrapper.get('.import-result__check-note').text()).not.toContain('失效原因见源列表');
  });

  it('检测中出现取消，取消复用 cancelHealthCheck 且不播报成绩', async () => {
    setActivePinia(createPinia());
    const wrapper = mount(ImportSubscriptionView);
    await settle();
    const store = useSourceStore();
    // 这一条不 mock store：`healthChecking` 只有真 store 会翻起来，界面依赖它决定取消按钮显隐
    const check = vi
      .spyOn(healthService, 'check')
      .mockImplementation(
        (_ids, signal) =>
          new Promise<HealthSnapshot>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new AppError('E_ABORTED')));
          }),
      );

    await openResultModal(wrapper, makeResult(['s1', 's2']));
    await checkButton(wrapper)!.trigger('click');
    await settle();

    expect(check.mock.calls[0]?.[0]).toEqual(['s1', 's2']);
    const cancelButton = wrapper
      .findAll('.import-result__check button')
      .find((node) => node.text().replace(/\s+/g, '') === '取消');
    expect(cancelButton, '检测中要能取消').toBeTruthy();
    await cancelButton!.trigger('click');
    await settle();

    expect(mocks.toast.info).toHaveBeenCalledWith('已取消检测，已检测的部分结果可在源列表看到');
    expect(wrapper.find('.import-result__check-note').exists(), '取消后不该留一行成绩').toBe(false);
    expect(store.healthChecking).toBe(false);
    expect(store.error).toBeNull();
  });

  it('没有写入任何源时不给体检入口', async () => {
    setActivePinia(createPinia());
    const wrapper = mount(ImportSubscriptionView);
    await settle();
    vi.spyOn(useSourceStore(), 'checkSources').mockResolvedValue({
      aborted: false,
      checked: 0,
      ok: 0,
      bad: 0,
    });
    await openResultModal(
      wrapper,
      { success: 0, skipped: 2, failed: 0, sourceIds: [], issues: [] },
    );

    expect(checkButton(wrapper)).toBeUndefined();
    expect(wrapper.find('.import-result__check').exists()).toBe(false);
  });
});
