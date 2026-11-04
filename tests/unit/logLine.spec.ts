import { describe, expect, it } from 'vitest';

import {
  extractTags,
  filterByLevel,
  filterByTag,
  formatEntry,
  parseLogText,
  search,
} from '@/shared/logLine';

describe('parseLogText', () => {
  it('解析单行标准格式', () => {
    const text = '2026-11-04 12:00:00.123 D [main] CatVodSpider: hello world\n';
    const entries = parseLogText(text, 'spider.log', 0);
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('D');
    expect(entries[0].thread).toBe('main');
    expect(entries[0].tag).toBe('CatVodSpider');
    expect(entries[0].message).toBe('hello world');
    expect(entries[0].ts).toBeGreaterThan(0);
  });

  it('续行归并到上一条', () => {
    const text =
      '2026-11-04 12:00:00.123 E [main] JS:error: TypeError\n  at foo (bar.js:1)\n  at baz (qux.js:2)\n';
    const entries = parseLogText(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain('TypeError');
    expect(entries[0].message).toContain('at foo');
    expect(entries[0].message).toContain('at baz');
  });

  it('多行多条目', () => {
    const text =
      '2026-11-04 12:00:00.123 D [main] A: first\n2026-11-04 12:00:01.456 W [bridge] B: second\n';
    const entries = parseLogText(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].tag).toBe('A');
    expect(entries[1].tag).toBe('B');
    expect(entries[1].level).toBe('W');
  });

  it('无时间戳行归为独立条目', () => {
    const text = 'orphan line without timestamp\n';
    const entries = parseLogText(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].tag).toBe('-');
    expect(entries[0].message).toBe('orphan line without timestamp');
  });

  it('空文本返回空数组', () => {
    expect(parseLogText('')).toEqual([]);
    expect(parseLogText('\n\n')).toEqual([]);
  });
});

describe('filterByLevel', () => {
  const entries = parseLogText(
    '2026-11-04 12:00:00.123 D [t] A: d\n2026-11-04 12:00:01.123 W [t] B: w\n2026-11-04 12:00:02.123 E [t] C: e\n',
  );

  it('空集合返回全部', () => {
    expect(filterByLevel(entries, new Set())).toHaveLength(3);
  });

  it('单级别过滤', () => {
    expect(filterByLevel(entries, new Set(['E']))).toHaveLength(1);
    expect(filterByLevel(entries, new Set(['E']))[0].tag).toBe('C');
  });

  it('多级别过滤', () => {
    expect(filterByLevel(entries, new Set(['W', 'E']))).toHaveLength(2);
  });
});

describe('filterByTag', () => {
  const entries = parseLogText(
    '2026-11-04 12:00:00.123 D [t] A: 1\n2026-11-04 12:00:01.123 D [t] B: 2\n2026-11-04 12:00:02.123 D [t] A: 3\n',
  );

  it('空集合返回全部', () => {
    expect(filterByTag(entries, new Set())).toHaveLength(3);
  });

  it('单标签过滤', () => {
    expect(filterByTag(entries, new Set(['A']))).toHaveLength(2);
  });
});

describe('search', () => {
  const entries = parseLogText(
    '2026-11-04 12:00:00.123 D [t] A: hello world\n2026-11-04 12:00:01.123 D [t] B: foo bar\n',
  );

  it('空关键字返回全部', () => {
    expect(search(entries, '')).toHaveLength(2);
  });

  it('不区分大小写', () => {
    expect(search(entries, 'HELLO')).toHaveLength(1);
    expect(search(entries, 'hello')).toHaveLength(1);
  });

  it('匹配 tag 或 message', () => {
    expect(search(entries, 'B')).toHaveLength(1);
    expect(search(entries, 'foo')).toHaveLength(1);
  });
});

describe('extractTags', () => {
  it('统计标签出现次数', () => {
    const entries = parseLogText(
      '2026-11-04 12:00:00.123 D [t] A: 1\n2026-11-04 12:00:01.123 D [t] B: 2\n2026-11-04 12:00:02.123 D [t] A: 3\n',
    );
    const tags = extractTags(entries);
    expect(tags.get('A')).toBe(2);
    expect(tags.get('B')).toBe(1);
  });
});

describe('formatEntry', () => {
  it('格式化输出含时间戳和级别', () => {
    const entries = parseLogText('2026-11-04 12:00:00.123 W [main] Test: msg\n');
    const out = formatEntry(entries[0]);
    expect(out).toContain('W');
    expect(out).toContain('Test');
    expect(out).toContain('msg');
    expect(out).toContain('main');
  });
});
