import { describe, expect, it } from 'vitest';

import { stripLocalProxyPrefix, subscriptionParser } from '@/services/subscriptionParser';
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

/**
 * TVBox 相对路径补全（以订阅 URL 为基准）：
 * fty.json 式订阅的 spider/jar/api/ext 大量使用 `./` 相对引用，
 * 不补全会误报「jar 地址不合法」「ext 不是合法 JSON」。
 */
describe('订阅解析：相对路径按订阅 URL 补全', () => {
  it('顶层 spider 相对路径 → 补全为绝对地址，;md5; 后缀原样保留', () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({
        spider: './jar/fan.txt;md5;b55978c4fe6d12e2fea9075f17c8a67a',
        sites: [{ key: 'dukou', name: '毒口', type: 3, api: 'csp_DukouGuard' }],
      }),
      OPTS,
    );
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(spiderExtOf(preview, 0)?.jarUrl).toBe(
      'https://example.com/jar/fan.txt;md5;b55978c4fe6d12e2fea9075f17c8a67a',
    );
  });

  it('条目自带相对 jar 同样补全', () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({
        sites: [{ key: 'x', name: 'X', type: 3, api: 'csp_X', jar: './jar/custom.jar' }],
      }),
      OPTS,
    );
    expect(preview.entries[0]?.valid).toBe(true);
    expect(spiderExtOf(preview, 0)?.jarUrl).toBe('https://example.com/jar/custom.jar');
  });

  it('相对 drpy api + 相对 ext 规则 → spider(kind=js)，ext 补全，不再误报 ext 非法 JSON', () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({
        sites: [
          {
            key: '斗鱼js',
            name: '🐟斗鱼┃直播',
            type: 3,
            api: './FTY/drpy2.min.js',
            ext: './FTY/斗鱼直播.js',
          },
        ],
      }),
      OPTS,
    );
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(true);
    expect(entry?.type).toBe('spider');
    expect(entry?.baseUrl).toBe('https://example.com/FTY/drpy2.min.js');
    const ext = spiderExtOf(preview, 0);
    expect(ext?.kind).toBe('js');
    expect(ext?.initExt).toBe('https://example.com/FTY/%E6%96%97%E9%B1%BC%E7%9B%B4%E6%92%AD.js');
    expect(entry?.issues.some((i) => i.message.includes('ext 不是合法 JSON'))).toBe(false);
  });

  it('相对 drpy api + 相对豆瓣规则 → douban 类型', () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({
        sites: [
          { key: 'db', name: '豆瓣', type: 3, api: './lib/drpy2.min.js', ext: './lib/douban.js' },
        ],
      }),
      OPTS,
    );
    expect(preview.entries[0]?.type).toBe('douban');
    expect(preview.entries[0]?.valid).toBe(true);
  });

  it('无基准（文件导入，sourceUrl 为空）时相对路径原样保留并按原有规则判错', () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({
        spider: './jar/fan.txt',
        sites: [{ key: 'x', name: 'X', type: 3, api: 'csp_X' }],
      }),
      { origin: 'file', sourceUrl: null },
    );
    const entry = preview.entries[0];
    expect(entry?.valid).toBe(false);
    expect(entry?.issues.some((i) => i.code === 'URL_INVALID' && i.field === 'jar')).toBe(true);
    // invalid 条目 normalized 为 null；baseUrl 用 jar 地址占位，验证原样保留未补全
    expect(entry?.baseUrl).toBe('./jar/fan.txt');
  });

  it('绝对地址与 csp_ 类名不受补全影响（回归）', () => {
    const preview = parseJson({
      spider: 'https://cdn.example.com/spider.jar;md5;abc',
      sites: [
        {
          key: 'j',
          name: 'J',
          type: 3,
          api: 'csp_XBPQ',
          ext: '分类url:https://a.com/x,分类:电影',
        },
        { key: 's', name: 'S', type: 1, api: 'https://cms.example.com/api.php/provide/vod' },
      ],
    });
    expect(spiderExtOf(preview, 0)?.jarUrl).toBe('https://cdn.example.com/spider.jar;md5;abc');
    expect(spiderExtOf(preview, 0)?.initExt).toContain('分类url:');
    expect(preview.entries[1]?.type).toBe('site');
    expect(preview.entries[1]?.baseUrl).toBe('https://cms.example.com/api.php/provide/vod');
  });
});

/**
 * TVBox 本地代理前缀：`http://127.0.0.1:<port>/p/<n>/proxy/<真实地址>`
 *
 * 实测 PG 订阅 6 个 CMS 源里 5 个被这样包装。PeanutMov 没有本地代理进程，
 * 原样保留会让源指向本机空端口（导入即死），解析时必须还原真实地址。
 */
describe('订阅解析：剥离本地代理前缀', () => {
  it('127.0.0.1 代理前缀被剥离（CMS 源）', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'bfzy',
          name: '暴風',
          type: 1,
          api: 'http://127.0.0.1:10079/p/0/proxy/https://bfzyapi.com/api.php/provide/vod?',
        },
      ],
    });
    // normalizeBaseUrl 会去掉末尾的 `?`（站点地址归一化既有行为）
    expect(preview.entries[0]?.baseUrl).toBe('https://bfzyapi.com/api.php/provide/vod');
  });

  it('jar 地址的代理前缀同样剥离，md5 后缀保留', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'p',
          name: 'P',
          type: 3,
          api: 'csp_XBPQ',
          jar: 'http://127.0.0.1:9978/p/1/proxy/https://cdn.example.com/a.jar;md5;deadbeef',
        },
      ],
    });
    expect(spiderExtOf(preview, 0)?.jarUrl).toBe('https://cdn.example.com/a.jar;md5;deadbeef');
  });

  it('URL 编码的内层地址被解码', () => {
    const preview = parseJson({
      sites: [
        {
          key: 'enc',
          name: 'Enc',
          type: 1,
          api: 'http://127.0.0.1:10079/p/0/proxy/https%3A%2F%2Fsuoniapi.com%2Fapi.php%2Fprovide%2Fvod',
        },
      ],
    });
    expect(preview.entries[0]?.baseUrl).toBe('https://suoniapi.com/api.php/provide/vod');
  });

  it('非回环 host 的代理地址保持原样（可能是用户网络里的真实代理）', () => {
    const raw = 'http://10.0.0.5:10079/p/0/proxy/https://example.com/api.php';
    expect(stripLocalProxyPrefix(raw)).toBe(raw);
  });

  it('普通地址不受影响', () => {
    expect(stripLocalProxyPrefix('https://a.com/api.php')).toBe('https://a.com/api.php');
    expect(stripLocalProxyPrefix('http://127.0.0.1:8080/other/path')).toBe(
      'http://127.0.0.1:8080/other/path',
    );
  });
});
