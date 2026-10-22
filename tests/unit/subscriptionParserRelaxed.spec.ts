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

  it('剥离注释仍失败：给出"未转义换行/缺失引号"诊断', () => {
    const broken = `{
  "sites": [
    { "key": "a", "name": "A", "type": 3, "api": "https://a.com" },
    { "key": "b", "name": "被折
行的名称", "type": 3, "api": "https://b.com" }
  ]
}`;
    const preview = subscriptionParser.parse(broken, OPTS);

    expect(preview.entries).toHaveLength(0);
    const issue = preview.globalIssues[0];
    expect(issue?.code).toBe('PARSE_JSON');
    expect(issue?.message).toContain('换行');
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
