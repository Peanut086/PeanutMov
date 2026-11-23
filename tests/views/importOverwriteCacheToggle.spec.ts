/**
 * P1-3：「覆盖时清理该源缓存」开关
 *
 * 钉住：
 * 1. 开关只在同名策略为「覆盖」时出现（其它策略不涉及清缓存）；
 * 2. 默认开启 = FR-04 现行为，用户不碰就跟改动前完全一致；
 * 3. 取值如实传给 `importer.commit` 的 `clearCache`；
 * 4. 关掉后仍照常提交（只是不清缓存），不引入额外确认。
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
import { useImportStore } from '@/stores/importStore';
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

const PREVIEW: ImportPreview = {
  origin: 'url',
  sourceUrl: 'https://sub.example.com/a.json',
  fileName: null,
  fetchedAt: Date.now(),
  name: '我的订阅',
  total: 2,
  entries: [makeEntry('k1'), makeEntry('k2')],
  globalIssues: [],
  repos: [],
  lives: [],
};

const RESULT: ImportResult = { success: 2, skipped: 0, failed: 0, sourceIds: ['s1', 's2'], issues: [] };

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountView(): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const wrapper = mount(ImportSubscriptionView);
  useImportStore().preview = PREVIEW;
  await settle();
  return wrapper;
}

function strategyButton(wrapper: VueWrapper, label: string) {
  const node = wrapper.findAll('.segmented__item').find((item) => item.text().trim() === label);
  expect(node, `同名策略应有「${label}」选项`).toBeTruthy();
  return node!;
}

function cacheRow(wrapper: VueWrapper) {
  return wrapper.find('.import-strategy__cache');
}

function cacheSwitch(wrapper: VueWrapper) {
  return cacheRow(wrapper).find('button[role="switch"]');
}

async function clickImport(wrapper: VueWrapper): Promise<void> {
  const button = wrapper.findAll('button').find((node) => node.text().replace(/\s+/g, '').startsWith('导入'));
  expect(button, '有效预览应给出导入按钮').toBeTruthy();
  await button!.trigger('click');
  await settle();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
});

describe('覆盖时清理该源缓存开关（P1-3）', () => {
  it('默认策略「跳过」不涉及清缓存：开关不出现', async () => {
    const wrapper = await mountView();
    vi.spyOn(useImportStore(), 'commit').mockResolvedValue(RESULT);

    expect(strategyButton(wrapper, '跳过').attributes('aria-checked')).toBe('true');
    expect(cacheRow(wrapper).exists()).toBe(false);

    await clickImport(wrapper);
    const options = vi.mocked(useImportStore().commit).mock.calls[0]?.[0];
    expect(options).toMatchObject({ onDuplicate: 'skip' });
    expect(options?.clearCache).toBe(true); // 传默认值，行为与改动前一致
  });

  it('选「覆盖」出现开关，默认开启并如实传给 commit', async () => {
    const wrapper = await mountView();
    vi.spyOn(useImportStore(), 'commit').mockResolvedValue(RESULT);

    await strategyButton(wrapper, '覆盖').trigger('click');
    await settle();

    const row = cacheRow(wrapper);
    expect(row.exists(), '覆盖策略应给出清缓存开关').toBe(true);
    expect(row.text().replace(/\s+/g, ' ')).toContain('覆盖时清理该源缓存');
    expect(row.text().replace(/\s+/g, ' ')).toContain('新增的条目要等下次浏览才入库');
    const switchNode = cacheSwitch(wrapper);
    expect(switchNode.attributes('aria-checked'), '默认保持 FR-04：开启').toBe('true');

    await clickImport(wrapper);
    expect(vi.mocked(useImportStore().commit).mock.calls[0]?.[0]).toMatchObject({
      onDuplicate: 'overwrite',
      clearCache: true,
    });
  });

  it('关掉开关后照常导入，只把 clearCache=false 传下去', async () => {
    const wrapper = await mountView();
    vi.spyOn(useImportStore(), 'commit').mockResolvedValue(RESULT);

    await strategyButton(wrapper, '覆盖').trigger('click');
    await settle();
    await cacheSwitch(wrapper).trigger('click');
    await settle();

    expect(cacheSwitch(wrapper).attributes('aria-checked')).toBe('false');
    await clickImport(wrapper);
    expect(vi.mocked(useImportStore().commit).mock.calls[0]?.[0]).toMatchObject({
      onDuplicate: 'overwrite',
      clearCache: false,
    });
    expect(wrapper.find('.import-result').exists(), '关闭清缓存不影响导入结果面板').toBe(true);
  });

  it('从「覆盖」切到「保留两份」：开关收起，不再暴露无关选项', async () => {
    const wrapper = await mountView();
    vi.spyOn(useImportStore(), 'commit').mockResolvedValue(RESULT);

    await strategyButton(wrapper, '覆盖').trigger('click');
    await settle();
    expect(cacheRow(wrapper).exists()).toBe(true);

    await strategyButton(wrapper, '保留两份').trigger('click');
    await settle();
    expect(cacheRow(wrapper).exists()).toBe(false);

    await clickImport(wrapper);
    expect(vi.mocked(useImportStore().commit).mock.calls[0]?.[0]).toMatchObject({ onDuplicate: 'keep-both' });
  });
});
