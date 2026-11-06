/**
 * 导入诊断页面 + 两个子组件单测（EXT-08）
 *
 * 文件范围限制下（仅允许 tests/views/ImportDiagnosticView.spec.ts），
 * `ImportSummary` / `FailureClassification` 的用例集中在本文件。
 *
 * 页面用例只做「装配」验证：`importService` 被整体 mock（不发网络请求），
 * 清理动作在 store 层被 spy 替换；数据来源用 `sourceRepo` 播种。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  prefetchImport: vi.fn(),
  importWithDiagnostic: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ query: {} }),
}));

vi.mock('@/services/importService', () => ({
  importService: {
    prefetchImport: serviceMocks.prefetchImport,
    importWithDiagnostic: serviceMocks.importWithDiagnostic,
  },
}));

import ImportDiagnosticView from '@/views/ImportDiagnosticView.vue';
import ImportSummary from '@/components/import/ImportSummary.vue';
import FailureClassification from '@/components/import/FailureClassification.vue';

import { sourceRepo } from '@/db/repositories/sourceRepo';
import {
  bucketFailures,
  buildFailureReport,
  buildFailureItems,
  estimateJarDownload,
  summarizeAliveSources,
  type JarProbeSummary,
} from '@/services/ImportDiagnosticService';
import type {
  ImportDiagnosticPrefetch,
  ImportDiagnosticResult,
} from '@/services/importService';
import { useSourceStore } from '@/stores/sourceStore';
import { useUiStore } from '@/stores/uiStore';
import { AppError } from '@/shared/errors';
import type { ImportPreview, ImportPreviewEntry, ImportResult, Source } from '@/types';

import { resetAll } from '../unit/helpers';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

const NOW = new Date(2026, 10, 6, 9, 30).getTime();
const SUB_URL = 'https://example.com/tvbox.json';

/* ---------- 构造器 ---------- */

function makeEntry(overrides: Partial<ImportPreviewEntry> = {}): ImportPreviewEntry {
  const key = overrides.key ?? 'entry-1';
  return {
    key,
    name: overrides.name ?? '示例源',
    type: overrides.type ?? 'spider',
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    enabled: true,
    selected: overrides.selected ?? true,
    valid: overrides.valid ?? true,
    duplicateOf: overrides.duplicateOf ?? null,
    warning: overrides.warning ?? null,
    issues: overrides.issues ?? [],
    normalized:
      overrides.normalized === undefined
        ? {
            name: overrides.name ?? '示例源',
            type: 'spider',
            baseUrl: 'https://example.com',
            key,
            ext: { kind: 'jar', jarUrl: 'https://cdn.example.com/spider.jar' },
          }
        : overrides.normalized,
  };
}

function makePreview(entries: ImportPreviewEntry[]): ImportPreview {
  return {
    origin: 'url',
    sourceUrl: SUB_URL,
    fileName: null,
    fetchedAt: NOW,
    name: '测试订阅',
    total: entries.length,
    entries,
    globalIssues: [],
    repos: [],
    lives: [],
  };
}

function makeProbe(overrides: Partial<JarProbeSummary> = {}): JarProbeSummary {
  return {
    jarUrl: 'https://cdn.example.com/spider.jar',
    verdict: 'ok',
    detail: null,
    errorCode: null,
    httpStatus: 200,
    contentLength: 2 * 1024 * 1024,
    latencyMs: 120,
    viaMirror: null,
    ...overrides,
  };
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: overrides.id ?? 'source-1',
    key: overrides.key ?? overrides.id ?? 'source-1',
    name: overrides.name ?? '源',
    type: overrides.type ?? 'spider',
    enabled: overrides.enabled ?? true,
    builtin: false,
    sort: 0,
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: overrides.ext ?? null,
    subscriptionId: overrides.subscriptionId ?? SUB_URL,
    warning: null,
    health: overrides.health ?? 'ok',
    healthCheckedAt: null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const DEAD_PROBE = makeProbe({
  jarUrl: 'https://cdn.example.com/dead.jar',
  verdict: 'dead',
  detail: 'HTTP 403',
  errorCode: 'E_HTTP_403',
  httpStatus: 403,
  contentLength: null,
});

/** 3 个条目：1 正常 / 1 jar 判死已取消勾选 / 1 缺 jar */
function makeEntries(): ImportPreviewEntry[] {
  return [
    makeEntry({ key: 'ok-source', name: '正常源' }),
    makeEntry({
      key: 'dead-source',
      name: '死 jar 源',
      baseUrl: 'https://dead.example.com',
      selected: false,
      warning: 'jar 不可达（HTTP 403），导入后无法浏览',
      normalized: {
        name: '死 jar 源',
        type: 'spider',
        baseUrl: 'https://dead.example.com',
        key: 'dead-source',
        ext: { kind: 'jar', jarUrl: DEAD_PROBE.jarUrl },
      },
    }),
    makeEntry({
      key: 'no-jar',
      name: '缺 jar 源',
      valid: false,
      normalized: null,
      issues: [{ level: 'error', code: 'PARSE_JAR', field: 'jar', message: '缺少 jar 地址' }],
    }),
  ];
}

function makePrefetch(): ImportDiagnosticPrefetch {
  const preview = makePreview(makeEntries());
  const probes = [makeProbe(), DEAD_PROBE];
  return {
    subscriptionUrl: SUB_URL,
    preview,
    probes,
    estimate: estimateJarDownload(probes),
    warnings: ['1 个 jar 不可达（如 HTTP 403），相关源已默认取消勾选'],
    startedAt: NOW - 2000,
    finishedAt: NOW,
  };
}

function makeResult(prefetch: ImportDiagnosticPrefetch = makePrefetch()): ImportDiagnosticResult {
  const importResult: ImportResult = {
    success: 1,
    skipped: 1,
    failed: 0,
    sourceIds: ['source-ok'],
    issues: [],
  };
  const alive = summarizeAliveSources([
    makeSource({ id: 'source-ok', key: 'ok-source', health: 'ok' }),
    makeSource({ id: 'source-bad', key: 'bad-source', health: 'timeout' }),
  ]);
  const failures = buildFailureItems({
    preview: prefetch.preview,
    probes: prefetch.probes,
    importResult,
    duplicateStrategy: 'skip',
    subscriptionId: SUB_URL,
  });
  const buckets = bucketFailures(failures);
  const startedAt = prefetch.startedAt;
  const finishedAt = NOW + 3000;
  return {
    status: 'done',
    subscriptionUrl: prefetch.subscriptionUrl,
    preview: prefetch.preview,
    probes: prefetch.probes,
    estimate: prefetch.estimate,
    import: importResult,
    failures,
    report: buildFailureReport({
      subscriptionUrl: prefetch.subscriptionUrl,
      preview: prefetch.preview,
      importResult,
      probes: prefetch.probes,
      failures,
      buckets,
      alive,
      warnings: prefetch.warnings,
      startedAt,
      finishedAt,
      now: finishedAt,
    }),
    alive,
    autoDisabled: 0,
    warnings: prefetch.warnings,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    pending: 0,
  };
}

function findButton(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('button').find((node) => node.text().includes(text));
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
}

/* ---------- ImportSummary ---------- */

describe('ImportSummary（EXT-08 汇总卡）', () => {
  it('默认态渲染四项计数、耗时与存活率', () => {
    const result = makeResult();
    const wrapper = mount(ImportSummary, { props: { result, cleanupCount: 1 } });
    expect(wrapper.findAll('.import-summary__value').map((node) => node.text())).toEqual([
      '1',
      '2',
      '1',
      '1',
    ]);
    const text = wrapper.text();
    expect(text).toContain('诊断完成');
    expect(text).toContain('订阅共 3 个条目');
    expect(text).toContain('存活源');
    expect(text).toContain('50%');
    expect(text).toContain('清理失败源（1）');
  });

  it('估算区区分「实测体积」与「默认体积推算」', () => {
    const measured = mount(ImportSummary, { props: { result: makeResult(), cleanupCount: 0 } });
    expect(measured.text()).toContain('1 个 jar');
    expect(measured.text()).not.toContain('按默认体积估算');

    const assumedPrefetch = makePrefetch();
    assumedPrefetch.probes = [makeProbe({ contentLength: null })];
    assumedPrefetch.estimate = estimateJarDownload(assumedPrefetch.probes);
    const assumed = mount(ImportSummary, {
      props: { result: makeResult(assumedPrefetch), cleanupCount: 0 },
    });
    expect(assumed.text()).toContain('按默认体积估算');
  });

  it('空数据：未开始时给出引导文案，不渲染计数', () => {
    const wrapper = mount(ImportSummary, { props: { result: null } });
    expect(wrapper.findAll('.import-summary__value')).toHaveLength(0);
    expect(wrapper.text()).toContain('完成一次诊断后');
  });

  it('加载中：四个骨架块占位', () => {
    const wrapper = mount(ImportSummary, { props: { result: null, loading: true } });
    expect(wrapper.findAll('.skeleton')).toHaveLength(4);
  });

  it('取消态：文案标注已取消，清理按钮按数量置灰', () => {
    const result = { ...makeResult(), status: 'canceled' as const, import: null, failures: [] };
    const wrapper = mount(ImportSummary, { props: { result, cleanupCount: 0 } });
    expect(wrapper.text()).toContain('已取消（未写入）');
    const cleanup = findButton(wrapper, '清理失败源');
    expect(cleanup.attributes('disabled')).toBeDefined();
  });

  it('点击两个出口动作分别派发 export / cleanup', async () => {
    const wrapper = mount(ImportSummary, { props: { result: makeResult(), cleanupCount: 2 } });
    await findButton(wrapper, '导出失败报告').trigger('click');
    await findButton(wrapper, '清理失败源').trigger('click');
    expect(wrapper.emitted('export')).toHaveLength(1);
    expect(wrapper.emitted('cleanup')).toHaveLength(1);
  });
});

/* ---------- FailureClassification ---------- */

describe('FailureClassification（EXT-08 失败分类）', () => {
  it('渲染分类行、占比条与逐条明细（URL / 错误码 / 建议）', () => {
    const result = makeResult();
    const wrapper = mount(FailureClassification, {
      props: { buckets: result.report.buckets, failures: result.failures },
    });
    const text = wrapper.text();
    expect(text).toContain('共 2 条');
    expect(text).toContain('jar 不可达');
    expect(text).toContain('jar 缺失');
    expect(text).toContain('https://dead.example.com');
    expect(text).toContain('E_HTTP_403');
    expect(text).toContain('可重试');
    expect(wrapper.findAll('.failure-class__item')).toHaveLength(2);
    const bars = wrapper.findAll('.failure-class__bar');
    expect(bars).toHaveLength(2);
    expect(bars.every((bar) => (bar.attributes('style') ?? '').includes('50%'))).toBe(true);
  });

  it('空数据：成功态文案且不渲染空条', () => {
    const wrapper = mount(FailureClassification, { props: { buckets: [], failures: [] } });
    expect(wrapper.findAll('.failure-class__item')).toHaveLength(0);
    expect(wrapper.text()).toContain('本次导入没有失败条目');
  });

  it('加载中：两行骨架', () => {
    const wrapper = mount(FailureClassification, {
      props: { buckets: [], failures: [], loading: true },
    });
    expect(wrapper.findAll('.skeleton')).toHaveLength(2);
  });

  it('数据超限：默认折叠，展开后可看到全部明细', async () => {
    const result = makeResult();
    const failures = Array.from({ length: 12 }, (_, index) => ({
      ...result.failures[0],
      key: `k-${index}`,
      name: `失败源 ${index}`,
    }));
    const wrapper = mount(FailureClassification, {
      props: { buckets: result.report.buckets, failures, maxVisible: 5 },
    });
    expect(wrapper.findAll('.failure-class__item')).toHaveLength(5);
    expect(wrapper.text()).toContain('展开全部 12 条');
    await findButton(wrapper, '展开全部').trigger('click');
    expect(wrapper.findAll('.failure-class__item')).toHaveLength(12);
  });

  it('异常数据：占比越界收敛到 0~100，缺失字段显示占位', () => {
    const wrapper = mount(FailureClassification, {
      props: {
        buckets: [
          { reason: 'timeout', label: '连接超时', hint: 'h', count: 2, ratio: 1, percent: 140 },
          { reason: 'unknown', label: '未知原因', hint: 'h', count: 1, ratio: -0.2, percent: -20 },
        ],
        failures: [
          {
            key: 'x',
            name: '',
            type: 'spider',
            baseUrl: '',
            jarUrl: null,
            reason: 'unknown',
            label: '未知原因',
            errorCode: null,
            detail: '',
            suggestion: '',
            retryable: false,
          },
        ],
      },
    });
    const bars = wrapper.findAll('.failure-class__bar');
    expect(bars[0].attributes('style')).toContain('width: 100%');
    expect(bars[1].attributes('style')).toContain('width: 0%');
    expect(wrapper.text()).toContain('—');
  });
});

/* ---------- ImportDiagnosticView ---------- */

describe('ImportDiagnosticView（EXT-08 页面装配）', () => {
  beforeEach(async () => {
    await resetAll();
    setActivePinia(createPinia());
    serviceMocks.prefetchImport.mockReset();
    serviceMocks.importWithDiagnostic.mockReset();
    routerMocks.back.mockClear();
  });

  it('初始态：渲染地址输入、四个阶段与结果空态', async () => {
    const wrapper = mount(ImportDiagnosticView);
    await settle();

    expect(wrapper.find('.field__input').exists()).toBe(true);
    expect(wrapper.findAll('.diagnostic__stage')).toHaveLength(4);
    expect(wrapper.text()).toContain('开始诊断');
    expect(wrapper.text()).toContain('完成一次诊断后');
    expect(wrapper.find('.failure-class').exists()).toBe(false);
  });

  it('空地址 / 非法地址不发起请求，给出本地错误', async () => {
    const wrapper = mount(ImportDiagnosticView);
    await settle();

    await findButton(wrapper, '开始诊断').trigger('click');
    await settle(2);
    expect(wrapper.text()).toContain('请输入订阅地址');
    expect(serviceMocks.prefetchImport).not.toHaveBeenCalled();

    await wrapper.find('.field__input').setValue('ftp://example.com/x.json');
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle(2);
    expect(wrapper.text()).toContain('订阅地址必须是 http(s):// 开头的合法地址');
    expect(serviceMocks.prefetchImport).not.toHaveBeenCalled();
  });

  it('诊断后渲染源状态 / 估算 / 告警，确认后调用带诊断的导入', async () => {
    const prefetch = makePrefetch();
    const result = makeResult(prefetch);
    serviceMocks.prefetchImport.mockResolvedValue(prefetch);
    serviceMocks.importWithDiagnostic.mockResolvedValue(result);

    const wrapper = mount(ImportDiagnosticView);
    await settle();
    await wrapper.find('.field__input').setValue(` ${SUB_URL} `);
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle();

    expect(serviceMocks.prefetchImport).toHaveBeenCalledTimes(1);
    expect(serviceMocks.prefetchImport.mock.calls[0][0]).toBe(SUB_URL);

    // 源状态：1 待写入 / 1 jar 不可达 / 1 配置无效
    const rows = wrapper.findAll('.diagnostic__row');
    expect(rows).toHaveLength(3);
    const rowText = rows.map((row) => row.text());
    expect(rowText[0]).toContain('待写入');
    expect(rowText[1]).toContain('jar 不可达');
    expect(rowText[2]).toContain('配置无效');
    expect(wrapper.text()).toContain('预计导入耗时');
    expect(wrapper.text()).toContain('1 个 jar 不可达');

    await findButton(wrapper, '开始导入（1 个源）').trigger('click');
    await settle();

    expect(serviceMocks.importWithDiagnostic).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = serviceMocks.importWithDiagnostic.mock.calls[0];
    expect(calledUrl).toBe(SUB_URL);
    expect(options.preview).toEqual(prefetch.preview);
    expect(options.probes).toEqual(prefetch.probes);
    expect(options.onDuplicate).toBe('skip');
    expect(typeof options.onProgress).toBe('function');

    // 结果区：汇总 + 失败分类
    expect(wrapper.findAll('.import-summary__value').map((node) => node.text())).toEqual([
      '1',
      '2',
      '1',
      '1',
    ]);
    expect(wrapper.find('.failure-class').exists()).toBe(true);
    expect(wrapper.text()).toContain('已写入');
    expect(wrapper.text()).toContain('诊断完成');
  });

  it('同名策略切换后以 overwrite 提交', async () => {
    serviceMocks.prefetchImport.mockResolvedValue(makePrefetch());
    serviceMocks.importWithDiagnostic.mockResolvedValue(makeResult());

    const wrapper = mount(ImportDiagnosticView);
    await settle();
    await wrapper.find('.field__input').setValue(SUB_URL);
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle();

    const overwrite = wrapper.findAll('.segmented__item').find((node) => node.text() === '覆盖');
    if (!overwrite) throw new Error('未找到「覆盖」选项');
    await overwrite.trigger('click');
    await findButton(wrapper, '开始导入').trigger('click');
    await settle();

    expect(serviceMocks.importWithDiagnostic.mock.calls[0][1].onDuplicate).toBe('overwrite');
  });

  it('诊断失败展示错误态并可重试', async () => {
    serviceMocks.prefetchImport
      .mockRejectedValueOnce(new AppError('E_NETWORK'))
      .mockResolvedValueOnce(makePrefetch());

    const wrapper = mount(ImportDiagnosticView);
    await settle();
    await wrapper.find('.field__input').setValue(SUB_URL);
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle();

    expect(wrapper.find('.error-state').exists()).toBe(true);

    await findButton(wrapper, '重试').trigger('click');
    await settle();
    expect(serviceMocks.prefetchImport).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.error-state').exists()).toBe(false);
    expect(wrapper.findAll('.diagnostic__row')).toHaveLength(3);
  });

  it('取消诊断：中止在途请求并回到初始态', async () => {
    let rejectWith: (e: unknown) => void = () => {};
    serviceMocks.prefetchImport.mockImplementation(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          rejectWith = reject;
          options.signal?.addEventListener('abort', () => reject(new AppError('E_ABORTED')));
        }),
    );

    const wrapper = mount(ImportDiagnosticView);
    await settle();
    await wrapper.find('.field__input').setValue(SUB_URL);
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle(2);

    await findButton(wrapper, '取消').trigger('click');
    rejectWith(new AppError('E_ABORTED'));
    await settle();

    expect(wrapper.text()).toContain('开始诊断');
    expect(wrapper.findAll('.diagnostic__row')).toHaveLength(0);
  });

  it('导出失败报告：触发一次下载点击', async () => {
    const prefetch = makePrefetch();
    serviceMocks.prefetchImport.mockResolvedValue(prefetch);
    serviceMocks.importWithDiagnostic.mockResolvedValue(makeResult(prefetch));

    const wrapper = mount(ImportDiagnosticView);
    await settle();
    await wrapper.find('.field__input').setValue(SUB_URL);
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle();
    await findButton(wrapper, '开始导入').trigger('click');
    await settle();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await findButton(wrapper, '导出失败报告').trigger('click');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = document.querySelector('a[download]');
    expect(anchor?.getAttribute('download')).toMatch(/^import-diagnostic-\d{8}-\d{4}\.json$/);
    clickSpy.mockRestore();
  });

  it('清理失败源：复用 store.cleanupFailedSources，取消确认不执行', async () => {
    await sourceRepo.save(
      makeSource({ id: 'fail-1', key: 'fail-1', name: '失败源', health: 'unreachable' }),
    );
    serviceMocks.prefetchImport.mockResolvedValue(makePrefetch());
    serviceMocks.importWithDiagnostic.mockResolvedValue(makeResult());

    const wrapper = mount(ImportDiagnosticView);
    await settle();
    await wrapper.find('.field__input').setValue(SUB_URL);
    await findButton(wrapper, '开始诊断').trigger('click');
    await settle();
    await findButton(wrapper, '开始导入').trigger('click');
    await settle();

    const store = useSourceStore();
    const ui = useUiStore();
    const cleanup = vi.spyOn(store, 'cleanupFailedSources').mockResolvedValue({ done: 1, failed: 0 });
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(false);

    await findButton(wrapper, '清理失败源').trigger('click');
    await settle(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await findButton(wrapper, '清理失败源').trigger('click');
    await settle(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
