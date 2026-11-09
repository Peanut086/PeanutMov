/**
 * OPT-04：失败源汇总 / 折叠 / 只重试失败源 —— 纯函数部分
 *
 * 覆盖：
 * - `failedSourceIds`：只重试失败源的 id 集合（去重、保持首次出现顺序）
 * - `summarizeSearchFailures`：一句话原因（按 sourceId 去重、按原因聚类、Top-N）
 * - `SEARCH_FAILURE_LABELS`：分类标签与 `classifySourceFailure` 全量对齐（不新增第二套分类）
 */
import { describe, expect, it } from 'vitest';

import {
  SEARCH_FAILURE_LABELS,
  SEARCH_FAILURE_REASON_LIMIT,
  failedSourceIds,
  summarizeSearchFailures,
} from '@/services/searchAggregate';
import { SOURCE_INTERNAL_MESSAGE, RULE_SCRIPT_MESSAGE } from '@/shared/sourceFailure';
import type { SourceFailureKind } from '@/shared/sourceFailure';
import type { AppErrorShape } from '@/types';

/** 构造失败错误（code 缺省 E_UNKNOWN；其它字段可覆盖） */
function err(overrides: Partial<AppErrorShape> = {}): AppErrorShape {
  return {
    code: 'E_UNKNOWN',
    message: '搜索失败',
    detail: null,
    retryable: true,
    httpStatus: null,
    ...overrides,
  } as AppErrorShape;
}

const FAILURES = [
  { sourceId: 's1', error: err({ code: 'E_NETWORK', message: '站点 500' }) },
  { sourceId: 's2', error: err({ code: 'E_TIMEOUT', message: '超时' }) },
  { sourceId: 's3', error: err({ code: 'E_NETWORK', message: '站点 500' }) },
];

describe('failedSourceIds（OPT-04 只重试失败源）', () => {
  it('无失败源时为空数组', () => {
    expect(failedSourceIds([])).toEqual([]);
  });

  it('同一源出现多次只保留一个，且保持首次出现顺序', () => {
    const ids = failedSourceIds([
      { sourceId: 'b', error: err({ code: 'E_TIMEOUT' }) },
      { sourceId: 'a', error: err({ code: 'E_NETWORK' }) },
      { sourceId: 'b', error: err({ code: 'E_TIMEOUT' }) },
    ]);
    expect(ids).toEqual(['b', 'a']);
  });
});

describe('summarizeSearchFailures（OPT-04 失败源汇总）', () => {
  it('无失败源：total 0、text 为空、rows 为空（面板不渲染）', () => {
    const summary = summarizeSearchFailures([]);
    expect(summary.total).toBe(0);
    expect(summary.rows).toEqual([]);
    expect(summary.reasons).toEqual([]);
    expect(summary.text).toBe('');
  });

  it('按 sourceId 去重：同一源只算一次，保留最后一次错误', () => {
    const summary = summarizeSearchFailures([
      { sourceId: 's1', error: err({ code: 'E_TIMEOUT', message: '第一次超时' }) },
      { sourceId: 's1', error: err({ code: 'E_NETWORK', message: '后来彻底挂了' }) },
    ]);
    expect(summary.total).toBe(1);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]?.kind).toBe('source_dead');
    expect(summary.rows[0]?.detail).toBe('后来彻底挂了');
  });

  it('一句话原因按数量降序，同数保持首次出现顺序', () => {
    const summary = summarizeSearchFailures([
      ...FAILURES,
      { sourceId: 's4', error: err({ code: 'E_HTTP_404', message: '没找到' }) },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.reasons).toEqual([
      { label: '源站已失效', count: 3 },
      { label: '解析超时', count: 1 },
    ]);
    expect(summary.text).toBe('3 源站已失效 · 1 解析超时');
  });

  it('原因超过 limit 时一句话只列 Top-N，但 reasons/rows 仍全量', () => {
    const summary = summarizeSearchFailures(
      [
        { sourceId: 'a', error: err({ code: 'E_NETWORK' }) },
        { sourceId: 'b', error: err({ code: 'E_TIMEOUT' }) },
        { sourceId: 'c', error: err({ code: 'E_AUTH' }) },
      ],
      { reasonLimit: 1 },
    );
    expect(summary.reasons).toHaveLength(3);
    expect(summary.rows).toHaveLength(3);
    expect(summary.text).toBe('1 源站已失效');
  });

  it('reasonLimit=0 时不出文案（面板只显示「N 个源搜索失败」）', () => {
    expect(summarizeSearchFailures(FAILURES, { reasonLimit: 0 }).text).toBe('');
  });

  it('默认 limit 与 SEARCH_FAILURE_REASON_LIMIT 一致', () => {
    const failures = [
      { sourceId: 'a', error: err({ code: 'E_NETWORK' }) },
      { sourceId: 'b', error: err({ code: 'E_TIMEOUT' }) },
      { sourceId: 'c', error: err({ code: 'E_AUTH' }) },
    ];
    const byDefault = summarizeSearchFailures(failures);
    const explicit = summarizeSearchFailures(failures, { reasonLimit: SEARCH_FAILURE_REASON_LIMIT });
    expect(byDefault.text).toBe(explicit.text);
    expect(byDefault.text.split(' · ')).toHaveLength(SEARCH_FAILURE_REASON_LIMIT);
  });

  it('明细 detail 收敛脚本内部异常，不外泄原始堆栈', () => {
    const summary = summarizeSearchFailures([
      { sourceId: 's1', error: err({ code: 'E_PARSE', message: "SyntaxError: unexpected token ';'" }) },
      { sourceId: 's2', error: err({ code: 'E_PARSE', message: 'NullPointerException: Attempt to invoke virtual method' }) },
    ]);
    expect(summary.rows[0]?.kind).toBe('rule_script');
    expect(summary.rows[0]?.detail).toBe(RULE_SCRIPT_MESSAGE);
    expect(summary.rows[1]?.kind).toBe('source_internal');
    expect(summary.rows[1]?.detail).toBe(SOURCE_INTERNAL_MESSAGE);
  });

  it('detail 优先取 detail 字段，缺失时回落 message；都为空则空串', () => {
    const summary = summarizeSearchFailures([
      { sourceId: 's1', error: err({ code: 'E_TIMEOUT', message: '超时', detail: '第 3 次超时' }) },
      { sourceId: 's2', error: err({ code: 'E_TIMEOUT', message: '超时', detail: null }) },
      { sourceId: 's3', error: err({ code: 'E_TIMEOUT', message: '', detail: null }) },
    ]);
    expect(summary.rows[0]?.detail).toBe('第 3 次超时');
    expect(summary.rows[1]?.detail).toBe('超时');
    expect(summary.rows[2]?.detail).toBe('');
  });

  it('异常数据（error 为 null / 未知 code）归入「原因未知」而不抛错', () => {
    // 未来新增的错误码（严格契约里不存在，运行时可能出现）→ 走 default 分支
    const futureCode = err({ code: 'E_SOMETHING_NEW' as unknown as AppErrorShape['code'] });
    const summary = summarizeSearchFailures([
      { sourceId: 's1', error: null as unknown as AppErrorShape },
      { sourceId: 's2', error: futureCode },
    ]);
    expect(summary.total).toBe(2);
    expect(summary.reasons).toEqual([{ label: '原因未知', count: 2 }]);
    expect(summary.rows.every((row) => row.kind === 'unknown')).toBe(true);
  });
});

describe('SEARCH_FAILURE_LABELS（分类标签穷举）', () => {
  const KINDS: SourceFailureKind[] = [
    'source_dead',
    'timeout',
    'protocol_unsupported',
    'rule_script',
    'source_internal',
    'safe_mode',
    'quarantined',
    'spider_mismatch',
    'auth',
    'keyword_ignored',
    'unknown',
  ];

  it('11 类失败原因都有非空标签', () => {
    for (const kind of KINDS) {
      expect(SEARCH_FAILURE_LABELS[kind].trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(SEARCH_FAILURE_LABELS)).toHaveLength(KINDS.length);
  });
});
