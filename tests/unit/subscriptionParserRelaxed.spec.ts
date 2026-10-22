import { describe, expect, it } from 'vitest';

import { subscriptionParser } from '@/services/subscriptionParser';

const OPTS = { origin: 'url' as const, sourceUrl: 'https://example.com/4k.json' };

/** 真实 xhztv.top/4k.json 的三个问题：// 注释、////// 分隔线、被折行截断的字符串 */
const REAL_BROKEN = `{
  "sites": [
    {
      "key": "ok-1",
      "name": "正常源",
      "type": 3,
      "api": "https://alist.example.com"
    },
    ////////////////////////////////////////////////////////////////////////////////////////////////
    //https://tv.lan2wan.top/candymuj1.json
    //饭太硬
    {
      "key": "ok-2",
      "name": "第二条",
      "type": 1,
      "api": "https://site.example.com/api.php/provide/vod/"
    }
  ]
}`;

describe('subscriptionParser 容错解析（// 注释）', () => {
  it('带整行 // 注释的订阅：容错解析成功并给出提示', () => {
    const preview = subscriptionParser.parse(REAL_BROKEN, OPTS);

    expect(preview.globalIssues.some((i) => i.code === 'PARSE_JSON')).toBe(false);
    expect(preview.total).toBe(2);
    expect(preview.entries.map((e) => e.key)).toEqual(['ok-1', 'ok-2']);
    expect(preview.entries.every((e) => e.valid)).toBe(true);
    // 告知用户这是容错结果
    expect(preview.globalIssues.some((i) => i.code === 'RELAXED_JSON')).toBe(true);
  });

  it('严格 JSON 不受影响：不产生 RELAXED_JSON 提示', () => {
    const strict = JSON.stringify({
      sources: [{ key: 'a', name: 'A', type: 'alist', api: 'https://a.com' }],
    });
    const preview = subscriptionParser.parse(strict, OPTS);

    expect(preview.globalIssues.some((i) => i.code === 'RELAXED_JSON')).toBe(false);
    expect(preview.total).toBe(1);
  });

  it('URL 里的 // 不被误当注释（严格解析直接成功）', () => {
    const withUrls = JSON.stringify({
      sources: [
        { key: 'a', name: 'A', type: 'alist', api: 'https://a.com' },
        { key: 'b', name: 'B', type: 'site', api: 'https://b.com/api.php/provide/vod/' },
      ],
    });
    const preview = subscriptionParser.parse(withUrls, OPTS);

    expect(preview.entries.map((e) => e.baseUrl)).toEqual(['https://a.com', 'https://b.com/api.php/provide/vod']);
  });

  it('字符串内缺失右引号：无法自动修复，给出诊断', () => {
    // 折行且下一行同样引号奇数 → 无法判定拼接点，只能报错
    const broken = [
      '{ "sites": [',
      '{ "key": "a", "name": "开头',
      '中间又断了',
      '结尾也没闭合, "type": 3, "api": "https://a.com" }',
      ']}',
    ].join('\n');

    const preview = subscriptionParser.parse(broken, OPTS);

    expect(preview.entries).toHaveLength(0);
    const issue = preview.globalIssues[0];
    expect(issue?.code).toBe('PARSE_JSON');
    // 诊断要能指出是引号/换行问题，而不是笼统的"不是合法 JSON"
    expect(issue?.message).toMatch(/换行|引号|结构|逗号/);
  });

  it('剥离注释仍失败：结构错误给出"缺少属性名"诊断', () => {
    const broken = `{
  "sites": [
    { "key": "a", "name": "A", "type": 3, "api": "https://a.com" },
    { , "key": "b" }
  ]
}`;
    const preview = subscriptionParser.parse(broken, OPTS);
    const issue = preview.globalIssues[0];

    expect(issue?.code).toBe('PARSE_JSON');
    expect(issue?.message).toMatch(/结构|逗号|属性名/);
  });

  it('截断的 JSON：给出"内容不完整"诊断', () => {
    const truncated = '{ "sites": [ { "key": "a", "name": "A"';
    const preview = subscriptionParser.parse(truncated, OPTS);
    const issue = preview.globalIssues[0];

    expect(issue?.code).toBe('PARSE_JSON');
    expect(issue?.message).toContain('不完整');
  });

  it('完全无关的文本：仍提示不是合法 JSON', () => {
    const preview = subscriptionParser.parse('hello, this is not json at all', OPTS);
    const issue = preview.globalIssues[0];

    expect(issue?.code).toBe('PARSE_JSON');
    expect(issue?.message).toBe('内容不是合法 JSON');
  });

  it('注释 + 折行同时存在：两层容错都生效', () => {
    const both = [
      '{ "sites": [',
      '{"key":"ok-1","name":"正常","type":1,"api":"https://a.com"},',
      '// 被注释掉的源',
      '{"key":"wrapped","name":"被折',
      '行的名称","type":3,"api":"https://b.com"},',
      '{"key":"ok-2","name":"第二条","type":3,"api":"https://c.com"}',
      ']}',
    ].join('\n');

    const preview = subscriptionParser.parse(both, OPTS);

    expect(preview.total).toBe(3);
    expect(preview.entries.map((e) => e.key)).toEqual(['ok-1', 'wrapped', 'ok-2']);
    // 折行拼接后名称恢复完整
    expect(preview.entries[1]?.name).toBe('被折行的名称');
    expect(preview.entries.every((e) => e.valid)).toBe(true);
    const info = preview.globalIssues.find((i) => i.code === 'RELAXED_JSON');
    expect(info?.message).toContain('注释');
    expect(info?.message).toContain('折行');
  });

  it('仅折行（无注释）：自动拼接并提示', () => {
    const wrapped = [
      '{ "sites": [',
      '{"key":"a","name":"带引',
      '号的名称","type":1,"api":"https://a.com"}',
      ']}',
    ].join('\n');

    const preview = subscriptionParser.parse(wrapped, OPTS);

    expect(preview.total).toBe(1);
    expect(preview.entries[0]?.name).toBe('带引号的名称');
    expect(preview.entries[0]?.valid).toBe(true);
    expect(preview.globalIssues.some((i) => i.code === 'RELAXED_JSON')).toBe(true);
  });

  it('合法 JSON 里的转义引号不会被误当折行', () => {
    const withEscapes = JSON.stringify({
      sources: [
        { key: 'a', name: '他说"你好"然后走了', type: 1, api: 'https://a.com' },
        { key: 'b', name: '反斜杠\\结尾', type: 3, api: 'https://b.com' },
        { key: 'c', name: 'URL 带 //', type: 1, api: 'https://c.com/a//b?x=//y' },
      ],
    });

    const preview = subscriptionParser.parse(withEscapes, OPTS);

    expect(preview.total).toBe(3);
    expect(preview.entries.every((e) => e.valid)).toBe(true);
    // 严格解析成功，不走容错
    expect(preview.globalIssues.some((i) => i.code === 'RELAXED_JSON')).toBe(false);
  });

  it('注释文件里的有效条目全部保留', () => {
    const many = [
      '{ "sites": [',
      Array.from({ length: 30 }, (_, i) => `{"key":"k${i}","name":"源${i}","type":1,"api":"https://s${i}.com"}`).join(',\n'),
      ...Array.from({ length: 20 }, (_, i) => `// 被注释掉的第 ${i} 条`),
      ']}',
    ].join('\n');

    const preview = subscriptionParser.parse(many, OPTS);

    expect(preview.total).toBe(30);
    expect(preview.entries.filter((e) => e.valid)).toHaveLength(30);
  });
});
