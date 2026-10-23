/**
 * 管道规则匹配器单测
 *
 * 语义断言：
 * - all / any / not 的组合；
 * - priority 与 preferRules 提权；
 * - terminal 只终止匹配、不终止降级；
 * - 正则安全校验（长度 + 嵌套量词）。
 */
import { describe, expect, it } from 'vitest';

import { compilePattern, evaluateCondition, isSafePattern, isStatusAware, matchRule } from '@/sources/pipeline/matcher';
import type { CrawlRule, Fingerprint, MatchCondition } from '@/sources/pipeline/types';

function makeFp(overrides: Partial<Fingerprint> = {}): Fingerprint {
  return {
    status: 200,
    contentType: 'application/json',
    mime: 'application/json',
    charset: null,
    prefix: '{"code":1,"list":[]}',
    firstChar: '{',
    looksLikeJson: true,
    looksLikeXml: false,
    looksLikeHtml: false,
    jsonKeys: ['code', 'list'],
    magic: null,
    looksLikeImage: false,
    empty: false,
    headerHints: { cfRay: false, server: null, retryAfterSec: null },
    redirected: false,
    finalHost: null,
    hash: 'abc',
    ...overrides,
  };
}

function makeRule(overrides: Partial<CrawlRule> = {}): CrawlRule {
  return {
    id: 'test.rule',
    priority: 50,
    intent: ['catalog'],
    when: { all: [{ field: 'looksLike.json', op: 'eq', value: true }] },
    parser: 'json.tvbox',
    terminal: true,
    retry: { maxAttempts: 1, backoffMs: [], retryOn: [] },
    ...overrides,
  };
}

const headers = new Headers();

describe('isSafePattern / compilePattern', () => {
  it('长度 ≤200 且无嵌套量词 → 安全', () => {
    expect(isSafePattern('^\\s*https?://\\S+\\s*$')).toBe(true);
  });

  it('超长正则拒绝', () => {
    expect(isSafePattern('a'.repeat(201))).toBe(false);
  });

  it('嵌套量词拒绝（防灾难性回溯）', () => {
    expect(isSafePattern('(\\w+)+')).toBe(false);
    expect(isSafePattern('(a*)*')).toBe(false);
    // 组内无量词时不算嵌套（`(a|b)+` 是常见且安全的写法）
    expect(isSafePattern('(a|b)+')).toBe(true);
  });

  it('语法错误的正则返回 null', () => {
    expect(compilePattern('([unclosed')).toBeNull();
  });
});

describe('evaluateCondition', () => {
  it('json.hasKey 支持 exists（全部命中）与 in（任一命中）', () => {
    const fp = makeFp();
    const exists: MatchCondition = { field: 'json.hasKey', op: 'exists', value: ['list'] };
    const missing: MatchCondition = { field: 'json.hasKey', op: 'exists', value: ['sites'] };
    const anyOf: MatchCondition = { field: 'json.hasKey', op: 'in', value: ['class', 'list'] };
    expect(evaluateCondition(exists, fp, 'https://a.example.com', headers)).toBe(true);
    expect(evaluateCondition(missing, fp, 'https://a.example.com', headers)).toBe(false);
    expect(evaluateCondition(anyOf, fp, 'https://a.example.com', headers)).toBe(true);
  });

  it('status 数值比较', () => {
    const fp = makeFp({ status: 403 });
    expect(
      evaluateCondition({ field: 'status', op: 'in', value: [403, 429] }, fp, 'https://a.example.com', headers),
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'status', op: 'gte', value: 400 }, fp, 'https://a.example.com', headers),
    ).toBe(true);
  });

  it('contentType 为 null 时不崩溃（跨域不可读）', () => {
    const fp = makeFp({ contentType: null, mime: '' });
    expect(
      evaluateCondition({ field: 'contentType', op: 'contains', value: 'json' }, fp, 'https://a.example.com', headers),
    ).toBe(false);
  });

  it('header 条件读响应头', () => {
    const h = new Headers({ server: 'cloudflare' });
    expect(evaluateCondition({ field: 'header', op: 'contains', value: 'cloudflare', name: 'server' }, makeFp(), 'https://a.example.com', h)).toBe(true);
    expect(evaluateCondition({ field: 'header', op: 'exists', value: true, name: 'cf-ray' }, makeFp(), 'https://a.example.com', h)).toBe(false);
  });

  it('bodyRegex 在前缀上匹配（多行）', () => {
    const fp = makeFp({ prefix: 'https://a.example.com/x\nhttps://b.example.com/y', looksLikeJson: false });
    expect(
      evaluateCondition({ field: 'bodyRegex', op: 'regex', value: '^\\s*https?://\\S+\\s*$', flags: 'm' }, fp, 'https://a.example.com', headers),
    ).toBe(true);
  });
});

describe('matchRule', () => {
  it('按 priority 升序取第一条命中', () => {
    const rules = [
      makeRule({ id: 'low', priority: 90 }),
      makeRule({ id: 'high', priority: 10 }),
    ];
    expect(matchRule(rules, { intent: 'catalog', fingerprint: makeFp(), url: 'https://a.example.com', headers })?.id).toBe('high');
  });

  it('intent 不匹配的规则不参与', () => {
    const rules = [makeRule({ id: 'sub', intent: ['subscription'] })];
    expect(matchRule(rules, { intent: 'catalog', fingerprint: makeFp(), url: 'https://a.example.com', headers })).toBeNull();
  });

  it('preferRules 提权后优先命中', () => {
    const rules = [
      makeRule({ id: 'default', priority: 10 }),
      makeRule({ id: 'preferred', priority: 500 }),
    ];
    const hit = matchRule(rules, {
      intent: 'catalog',
      fingerprint: makeFp(),
      url: 'https://a.example.com',
      headers,
      preferRules: ['preferred'],
    });
    expect(hit?.id).toBe('preferred');
  });

  it('onlyRules 限制候选（4xx 时只允许 status-aware 规则）', () => {
    const rules = [
      makeRule({ id: 'reject.empty', priority: 1, when: { all: [{ field: 'looksLike.empty', op: 'eq', value: true }] } }),
      makeRule({ id: 'ua.adaptive', priority: 15, when: { all: [{ field: 'status', op: 'in', value: [403] }] } }),
    ];
    const fp = makeFp({ status: 403, empty: true, looksLikeJson: false, firstChar: '', prefix: '' });
    const hit = matchRule(rules, {
      intent: 'catalog',
      fingerprint: fp,
      url: 'https://a.example.com',
      headers,
      onlyRules: new Set(['ua.adaptive']),
    });
    expect(hit?.id).toBe('ua.adaptive');
  });

  it('not 条件排除', () => {
    const rule = makeRule({
      when: {
        all: [{ field: 'looksLike.json', op: 'eq', value: true }],
        not: [{ field: 'status', op: 'eq', value: 403 }],
      },
    });
    expect(matchRule([rule], { intent: 'catalog', fingerprint: makeFp({ status: 403 }), url: 'https://a.example.com', headers })).toBeNull();
    expect(matchRule([rule], { intent: 'catalog', fingerprint: makeFp({ status: 200 }), url: 'https://a.example.com', headers })).not.toBeNull();
  });

  it('any 条件至少一条命中', () => {
    const rule = makeRule({
      when: { any: [{ field: 'looksLike.xml', op: 'eq', value: true }, { field: 'looksLike.json', op: 'eq', value: true }] },
    });
    expect(matchRule([rule], { intent: 'catalog', fingerprint: makeFp(), url: 'https://a.example.com', headers })).not.toBeNull();
  });
});

describe('isStatusAware', () => {
  it('显式声明 status 条件的规则为 true', () => {
    expect(isStatusAware(makeRule({ when: { all: [{ field: 'status', op: 'in', value: [403] }] } }))).toBe(true);
    expect(isStatusAware(makeRule())).toBe(false);
  });
});
