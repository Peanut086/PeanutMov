/**
 * 导入诊断服务单测（EXT-08）
 *
 * 覆盖：阶段口径、jar 探测投影、失败分类与聚合、失败明细（预览侧 + 健康侧合并）、
 * 存活统计、下载耗时估算与格式化、报告组装/序列化/文件名、下载触发与自动禁用阈值。
 *
 * 全部用例为纯函数断言（无网络、无 IndexedDB），`downloadFailureReport` 只验证
 * DOM 侧行为（happy-dom + `tests/setup.ts` 的 `URL.createObjectURL` 打桩）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assumedThroughputKbps,
  bucketFailures,
  buildFailureItems,
  buildFailureReport,
  classifyEntryFailure,
  collectJarTargets,
  DEFAULT_JAR_BYTES,
  diagnoseJarTargets,
  downloadFailureReport,
  estimateJarDownload,
  FAILURE_CATEGORY_META,
  FAILURE_REPORT_VERSION,
  failureReportBlob,
  failureReportFileName,
  formatBytes,
  formatDuration,
  IMPORT_DIAGNOSTIC_STAGES,
  isStageReached,
  jarProbeSummaryOf,
  jarSuggestionOf,
  jarUrlOfEntry,
  probeWarnings,
  serializeFailureReport,
  shouldAutoDisable,
  stageIndexOf,
  summarizeAliveSources,
  toJarProbeSummaries,
  type ImportFailureItem,
  type JarProbeSummary,
} from '@/services/ImportDiagnosticService';
import { FAILURE_REASON_META } from '@/services/healthCenterService';
import { importService } from '@/services/importService';
import type { ImportPreview, ImportPreviewEntry, ImportResult, Source } from '@/types';

/* ---------- 构造器 ---------- */

const NOW = new Date(2026, 10, 6, 9, 30).getTime();

function makeEntry(overrides: Partial<ImportPreviewEntry> = {}): ImportPreviewEntry {
  const key = overrides.key ?? 'entry-1';
  const normalized =
    overrides.normalized === undefined
      ? {
          name: overrides.name ?? '示例源',
          type: (overrides.type === 'unknown' ? 'spider' : (overrides.type ?? 'spider')) as
            | 'spider'
            | 'site',
          baseUrl: 'https://example.com',
          key,
          ext: { kind: 'jar', jarUrl: 'https://cdn.example.com/spider.jar' },
        }
      : overrides.normalized;
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
    ...overrides,
    // `normalized` 始终以构造结果为准：显式传 null 表示"解析失败"
    normalized,
  };
}

function makePreview(entries: ImportPreviewEntry[], overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    origin: 'url',
    sourceUrl: 'https://example.com/tvbox.json',
    fileName: null,
    fetchedAt: NOW,
    name: '测试订阅',
    total: entries.length,
    entries,
    globalIssues: [],
    repos: [],
    lives: [],
    ...overrides,
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

function makeFailure(overrides: Partial<ImportFailureItem> = {}): ImportFailureItem {
  const reason = overrides.reason ?? 'jar_unreachable';
  return {
    key: overrides.key ?? 'entry-1',
    name: overrides.name ?? '示例源',
    type: overrides.type ?? 'spider',
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    jarUrl: overrides.jarUrl ?? 'https://cdn.example.com/spider.jar',
    reason,
    label: overrides.label ?? FAILURE_CATEGORY_META[reason].label,
    errorCode: overrides.errorCode ?? null,
    detail: overrides.detail ?? 'HTTP 403',
    suggestion: overrides.suggestion ?? FAILURE_CATEGORY_META[reason].hint,
    retryable: overrides.retryable ?? FAILURE_CATEGORY_META[reason].retryable,
  };
}

function makeSource(overrides: Partial<Source> = {}): Source {
  const now = NOW;
  return {
    id: overrides.id ?? 'source-1',
    key: overrides.key ?? overrides.id ?? 'source-1',
    name: overrides.name ?? '源',
    type: overrides.type ?? 'site',
    enabled: overrides.enabled ?? true,
    builtin: false,
    sort: 0,
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: overrides.ext ?? null,
    subscriptionId: overrides.subscriptionId ?? null,
    warning: null,
    health: overrides.health ?? 'unknown',
    healthCheckedAt: null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/* ---------- 阶段 ---------- */

describe('阶段口径', () => {
  it('四个阶段按固定顺序，下标与可达判定一致', () => {
    expect(IMPORT_DIAGNOSTIC_STAGES.map((item) => item.stage)).toEqual([
      'parse',
      'probe',
      'import',
      'done',
    ]);
    expect(stageIndexOf('parse')).toBe(0);
    expect(stageIndexOf('done')).toBe(3);
    expect(stageIndexOf('idle')).toBe(-1);
    expect(isStageReached('probe', 'parse')).toBe(true);
    expect(isStageReached('probe', 'import')).toBe(false);
    expect(isStageReached('idle', 'parse')).toBe(false);
  });
});

/* ---------- jar 投影 ---------- */

describe('jar 探测投影', () => {
  it('结果投影保留状态码 / 体积 / 延迟，负延迟与 NaN 收敛为 0', () => {
    const summary = jarProbeSummaryOf('https://a/x.jar', {
      verdict: 'ok',
      viaMirror: 'https://mirror/x.jar',
      latencyMs: -5,
      contentLength: 1024,
      errorCode: null,
      httpStatus: 200,
    });
    expect(summary).toEqual({
      jarUrl: 'https://a/x.jar',
      verdict: 'ok',
      detail: null,
      errorCode: null,
      httpStatus: 200,
      contentLength: 1024,
      latencyMs: 0,
      viaMirror: 'https://mirror/x.jar',
    });

    const nan = jarProbeSummaryOf('https://a/y.jar', {
      verdict: 'unknown',
      viaMirror: null,
      latencyMs: Number.NaN,
      contentLength: null,
      errorCode: 'E_TIMEOUT',
      httpStatus: null,
    });
    expect(nan.latencyMs).toBe(0);
    expect(nan.detail).toBeNull();
  });

  it('Map 转数组按 jarUrl 升序，保证报告稳定', () => {
    const map = new Map([
      ['https://b/2.jar', { verdict: 'ok' as const, viaMirror: null, latencyMs: 10, contentLength: null, errorCode: null, httpStatus: 200 }],
      ['https://a/1.jar', { verdict: 'dead' as const, detail: 'HTTP 403', viaMirror: null, latencyMs: 20, contentLength: null, errorCode: 'E_HTTP_403' as const, httpStatus: 403 }],
    ]);
    expect(toJarProbeSummaries(map).map((item) => item.jarUrl)).toEqual([
      'https://a/1.jar',
      'https://b/2.jar',
    ]);
  });

  it('空 jar 列表直接返回空结果，不发起探测', async () => {
    await expect(diagnoseJarTargets([])).resolves.toEqual([]);
  });
});

describe('jar 目标收集', () => {
  it('只取「爬虫 + 有效 + ext.kind=jar」的条目，去重并保持首次出现顺序', () => {
    const preview = makePreview([
      makeEntry({ key: 'a', normalized: { name: 'a', type: 'spider', baseUrl: 'x', ext: { kind: 'jar', jarUrl: 'https://cdn/1.jar' } } }),
      makeEntry({ key: 'b', normalized: { name: 'b', type: 'spider', baseUrl: 'x', ext: { kind: 'jar', jarUrl: 'https://cdn/1.jar ' } } }),
      makeEntry({ key: 'c', normalized: { name: 'c', type: 'spider', baseUrl: 'x', ext: { kind: 'python', jarUrl: 'https://cdn/2.py' } } }),
      makeEntry({ key: 'd', type: 'site', normalized: { name: 'd', type: 'site', baseUrl: 'x', ext: { kind: 'jar', jarUrl: 'https://cdn/3.jar' } } }),
      makeEntry({ key: 'e', valid: false, issues: [{ level: 'error', code: 'INVALID', field: 'jar', message: '缺少 jar 地址' }] }),
      makeEntry({ key: 'f', normalized: { name: 'f', type: 'spider', baseUrl: 'x', ext: { kind: 'jar', jarUrl: '  ' } } }),
      makeEntry({ key: 'g', normalized: { name: 'g', type: 'spider', baseUrl: 'x', ext: { kind: 'jar', jarUrl: 'https://cdn/2.jar' } } }),
    ]);
    expect(collectJarTargets(preview)).toEqual(['https://cdn/1.jar', 'https://cdn/2.jar']);
    expect(jarUrlOfEntry(preview.entries[4])).toBeNull();
    expect(jarUrlOfEntry(preview.entries[5])).toBeNull();
  });
});

/* ---------- 失败分类 ---------- */

describe('失败分类', () => {
  it('无效条目按 issue.field 区分 jar 缺失与配置无效', () => {
    const missingJar = makeEntry({
      valid: false,
      normalized: null,
      issues: [{ level: 'error', code: 'PARSE_JAR', field: 'jar', message: '缺少 jar 地址' }],
    });
    const badName = makeEntry({
      valid: false,
      normalized: null,
      issues: [{ level: 'error', code: 'PARSE_NAME', field: 'name', message: '缺少名称' }],
    });
    expect(classifyEntryFailure(missingJar, null)).toBe('jar_missing');
    expect(classifyEntryFailure(badName, null)).toBe('invalid_config');
  });

  it('jar 判死才算 jar 不可达；ok / unknown / 无探测都不算失败', () => {
    const entry = makeEntry();
    expect(classifyEntryFailure(entry, makeProbe({ verdict: 'dead', detail: 'HTTP 403' }))).toBe(
      'jar_unreachable',
    );
    expect(classifyEntryFailure(entry, makeProbe({ verdict: 'ok' }))).toBeNull();
    expect(classifyEntryFailure(entry, makeProbe({ verdict: 'unknown' }))).toBeNull();
    expect(classifyEntryFailure(entry, null)).toBeNull();
  });

  it('jar 建议按状态码细分，缺探测结果时回落通用文案', () => {
    expect(jarSuggestionOf(makeProbe({ verdict: 'dead', httpStatus: 403 }))).toContain('403');
    expect(jarSuggestionOf(makeProbe({ verdict: 'dead', httpStatus: 404 }))).toContain('404');
    expect(jarSuggestionOf(makeProbe({ verdict: 'dead', detail: '连接被重置', httpStatus: null }))).toContain(
      '连接被重置',
    );
    expect(jarSuggestionOf(null)).toBe(FAILURE_CATEGORY_META.jar_unreachable.hint);
  });

  it('体检四类的文案与健康中心逐字一致（同一状态不允许两种叫法）', () => {
    for (const reason of ['timeout', 'unreachable', 'bad_config', 'auth_failed'] as const) {
      expect(FAILURE_CATEGORY_META[reason].label).toBe(FAILURE_REASON_META[reason].label);
      expect(FAILURE_CATEGORY_META[reason].hint).toBe(FAILURE_REASON_META[reason].hint);
    }
  });
});

/* ---------- 失败明细 ---------- */

describe('失败明细组装', () => {
  it('预览侧四类原因各生成一条，明细与建议可读', () => {
    const deadJar = makeEntry({
      key: 'dead',
      name: '死 jar 源',
      normalized: { name: '死 jar 源', type: 'spider', baseUrl: 'https://d', ext: { kind: 'jar', jarUrl: 'https://cdn/d.jar' } },
    });
    const noJar = makeEntry({
      key: 'nojar',
      name: '缺 jar 源',
      valid: false,
      normalized: null,
      issues: [{ level: 'error', code: 'PARSE_JAR', field: 'jar', message: 'jar 地址不合法' }],
    });
    const bad = makeEntry({
      key: 'bad',
      name: '坏配置源',
      valid: false,
      normalized: null,
      issues: [{ level: 'error', code: 'PARSE', field: 'type', message: '未知源类型' }],
    });
    const dup = makeEntry({ key: 'dup', name: '重复源', duplicateOf: 'existing-id' });
    const preview = makePreview([deadJar, noJar, bad, dup]);
    const importResult: ImportResult = { success: 0, skipped: 1, failed: 0, sourceIds: [], issues: [] };

    const items = buildFailureItems({
      preview,
      probes: [makeProbe({ jarUrl: 'https://cdn/d.jar', verdict: 'dead', detail: 'HTTP 403', httpStatus: 403, errorCode: 'E_HTTP_403' })],
      importResult,
      duplicateStrategy: 'skip',
    });

    expect(items.map((item) => item.reason)).toEqual([
      'jar_unreachable',
      'jar_missing',
      'invalid_config',
      'duplicate',
    ]);
    const dead = items[0];
    expect(dead.detail).toContain('HTTP 403');
    expect(dead.errorCode).toBe('E_HTTP_403');
    expect(dead.suggestion).toContain('403');
    expect(dead.retryable).toBe(true);
    expect(items[1].detail).toBe('jar 地址不合法');
    expect(items[2].detail).toBe('未知源类型');
    expect(items[3].suggestion).toBe(FAILURE_CATEGORY_META.duplicate.hint);
  });

  it('未传导入结果时不产生「重复跳过」，覆盖策略同样不产生', () => {
    const preview = makePreview([makeEntry({ key: 'dup', duplicateOf: 'existing-id' })]);
    expect(buildFailureItems({ preview, probes: [] })).toEqual([]);
    expect(
      buildFailureItems({
        preview,
        probes: [],
        importResult: { success: 1, skipped: 0, failed: 0, sourceIds: ['x'], issues: [] },
        duplicateStrategy: 'overwrite',
      }),
    ).toEqual([]);
  });

  it('健康失败项只在指定订阅来源时追加，且同 key 不重复', () => {
    const preview = makePreview([makeEntry({ key: 'dead', duplicateOf: null })], {
      sourceUrl: 'https://example.com/tvbox.json',
    });
    const sources = [
      makeSource({ id: 's1', key: 's1', name: '超时源', health: 'timeout', subscriptionId: 'https://example.com/tvbox.json', lastErrorCode: 'E_TIMEOUT' }),
      makeSource({ id: 's2', key: 's2', name: '正常源', health: 'ok', subscriptionId: 'https://example.com/tvbox.json' }),
      makeSource({ id: 's3', key: 's3', name: '他会话的源', health: 'unreachable', subscriptionId: 'https://other/x.json' }),
    ];

    const items = buildFailureItems({
      preview,
      probes: [],
      importResult: { success: 1, skipped: 0, failed: 0, sourceIds: ['s1'], issues: [] },
      sources,
      subscriptionId: 'https://example.com/tvbox.json',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 's1', reason: 'timeout', label: '连接超时' });
    expect(items[0].detail).toContain('连接超时');

    // 没有订阅来源标识时无法界定归属，不追加健康失败项
    const orphan = buildFailureItems({
      preview,
      probes: [],
      importResult: null,
      sources,
      subscriptionId: null,
    });
    expect(orphan).toEqual([]);
  });
});

describe('分类聚合', () => {
  it('按数量降序，并列时按固定顺序，百分比四舍五入', () => {
    const items = [
      makeFailure({ key: '1', reason: 'duplicate' }),
      makeFailure({ key: '2', reason: 'duplicate' }),
      makeFailure({ key: '3', reason: 'jar_unreachable' }),
      makeFailure({ key: '4', reason: 'jar_missing' }),
    ];
    const buckets = bucketFailures(items);
    expect(buckets.map((bucket) => bucket.reason)).toEqual(['duplicate', 'jar_missing', 'jar_unreachable']);
    expect(buckets[0]).toMatchObject({ count: 2, percent: 50 });
    expect(buckets[1]).toMatchObject({ count: 1, percent: 25 });
    expect(buckets.every((bucket) => bucket.label.length > 0 && bucket.hint.length > 0)).toBe(true);
  });

  it('空输入返回空数组（不产生 0 计数的空条）', () => {
    expect(bucketFailures([])).toEqual([]);
  });
});

/* ---------- 存活统计 ---------- */

describe('存活源统计', () => {
  it('存活只算健康源，存活率四舍五入', () => {
    const stats = summarizeAliveSources([
      makeSource({ id: 'a', health: 'ok' }),
      makeSource({ id: 'b', health: 'ok' }),
      makeSource({ id: 'c', health: 'timeout' }),
      makeSource({ id: 'd', health: 'unknown' }),
    ]);
    expect(stats).toMatchObject({ total: 4, healthy: 2, failed: 1, unknown: 1, alive: 2, alivePercent: 50 });
  });

  it('无源时存活率为 0，不出现 NaN', () => {
    expect(summarizeAliveSources([])).toMatchObject({ total: 0, alive: 0, alivePercent: 0 });
  });
});

/* ---------- 耗时估算 ---------- */

describe('jar 下载耗时估算', () => {
  it('无可达 jar 返回 null', () => {
    expect(estimateJarDownload([])).toBeNull();
    expect(estimateJarDownload([makeProbe({ verdict: 'dead', contentLength: null })])).toBeNull();
  });

  it('已知体积按 content-length 累加，measured=true', () => {
    const estimate = estimateJarDownload([
      makeProbe({ jarUrl: 'https://a/1.jar', contentLength: 1024 * 1024, latencyMs: 100 }),
      makeProbe({ jarUrl: 'https://a/2.jar', contentLength: 2 * 1024 * 1024, latencyMs: 200 }),
    ]);
    expect(estimate).not.toBeNull();
    expect(estimate?.jarCount).toBe(2);
    expect(estimate?.bytes).toBe(3 * 1024 * 1024);
    expect(estimate?.assumedCount).toBe(0);
    expect(estimate?.measured).toBe(true);
    expect(estimate?.avgLatencyMs).toBe(150);
    expect(estimate?.seconds).toBeGreaterThanOrEqual(1);
  });

  it('未知体积按默认体积计入并标注 assumedCount，慢延迟降档', () => {
    const estimate = estimateJarDownload([
      makeProbe({ jarUrl: 'https://a/1.jar', contentLength: null, latencyMs: 1200 }),
    ]);
    expect(estimate?.bytes).toBe(DEFAULT_JAR_BYTES);
    expect(estimate?.assumedCount).toBe(1);
    expect(estimate?.measured).toBe(false);
    expect(estimate?.throughputKbps).toBe(180);
  });

  it('吞吐档位随延迟下降，异常延迟回落到默认档', () => {
    expect(assumedThroughputKbps(50)).toBe(1500);
    expect(assumedThroughputKbps(300)).toBe(800);
    expect(assumedThroughputKbps(600)).toBe(400);
    expect(assumedThroughputKbps(5000)).toBe(180);
    expect(assumedThroughputKbps(0)).toBe(400);
    expect(assumedThroughputKbps(Number.NaN)).toBe(400);
  });
});

describe('格式化', () => {
  it('字节数：B / KB / MB，非法值显示 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('时长：不到 1 秒 / 秒 / 分秒', () => {
    expect(formatDuration(0)).toBe('不到 1 秒');
    expect(formatDuration(0.4)).toBe('不到 1 秒');
    expect(formatDuration(12)).toBe('12 秒');
    expect(formatDuration(60)).toBe('1 分钟');
    expect(formatDuration(95)).toBe('1 分 35 秒');
  });
});

describe('探测告警', () => {
  it('死 jar 与未决 jar 各一条，全部可达时无告警', () => {
    expect(probeWarnings([makeProbe({ verdict: 'ok' })])).toEqual([]);
    const warnings = probeWarnings([
      makeProbe({ jarUrl: 'https://a/1.jar', verdict: 'dead', detail: 'HTTP 403' }),
      makeProbe({ jarUrl: 'https://a/2.jar', verdict: 'dead', detail: 'HTTP 404' }),
      makeProbe({ jarUrl: 'https://a/3.jar', verdict: 'unknown' }),
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('2 个 jar 不可达');
    expect(warnings[0]).toContain('HTTP 403');
    expect(warnings[1]).toContain('1 个 jar 探测未决');
  });
});

/* ---------- 报告 ---------- */

describe('失败报告', () => {
  const preview = makePreview([makeEntry({ key: 'a' }), makeEntry({ key: 'b' })]);
  const alive = summarizeAliveSources([makeSource({ id: 's1', health: 'ok' })]);

  function reportOf(overrides: Record<string, unknown> = {}) {
    return buildFailureReport({
      subscriptionUrl: 'https://example.com/tvbox.json',
      preview,
      importResult: { success: 1, skipped: 1, failed: 0, sourceIds: ['s1'], issues: [] },
      probes: [makeProbe({ verdict: 'dead', detail: 'HTTP 403', httpStatus: 403 })],
      failures: [makeFailure({ key: 'a' })],
      alive,
      warnings: ['w'],
      startedAt: NOW - 5000,
      now: NOW,
      ...overrides,
    });
  }

  it('汇总计数取预览总数 / 写入 / 跳过 / 死 jar 与耗时', () => {
    const report = reportOf();
    expect(report.version).toBe(FAILURE_REPORT_VERSION);
    expect(report.generatedAt).toBe(NOW);
    expect(report.subscriptionName).toBe('测试订阅');
    expect(report.summary).toEqual({
      total: 2,
      success: 1,
      failed: 1,
      skipped: 1,
      jarDead: 1,
      durationMs: 5000,
    });
    expect(report.buckets.map((bucket) => bucket.reason)).toEqual(['jar_unreachable']);
  });

  it('未导入（取消）时写入数为 0，仍产出报告', () => {
    const report = reportOf({ importResult: null, failures: [], warnings: [] });
    expect(report.summary.success).toBe(0);
    expect(report.summary.failed).toBe(0);
    expect(report.buckets).toEqual([]);
  });

  it('序列化为 2 空格缩进 JSON，Blob MIME 为 application/json', async () => {
    const report = reportOf();
    const text = serializeFailureReport(report);
    expect(text.split('\n')[1]).toBe('  "version": 1,');
    const blob = failureReportBlob(report);
    expect(blob.type).toBe('application/json');
    const parsed = JSON.parse(await blob.text()) as { subscriptionUrl: string };
    expect(parsed.subscriptionUrl).toBe('https://example.com/tvbox.json');
  });

  it('文件名带本地时区的日期与时分，非法时间回落默认名', () => {
    expect(failureReportFileName(new Date(2026, 10, 6, 9, 5).getTime())).toBe(
      'import-diagnostic-20261106-0905.json',
    );
    expect(failureReportFileName(Number.NaN)).toBe('import-diagnostic.json');
  });

  it('下载触发真实 <a download>，不立即回收 ObjectURL', () => {
    const report = reportOf();
    const createSpy = vi.spyOn(URL, 'createObjectURL');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    expect(downloadFailureReport(report)).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('a[download]').length).toBeGreaterThan(0);

    clickSpy.mockRestore();
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});

/* ---------- 自动禁用 ---------- */

describe('自动禁用阈值', () => {
  it('达到阈值才禁用，非法输入一律不禁用', () => {
    expect(shouldAutoDisable(3, 3)).toBe(true);
    expect(shouldAutoDisable(2, 3)).toBe(false);
    expect(shouldAutoDisable(Number.NaN, 3)).toBe(false);
    expect(shouldAutoDisable(3, 0)).toBe(false);
  });
});

/* ---------- importService 诊断编排 ---------- */

describe('importService 诊断编排', () => {
  const okJar = 'https://cdn/a.jar';
  const deadJar = 'https://cdn/b.jar';

  function previewWithDeadJar(): ImportPreview {
    return makePreview([
      makeEntry({
        key: 'ok',
        name: '正常源',
        normalized: { name: '正常源', type: 'spider', baseUrl: 'https://a', ext: { kind: 'jar', jarUrl: okJar } },
      }),
      makeEntry({
        key: 'dead',
        name: '死 jar 源',
        normalized: { name: '死 jar 源', type: 'spider', baseUrl: 'https://b', ext: { kind: 'jar', jarUrl: deadJar } },
      }),
    ]);
  }

  const probesOf = (): JarProbeSummary[] => [
    makeProbe({ jarUrl: okJar, contentLength: 1024 * 1024 }),
    makeProbe({ jarUrl: deadJar, verdict: 'dead', detail: 'HTTP 404', httpStatus: 404, contentLength: null }),
  ];

  it('传入预览时预取不重新拉取订阅，直接给出估算与告警', async () => {
    const preview = previewWithDeadJar();
    const prefetch = await importService.prefetchImport('  https://example.com/tvbox.json  ', {
      preview,
      probes: probesOf(),
    });
    expect(prefetch.subscriptionUrl).toBe('https://example.com/tvbox.json');
    expect(prefetch.preview).toBe(preview);
    expect(prefetch.estimate?.jarCount).toBe(1);
    expect(prefetch.warnings[0]).toContain('1 个 jar 不可达');
  });

  it('带诊断的导入只写存活源，并产出失败分类与报告', async () => {
    const preview = previewWithDeadJar();
    const commit = vi
      .spyOn(importService, 'commit')
      .mockResolvedValue({ success: 1, skipped: 0, failed: 0, sourceIds: ['s1'], issues: [] });

    const result = await importService.importWithDiagnostic('https://example.com/tvbox.json', {
      preview,
      probes: probesOf(),
      autoDisable: false,
    });

    expect(commit).toHaveBeenCalledTimes(1);
    const [committedPreview, options] = commit.mock.calls[0];
    expect(options.selectedKeys).toEqual(['ok']);
    expect(options.onDuplicate).toBe('skip');
    // 判死 jar 的条目在提交前已被取消勾选（不依赖调用方传入的预览是否标记过）
    expect(committedPreview.entries.find((entry) => entry.key === 'dead')?.selected).toBe(false);

    expect(result.status).toBe('done');
    expect(result.autoDisabled).toBe(0);
    expect(result.failures.map((item) => item.reason)).toEqual(['jar_unreachable']);
    expect(result.report.summary).toMatchObject({ total: 2, success: 1, jarDead: 1 });
    expect(result.report.failures).toHaveLength(1);

    commit.mockRestore();
  });

  it('全部条目失败时不调用 commit（空勾选不退化为全量导入）', async () => {
    const preview = makePreview([
      makeEntry({
        key: 'dead',
        valid: false,
        normalized: null,
        issues: [{ level: 'error', code: 'PARSE_JAR', field: 'jar', message: '缺少 jar 地址' }],
      }),
    ]);
    const commit = vi.spyOn(importService, 'commit');

    const result = await importService.importWithDiagnostic('https://example.com/tvbox.json', {
      preview,
      probes: [],
      jarProbe: false,
      autoDisable: false,
    });

    expect(commit).not.toHaveBeenCalled();
    expect(result.import).toMatchObject({ success: 0, skipped: 0 });
    expect(result.failures.map((item) => item.reason)).toEqual(['jar_missing']);

    commit.mockRestore();
  });

  it('已取消的信号：不写库，但仍返回报告与待处理条目数', async () => {
    const controller = new AbortController();
    controller.abort();
    const commit = vi.spyOn(importService, 'commit');

    const result = await importService.importWithDiagnostic('https://example.com/tvbox.json', {
      preview: previewWithDeadJar(),
      probes: probesOf(),
      signal: controller.signal,
    });

    expect(commit).not.toHaveBeenCalled();
    expect(result.status).toBe('canceled');
    expect(result.import).toBeNull();
    expect(result.pending).toBe(1);
    expect(result.report.summary.success).toBe(0);

    commit.mockRestore();
  });
});
