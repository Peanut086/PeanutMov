/**
 * 弹幕 Provider / 服务单测（v1.7 / CHG-22，AC-126）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseBilibiliXml } from '@/services/danmaku/bilibiliXml';
import { bilibiliProvider, clearBilibiliCache } from '@/services/danmaku/bilibili';
import { setDanmuApiBaseUrl, type DanmakuQuery } from '@/services/danmaku/provider';
import { danmakuService, thinComments } from '@/services/danmakuService';
import { httpClient } from '@/sources/base/httpClient';
import { DANMAKU_MIN_COMMENTS } from '@/shared/constants';
import { logger } from '@/shared/logger';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() } as Record<string, unknown>,
}));

/** B 站口径的弹幕条目（弹弹play 与自建聚合源共用同一 `p`/`m` 形态） */
function biliItems(count = DANMAKU_MIN_COMMENTS) {
  return Array.from({ length: count }, (_, index) => ({
    cid: index + 1,
    p: `${index}.00,1,16777215,1001`,
    m: `弹幕${index}`,
  }));
}

const BILI_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<i><chatserver>chat.bilibili.com</chatserver>',
  '<d p="12.34,1,25,16777215,1700000000,0,uid,1">前方高能</d>',
  '<d p="15.00,4,25,16711680,1700000001,0,uid,2">厉害了</d>',
  '<d p="16.20,5,25,255,1700000002,0,uid,3">顶部弹幕</d>',
  '<d p="bad,1,25,255,0,0,uid,4"></d>',
  '</i>',
].join('\n');

/** 各源「搜不到」的最小响应：结构缺失即自然返回 null，不会抛错打断回退链 */
const NO_MATCH: Record<string, unknown> = {
  'api.bilibili.com': { code: -404 },
  'pbaccess.video.qq.com': { ret: 20607 },
  'mobileso.bz.mgtv.com': { code: 0, data: { contents: [] } },
  'mesh.if.iqiyi.com': { code: '0', data: { templates: [] } },
  'search.youku.com': { pageComponentList: [] },
  'so.le.com': '',
  'api.dandanplay.net': { success: true, isMatched: false, matches: [] },
};

function urlHost(url: string): string {
  return new URL(url).host;
}

function host(url: string, target: string): boolean {
  return urlHost(url) === target;
}

describe('parseBilibiliXml（本地 Provider，AC-126）', () => {
  it('解析时间/模式/颜色/文本，空文本跳过', () => {
    const comments = parseBilibiliXml(BILI_XML);
    expect(comments.length).toBe(3);
    expect(comments[0]).toMatchObject({ time: 12.34, mode: 'scroll', color: 0xffffff, text: '前方高能' });
    expect(comments[1]).toMatchObject({ mode: 'bottom', color: 0xff0000 });
    expect(comments[2]).toMatchObject({ mode: 'top' });
  });

  it('xml 实体还原', () => {
    const comments = parseBilibiliXml('<d p="1,1,25,255,0,0,u,1">a &amp; b &lt;c&gt;</d>');
    expect(comments[0]!.text).toBe('a & b <c>');
  });
});

describe('danmakuService 回退链（AC-126）', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  /**
   * 按源域名分派响应，而不是排队列——回退链里插入新源时不必重算每一跳的位置。
   * 未在本用例中显式安排的源统一按「搜不到」静默通过。
   */
  function route(plan: (url: string) => unknown | Error) {
    mockedRequest.mockImplementation(((url: string) => {
      const value = plan(url) ?? NO_MATCH[urlHost(url)] ?? {};
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }) as never);
  }

  beforeEach(() => {
    mockedRequest.mockReset();
    clearBilibiliCache();
    // dandanplay Provider 需凭据（localStorage）；B 站源无凭据恒可用
    globalThis.localStorage?.setItem('peanutmov.danmaku.dandanplay.appId', 'test-app');
    globalThis.localStorage?.setItem('peanutmov.danmaku.dandanplay.secret', 'test-secret');
    // 自建聚合源默认停用，个别用例显式配置基址
    setDanmuApiBaseUrl('');
  });

  it('配置了聚合服务基址时：六个直连源之后、dandanplay 之前命中 danmu-api', async () => {
    setDanmuApiBaseUrl('http://danmu.test');
    const urls: string[] = [];
    route((url) => {
      urls.push(url);
      if (!host(url, 'danmu.test')) return undefined;
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 10001, animeTitle: '狂飙', episodeTitle: '第05集', shift: 0 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        const items = biliItems();
        items[0] = { cid: 1, p: '10.00,1,16777215,[BiliBili]', m: '聚合弹幕' };
        return { count: items.length, comments: items };
      }
      return { success: true, animes: [] };
    });

    const result = await danmakuService.match('狂飙', 2024, 5);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('danmu-api');
    expect(result!.comments[0]).toEqual({ time: 10, mode: 'scroll', color: 0xffffff, text: '聚合弹幕' });
    expect(result!.comments).toHaveLength(DANMAKU_MIN_COMMENTS);
    // 六个直连源排在前面；聚合源命中即停，不再打弹弹play官方接口
    const danmuIdx = urls.findIndex((url) => host(url, 'danmu.test'));
    expect(danmuIdx).toBeGreaterThan(0);
    expect(urls.slice(0, danmuIdx).some((url) => url.includes('api.bilibili.com'))).toBe(true);
    expect(urls.some((url) => url.includes('api.dandanplay.net'))).toBe(false);
  });

  it('未配置基址时 danmu-api 整源跳过：回退链照旧落到 dandanplay', async () => {
    const urls: string[] = [];
    route((url) => {
      urls.push(url);
      if (url.includes('api.dandanplay.net/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 42, animeTitle: '狂飙', episodeTitle: '第06集', shift: 0 }] };
      }
      if (url.includes('api.dandanplay.net/api/v2/comment/')) {
        return { count: biliItems().length, comments: biliItems() };
      }
      return undefined;
    });

    // 集号 6：避开上一个用例写入同一缓存键
    const result = await danmakuService.match('狂飙', 2024, 6);

    expect(result!.provider).toBe('dandanplay');
    expect(urls.some((url) => url.includes('danmu.test'))).toBe(false);
  });

  it('B 站无结果时回退 dandanplay；成功结果写入缓存（二次调用不发请求）', async () => {
    route((url) => {
      if (host(url, 'api.bilibili.com')) return new Error('bilibili down');
      if (host(url, 'pbaccess.video.qq.com')) return new Error('tencent down');
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 42, animeTitle: '庆余年', episodeTitle: '第01集', shift: 3 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        const items = biliItems();
        items[0] = { cid: 1, p: '10.00,1,16777215,1001', m: '前方高能' };
        return { count: items.length, comments: items };
      }
      return undefined;
    });

    const first = await danmakuService.match('庆余年', 2019, 1);
    expect(first).not.toBeNull();
    expect(first!.provider).toBe('dandanplay');
    expect(first!.comments).toHaveLength(DANMAKU_MIN_COMMENTS);
    // ⑤ shift 要穿过服务层交给渲染层（缓存里存原始时间轴）
    expect(first!.offsetSec).toBe(3);

    mockedRequest.mockClear();
    const second = await danmakuService.match('庆余年', 2019, 1);
    expect(second).not.toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('B 站无结果时先走腾讯源，腾讯命中就不再请求后续源', async () => {
    const urls: string[] = [];
    route((url) => {
      urls.push(url);
      if (host(url, 'api.bilibili.com')) return new Error('bilibili down');
      if (host(url, 'pbaccess.video.qq.com')) {
        return { ret: 0, data: { areaBoxList: [{ boxId: 'MainNeed', itemList: [{ doc: { id: 'cover1' }, videoInfo: { title: '庆余年', year: 2019 } }] }] } };
      }
      if (host(url, 'node.video.qq.com')) return { c: { title: '庆余年', video_ids: ['vidEp1', 'vidEp2'] } };
      if (url.includes('/barrage/base/')) return { segment_index: { '0': { segment_start: '0', segment_name: 't/v1/0/30000' } } };
      if (url.includes('/barrage/segment/')) {
        return {
          barrage_list: Array.from({ length: DANMAKU_MIN_COMMENTS }, (_, index) => ({
            content: `腾讯弹幕${index}`,
            time_offset: `${index * 5000}`,
          })),
        };
      }
      return undefined;
    });

    // 集号 2：避开上一个用例写入同一缓存键
    const result = await danmakuService.match('庆余年', 2019, 2);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('tencent');
    expect(result!.comments).toHaveLength(DANMAKU_MIN_COMMENTS);
    expect(result!.comments[0]).toEqual({ time: 0, mode: 'scroll', color: 0xffffff, text: '腾讯弹幕0' });
    // B 站 1 跳 + 腾讯 4 跳，命中即停
    expect(urls).toHaveLength(5);
    expect(urls.some((url) => url.includes('dandanplay'))).toBe(false);
  });

  it('导入本地 xml 直写本集缓存：之后的 match 命中它，不再发请求', async () => {
    route(() => new Error('任何源都不该被调用'));

    const xml = '<?xml version="1.0" encoding="UTF-8"?><i><d p="5.00,1,16717055,10001">本地弹幕</d></i>';
    const count = await danmakuService.importLocalXml(
      '只有本地弹幕的剧',
      2024,
      2,
      new File([xml], 'a.xml', { type: 'text/xml' }),
    );
    expect(count).toBe(1);

    const match = await danmakuService.match('只有本地弹幕的剧', 2024, 2);
    expect(match?.provider).toBe('local-xml');
    expect(match?.comments[0]?.text).toBe('本地弹幕');
  });

  it('解析不出弹幕的文件返回 0 条，不写坏缓存', async () => {
    const count = await danmakuService.importLocalXml(
      '无法解析的剧',
      2024,
      3,
      new File(['根本不是 xml'], 'a.xml', { type: 'text/xml' }),
    );
    expect(count).toBe(0);

    route(() => undefined);
    expect(await danmakuService.match('无法解析的剧', 2024, 3)).toBeNull();
  });

  it('远端题名与查询片名不符时不采用（防串片）', async () => {
    route((url) => {
      if (host(url, 'api.bilibili.com') || host(url, 'pbaccess.video.qq.com')) return new Error('network down');
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 1, animeTitle: '完全无关的片', episodeTitle: '第01集', shift: 0 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        return { count: biliItems().length, comments: biliItems() };
      }
      return undefined;
    });

    const result = await danmakuService.match('伪装者', 2015, 1);

    expect(result).toBeNull();
  });

  it('命中题名带季号而查询没有时判为串片（士兵突击 ↔ 士兵突击 第2季）', async () => {
    route((url) => {
      if (host(url, 'api.bilibili.com') || host(url, 'pbaccess.video.qq.com')) return new Error('network down');
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 1, animeTitle: '士兵突击 第2季', episodeTitle: '第01集', shift: 0 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        return { count: biliItems().length, comments: biliItems() };
      }
      return undefined;
    });

    expect(await danmakuService.match('士兵突击', 2013, 1)).toBeNull();
  });

  it('查询自带季号时，命中同季仍采用', async () => {
    route((url) => {
      if (host(url, 'api.bilibili.com') || host(url, 'pbaccess.video.qq.com')) return new Error('network down');
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 1, animeTitle: '士兵突击 第2季', episodeTitle: '第01集', shift: 0 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        return { count: biliItems().length, comments: biliItems() };
      }
      return undefined;
    });

    const result = await danmakuService.match('士兵突击 第2季', 2013, 1);
    expect(result?.provider).toBe('dandanplay');
  });

  it('整集条数低于门槛视为未命中：继续回退且不写缓存', async () => {
    let comments = biliItems(2);
    route((url) => {
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 7, animeTitle: '残料剧', episodeTitle: '第01集', shift: 0 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        return { count: comments.length, comments };
      }
      return undefined;
    });

    expect(await danmakuService.match('残料剧', 2024, 1)).toBeNull();
    // 同一套接线只改条数就能命中，证明拦下来的是门槛而不是用例写错了；
    // 且门槛不过不能落缓存——否则这里会取到先前那 2 条。
    comments = biliItems();
    const second = await danmakuService.match('残料剧', 2024, 1);
    expect(second?.provider).toBe('dandanplay');
    expect(second?.comments).toHaveLength(DANMAKU_MIN_COMMENTS);
  });

  it('命中时留一条 info 日志（源 + 题名 + 集号 + 条数 + 偏移）', async () => {
    route((url) => {
      if (url.includes('/api/v2/match')) {
        return { success: true, isMatched: true, matches: [{ episodeId: 8, animeTitle: '命中日志剧', episodeTitle: '第01集', shift: 3 }] };
      }
      if (url.includes('/api/v2/comment/')) {
        return { count: biliItems().length, comments: biliItems() };
      }
      return undefined;
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await danmakuService.match('命中日志剧', 2019, 1);

    expect(info).toHaveBeenCalledWith(
      '弹幕命中',
      expect.objectContaining({
        provider: 'dandanplay',
        matchedTitle: '命中日志剧',
        episode: 1,
        count: DANMAKU_MIN_COMMENTS,
        offsetSec: 3,
      }),
    );
    info.mockRestore();
  });

  it('全失败落本地 xml', async () => {
    mockedRequest.mockRejectedValue(new Error('network down'));
    const result = await danmakuService.match('棋魂', null, 1, () => BILI_XML);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('local-xml');
    expect(result!.comments.length).toBe(3);
  });

  it('dedupe：同文本 ±1s 合并', () => {
    const merged = danmakuService.dedupe([
      { time: 10.1, mode: 'scroll', color: 0, text: '哈哈哈' },
      { time: 10.5, mode: 'scroll', color: 0, text: '哈哈哈' },
      { time: 11.6, mode: 'scroll', color: 0, text: '哈哈哈' },
    ]);
    expect(merged.length).toBe(2);
  });
});

describe('场景标记（预取不做补量扇出）', () => {
  it('实时播放传 playback，预取传 prefetch 到 Provider 的 DanmakuQuery.scene', async () => {
    const title = '场景标记专用剧';
    const seen: Array<DanmakuQuery['scene']> = [];
    const spy = vi.spyOn(bilibiliProvider, 'match').mockImplementation(
      (async (query: DanmakuQuery) => {
        seen.push(query.scene);
        return { comments: biliItems(), matchedTitle: title };
      }) as never,
    );

    // 两次用不同集号：第一次已写缓存，第二次会直接命中而走不到 Provider
    await danmakuService.match(title, 2019, 1);
    await danmakuService.prefetch(title, 2019, 2);

    // 预取不能靠"没缓存"侥幸少发请求：scene 必须由 prefetch 显式带上
    expect(seen).toEqual(['playback', 'prefetch']);
    spy.mockRestore();
  });
});

describe('thinComments（单集上限抽稀）', () => {
  it('超过上限时均匀抽稀，覆盖整集时间轴', () => {
    const input = Array.from({ length: 25_000 }, (_, index) => ({
      time: index * 0.1,
      mode: 'scroll' as const,
      color: 0,
      text: `c${index}`,
    }));

    const out = thinComments(input);

    expect(out.length).toBe(10_000);
    expect(out[0]!.time).toBe(0);
    expect(out[out.length - 1]!.time).toBeGreaterThan(2400);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.time).toBeGreaterThanOrEqual(out[i - 1]!.time);
    }
  });

  it('未超过上限时原样返回', () => {
    const input = [{ time: 1, mode: 'scroll' as const, color: 0, text: 'a' }];
    expect(thinComments(input)).toBe(input);
  });
});
