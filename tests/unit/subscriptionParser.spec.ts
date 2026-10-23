import { describe, expect, it } from 'vitest';

import { subscriptionParser, mapSourceType } from '@/services/subscriptionParser';
import type { ImportPreview } from '@/types';

const OPTS = { origin: 'url' as const, sourceUrl: 'https://example.com/sub.json' };

function parseJson(value: unknown, origin: 'url' | 'file' = 'url'): ImportPreview {
  return subscriptionParser.parse(JSON.stringify(value), { ...OPTS, origin });
}

describe('订阅解析（AC-09 / AC-10 / AC-13 / AC-104）', () => {
  it('简化格式 sources[]：字段映射与默认值', () => {
    const preview = parseJson({
      name: '我的订阅',
      version: 1,
      sources: [
        {
          key: 'home-alist',
          name: '家里 AList',
          type: 'alist',
          api: 'https://alist.example.com/',
          ext: { username: 'reader', password: 'secret', root: '/Movies' },
          headers: { 'User-Agent': 'Mozilla/5.0' },
        },
      ],
    });

    expect(preview.name).toBe('我的订阅');
    expect(preview.total).toBe(1);
    expect(preview.globalIssues).toHaveLength(0);
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.selected).toBe(true);
    expect(entry?.type).toBe('alist');
    // 地址归一化（去尾斜杠）
    expect(entry?.baseUrl).toBe('https://alist.example.com');
    expect(entry?.normalized?.ext).toMatchObject({ username: 'reader', root: '/Movies', searchable: true });
    expect(entry?.normalized?.headers).toEqual({ 'User-Agent': 'Mozilla/5.0' });
  });

  it('TVBox sites[]：数字类型映射 0/1/3/4/5', () => {
    const preview = parseJson({
      sites: [
        { key: 'a', name: '站点', type: 1, api: 'https://site.example.com/api.php/provide/vod/' },
        { key: 'b', name: 'AList', type: 3, api: 'https://alist.example.com' },
        { key: 'c', name: 'WebDAV', type: 4, api: 'https://nas.example.com/dav' },
        { key: 'd', name: 'Jellyfin', type: 5, api: 'https://jf.example.com' },
        { key: 'e', name: '零号', type: 0, api: 'https://zero.example.com' },
      ],
    });
    expect(preview.entries.map((entry) => entry.type)).toEqual([
      'site',
      'alist',
      'webdav',
      'jellyfin',
      'site',
    ]);
    expect(preview.entries.every((entry) => entry.valid)).toBe(true);
  });

  it('TVBox ext 为字符串 JSON 时可解析；非法 JSON 仅告警不阻断', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'a',
          name: '正常',
          type: 3,
          api: 'https://a.example.com',
          ext: '{"username":"u","password":"p"}',
        },
        { key: 'b', name: '坏 ext', type: 3, api: 'https://b.example.com', ext: '{oops' },
      ],
    });
    expect(preview.entries[0]?.normalized?.ext).toMatchObject({ username: 'u' });
    expect(preview.entries[1]?.valid).toBe(true);
    expect(preview.entries[1]?.warning).toContain('ext');
    expect(preview.entries[1]?.normalized?.ext).toBe(null);
  });

  it('缺关键字段逐条跳过，其它条仍合法（AC-13）', () => {
    const preview = parseJson({
      sites: [
        { key: 'ok1', name: '一', type: 1, api: 'https://a.com' },
        { name: '缺 key', type: 1, api: 'https://b.com' },
        { key: 'ok2', name: '二', type: 3, api: 'https://c.com' },
        { key: 'no-api', name: '缺 api', type: 3 },
        { key: 'ok3', name: '三', type: 5, api: 'https://d.com' },
        { key: 'bad-url', name: '地址非法', type: 3, api: 'ftp://e.com' },
        { key: 'ok4', name: '四', type: 4, api: 'https://f.com/dav' },
        { key: 'bad-type', name: '类型未知', type: 99, api: 'https://g.com' },
      ],
    });

    const valid = preview.entries.filter((entry) => entry.valid);
    const invalid = preview.entries.filter((entry) => !entry.valid);
    expect(valid).toHaveLength(4);
    expect(invalid).toHaveLength(4);

    const missingApi = preview.entries.find((entry) => entry.key === 'no-api');
    expect(missingApi?.valid).toBe(false);
    expect(missingApi?.selected).toBe(false);
    expect(missingApi?.issues.some((i) => i.code === 'MISSING_FIELD' && i.message.includes('api'))).toBe(true);

    const badUrl = preview.entries.find((entry) => entry.key === 'bad-url');
    expect(badUrl?.issues.some((i) => i.code === 'URL_INVALID')).toBe(true);

    const badType = preview.entries.find((entry) => entry.key === 'bad-type');
    expect(badType?.issues.some((i) => i.code === 'TYPE_UNKNOWN')).toBe(true);
    expect(badType?.type).toBe('unknown');
  });

  it('同批重复 key：后者 invalid 并标 DUPLICATE_KEY', () => {
    const preview = parseJson({
      sources: [
        { key: 'dup', name: '一', type: 'alist', api: 'https://a.com' },
        { key: 'dup', name: '二', type: 'alist', api: 'https://b.com' },
      ],
    });
    expect(preview.entries[0]?.valid).toBe(true);
    expect(preview.entries[1]?.valid).toBe(false);
    expect(preview.entries[1]?.issues.some((i) => i.code === 'DUPLICATE_KEY')).toBe(true);
  });

  it('非 JSON / 无 sites 与 sources / 空数组 → 全局错误（AC-09、AC-10）', () => {
    const notJson = subscriptionParser.parse('{not json', OPTS);
    expect(notJson.entries).toHaveLength(0);
    expect(notJson.globalIssues[0]?.code).toBe('PARSE_JSON');
    expect(notJson.globalIssues[0]?.message).toContain('JSON');

    const unsupported = subscriptionParser.parse('{"foo":1}', OPTS);
    expect(unsupported.globalIssues[0]?.code).toBe('FORMAT_UNSUPPORTED');

    const empty = parseJson({ sites: [] });
    expect(empty.globalIssues[0]?.code).toBe('EMPTY');
    expect(empty.globalIssues[0]?.message).toBe('订阅中没有任何源');
  });

  it('超过 500 条 → TOO_MANY（AC-10）', () => {
    const sites = Array.from({ length: 501 }, (_, i) => ({
      key: `k${i}`,
      name: `源${i}`,
      type: 1,
      api: 'https://a.com',
    }));
    const preview = parseJson({ sites });
    expect(preview.entries).toHaveLength(0);
    expect(preview.globalIssues[0]?.code).toBe('TOO_MANY');
  });

  it('敏感词命中写入 warning，但不阻断（AC-104）', () => {
    const preview = parseJson({
      sources: [{ key: 'vip-free', name: '免费VIP影视', type: 'site', api: 'https://a.com' }],
    });
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.warning).toContain('敏感词');
  });

  it('id 与 name 保留原始顺序，origin/fileName 写入预览', () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({ sources: [{ key: 'a', name: 'A', type: 'alist', api: 'https://a.com' }] }),
      { origin: 'file', fileName: 'sub.json' },
    );
    expect(preview.origin).toBe('file');
    expect(preview.fileName).toBe('sub.json');
    expect(preview.fetchedAt).toBeGreaterThan(0);
  });

  it('type 字符串大小写不敏感；未知字符串返回 TYPE_UNKNOWN', () => {
    expect(mapSourceType('AList')).toBe('alist');
    expect(mapSourceType('Jellyfin')).toBe('jellyfin');
    expect(mapSourceType('webdav')).toBe('webdav');
    expect(mapSourceType('nope')).toBe(null);
  });

  it('数字 type=2 映射为 site（api 仍须是 http(s)）', () => {
    expect(mapSourceType(2)).toBe('site');

    const preview = parseJson({
      sites: [
        { key: 'cms', name: 'CMS 站点', type: 2, api: 'https://cms.example.com/api.php/provide/vod/' },
        { key: 'spider', name: 'csp 站点', type: 2, api: 'csp_MySpider' },
        { key: 'ftp', name: '非 http 站点', type: 2, api: 'ftp://a.com/x' },
      ],
    });
    expect(preview.entries[0]?.type).toBe('site');
    expect(preview.entries[0]?.valid).toBe(true);
    // `csp_` 类名改判为爬虫源（jar 缺失时判错，不再是 URL_INVALID）
    expect(preview.entries[1]?.type).toBe('spider');
    expect(preview.entries[1]?.valid).toBe(false);
    expect(preview.entries[1]?.issues.some((i) => i.code === 'MISSING_FIELD' && i.field === 'jar')).toBe(true);
    // 既非爬虫类名又非 http(s) 地址 → 仍是 URL_INVALID
    expect(preview.entries[2]?.type).toBe('site');
    expect(preview.entries[2]?.valid).toBe(false);
    expect(preview.entries[2]?.issues.some((i) => i.code === 'URL_INVALID')).toBe(true);
  });

  it('顶层 urls[] 多仓索引 → repos 列表，entries 为空', () => {
    const preview = parseJson({
      name: '我的多仓',
      urls: [
        { url: 'https://a.example.com/box.json', name: 'A 仓' },
        'https://b.example.com/box.json',
        'https://a.example.com/box.json',
        'not-a-url',
      ],
    });

    expect(preview.name).toBe('我的多仓');
    expect(preview.entries).toHaveLength(0);
    expect(preview.total).toBe(0);
    // 只收合法 URL，支持字符串与 { url } 对象，去重保序
    expect(preview.repos).toEqual([
      'https://a.example.com/box.json',
      'https://b.example.com/box.json',
    ]);
    expect(preview.globalIssues[0]?.code).toBe('MULTI_REPO');
    expect(preview.globalIssues[0]?.level).toBe('info');
  });

  it('逐行 URL 文本（dc.txt）也识别为多仓索引', () => {
    const text = [
      'https://a.example.com/box.json',
      '',
      'https://b.example.com/box.json',
    ].join('\n');
    const preview = subscriptionParser.parse(text, OPTS);

    expect(preview.repos).toEqual([
      'https://a.example.com/box.json',
      'https://b.example.com/box.json',
    ]);
    expect(preview.globalIssues[0]?.code).toBe('MULTI_REPO');
  });

  it('普通订阅的 repos 为空', () => {
    const preview = parseJson({
      sources: [{ key: 'a', name: 'A', type: 'alist', api: 'https://a.com' }],
    });
    expect(preview.repos).toEqual([]);
  });
});
