import { describe, expect, it } from 'vitest';

import { subscriptionParser } from '@/services/subscriptionParser';
import type { ImportPreview } from '@/types';

/**
 * 爬虫源（TVBox `type: 3` + `csp_`/`py_` 类名）解析
 *
 * 覆盖：类名/JS 脚本改判为 `spider`、jar 来源（条目自带 / 顶层 spider）、
 * 缺 jar 判错、非 JSON ext 不告警、与既有 `site`/`alist` 规则不冲突。
 */
const OPTS = { origin: 'url' as const, sourceUrl: 'https://example.com/sub.json' };

function parseJson(value: unknown): ImportPreview {
  return subscriptionParser.parse(JSON.stringify(value), OPTS);
}

function spiderExtOf(preview: ImportPreview, index: number) {
  return preview.entries[index]?.normalized?.ext as
    | { kind?: string; api?: string | null; jarUrl?: string | null; initExt?: string }
    | undefined;
}

describe('订阅解析：爬虫源（type 3 改判 spider）', () => {
  it('api 为 csp_ 类名 → spider，jar 来自条目自身', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'xbpq',
          name: '耐看影视',
          type: 3,
          api: 'csp_XBPQ',
          jar: 'https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar;md5;bb155c3f0133bbce4756ad52003f5968',
          ext: 'http://xiaohu.xzam.cn/XBPQ/nk.json',
          searchable: 1,
        },
      ],
    });

    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.type).toBe('spider');
    // baseUrl 用 jar 地址占位（爬虫源没有站点根地址），保留 md5 前的纯 URL
    expect(entry?.baseUrl).toBe('https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar');

    const ext = spiderExtOf(preview, 0);
    expect(ext?.kind).toBe('jar');
    expect(ext?.api).toBe('csp_XBPQ');
    expect(ext?.jarUrl).toContain(';md5;');
    expect(ext?.initExt).toBe('http://xiaohu.xzam.cn/XBPQ/nk.json');
  });

  it('py_ 类名同样识别为 jar 爬虫', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'cctv',
          name: '央视少儿',
          type: 3,
          api: 'py_cctv_full',
          jar: 'http://rihou.vip:88/hccx/HeChengChaXiu.jar',
        },
      ],
    });
    expect(preview.entries[0]?.type).toBe('spider');
    expect(preview.entries[0]?.valid).toBe(true);
    expect(spiderExtOf(preview, 0)?.kind).toBe('jar');
  });

  it('条目缺 jar 时回落到订阅顶层 spider', () => {
    const preview = parseJson({
      spider: 'https://fs.example.com/fan.txt;md5;c3e8c08b4cd6f7fd0f868ea48dd42cb2',
      sites: [{ key: 'bili', name: '哔哩合集', type: 3, api: 'csp_Bili', searchable: 0 }],
    });

    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.type).toBe('spider');
    const ext = spiderExtOf(preview, 0);
    expect(ext?.jarUrl).toBe('https://fs.example.com/fan.txt;md5;c3e8c08b4cd6f7fd0f868ea48dd42cb2');
    expect(ext?.api).toBe('csp_Bili');
  });

  it('条目 jar 优先于顶层 spider', () => {
    const preview = parseJson({
      spider: 'https://global.example.com/fan.jar',
      sites: [
        { key: 'x', name: 'X', type: 3, api: 'csp_SeedHub', jar: 'https://agit.example.com/83.jar' },
      ],
    });
    expect(spiderExtOf(preview, 0)?.jarUrl).toBe('https://agit.example.com/83.jar');
  });

  it('jar 缺失（条目与顶层都没有）→ MISSING_FIELD，该条跳过', () => {
    const preview = parseJson({
      sites: [{ key: 'x', name: '无 jar', type: 3, api: 'csp_PanSou' }],
    });
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(false);
    expect(entry?.selected).toBe(false);
    expect(entry?.issues.some((i) => i.code === 'MISSING_FIELD' && i.field === 'jar')).toBe(true);
  });

  it('jar 地址非法 → URL_INVALID', () => {
    const preview = parseJson({
      sites: [{ key: 'x', name: '坏 jar', type: 3, api: 'csp_X', jar: 'ftp://a.com/1.jar' }],
    });
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(false);
    expect(entry?.issues.some((i) => i.code === 'URL_INVALID' && i.field === 'jar')).toBe(true);
  });

  it('api 是 drpy JS 脚本（非豆瓣规则）→ spider(kind=js)，带告警但不阻断', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'drpy',
          name: '某 JS 爬虫源',
          type: 3,
          api: 'https://example.com/lib/drpy2.min.js',
          ext: 'https://example.com/js/some-site.js',
        },
      ],
    });

    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.type).toBe('spider');
    expect(entry?.warning).toContain('JS 爬虫');
    const ext = spiderExtOf(preview, 0);
    expect(ext?.kind).toBe('js');
    expect(ext?.api).toBe(null);
    expect(ext?.jarUrl).toBe(null);
    expect(ext?.initExt).toBe('https://example.com/js/some-site.js');
  });

  it('豆瓣类 drpy 规则 → douban 类型（TS 原生实现，播放跨源借 CMS）', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'drpy_js_豆瓣',
          name: '🔥聚玩盒子4K',
          type: 3,
          api: 'https://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/drpy2.min.js',
          ext: 'https://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/douban.js',
        },
      ],
    });

    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.type).toBe('douban');
    // 豆瓣源能浏览，不再给「无法浏览」的告警
    expect(entry?.warning).toBe(null);
    const ext = spiderExtOf(preview, 0);
    expect(ext?.kind).toBe('douban');
    expect(ext?.api).toBe(null);
    expect(ext?.jarUrl).toBe(null);
  });

  it('爬虫的非 JSON ext（TVBox key:value 纯文本）不产生 warning', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'panda',
          name: '短剧',
          type: 3,
          api: 'csp_Panda',
          jar: 'http://like.example.com/PandaQ231205.jar',
          ext: '分类url:http://web.example.com/vod/show/id/{cateId}/page/{catePg}.html,分类:快手$2#抖音$3',
        },
      ],
    });
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.warning).toBe(null);
    expect(spiderExtOf(preview, 0)?.initExt).toContain('分类url:');
  });

  it('ext 是对象时序列化后传给爬虫', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'xbpq',
          name: '夸克影视',
          type: 3,
          api: 'csp_XBPQ',
          jar: 'https://a.example.com/1.jar',
          ext: { 分类url: 'https://freeok.vip/vod-show/{cateId}.html', 分类: 'FREE电影&FREE剧集' },
        },
      ],
    });
    const initExt = spiderExtOf(preview, 0)?.initExt ?? '';
    expect(() => JSON.parse(initExt)).not.toThrow();
    expect(initExt).toContain('分类url');
  });

  it('不影响既有映射：type 3 + http(s) 非 JS 仍是 alist', () => {
    const preview = parseJson({
      sites: [
        { key: 'a', name: 'AList', type: 3, api: 'https://alist.example.com' },
        { key: 's', name: '站点', type: 1, api: 'https://cms.example.com/api.php/provide/vod/' },
        { key: 'w', name: 'WebDAV', type: 4, api: 'https://nas.example.com/dav' },
      ],
    });
    expect(preview.entries.map((e) => e.type)).toEqual(['alist', 'site', 'webdav']);
    expect(preview.entries.every((e) => e.valid)).toBe(true);
  });

  it('字符串类型 "spider" 直接映射', () => {
    const preview = parseJson({
      sources: [
        { key: 'x', name: '爬虫', type: 'spider', api: 'csp_XBPQ', jar: 'https://a.example.com/1.jar' },
      ],
    });
    expect(preview.entries[0]?.type).toBe('spider');
    expect(preview.entries[0]?.valid).toBe(true);
  });

  it('混合订阅：爬虫与站点源共存，各自判定互不影响', () => {
    const preview = parseJson({
      spider: 'https://global.example.com/fan.jar',
      sites: [
        { key: 'cms', name: '豪华资源', type: 1, api: 'https://hhzyapi.com/api.php/provide/vod' },
        { key: 'jar', name: '磁力4K', type: 3, api: 'csp_SeedHub', jar: 'https://a.example.com/83.jar' },
        { key: 'js', name: '直播', type: 3, api: 'https://a.example.com/JustLive.js' },
        // 空 jar 串回落到顶层 spider（订阅作者用它"注释掉"某个 jar）
        { key: 'no-jar', name: '盘搜', type: 3, api: 'csp_PanSou', jar: '' },
      ],
    });

    const byKey = new Map(preview.entries.map((e) => [e.key, e]));
    expect(byKey.get('cms')?.type).toBe('site');
    expect(byKey.get('cms')?.valid).toBe(true);
    expect(byKey.get('jar')?.type).toBe('spider');
    expect(byKey.get('jar')?.valid).toBe(true);
    expect(byKey.get('js')?.type).toBe('spider');
    expect(byKey.get('js')?.valid).toBe(true);
    expect(byKey.get('no-jar')?.type).toBe('spider');
    expect(byKey.get('no-jar')?.valid).toBe(true);
    expect(spiderExtOf(preview, 3)?.jarUrl).toBe('https://global.example.com/fan.jar');
  });

  it('顶层 spider 也缺失时空 jar 串 → 判错', () => {
    const preview = parseJson({
      sites: [{ key: 'x', name: '盘搜', type: 3, api: 'csp_PanSou', jar: '' }],
    });
    expect(preview.entries[0]?.valid).toBe(false);
    expect(preview.entries[0]?.issues.some((i) => i.code === 'MISSING_FIELD' && i.field === 'jar')).toBe(true);
  });
});
