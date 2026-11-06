/**
 * 弹幕 Provider / 服务单测（v1.7 / CHG-22，AC-126）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseBilibiliXml } from '@/services/danmaku/bilibiliXml';
import { clearBilibiliCache } from '@/services/danmaku/bilibili';
import { danmakuService, thinComments } from '@/services/danmakuService';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

const BILI_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<i><chatserver>chat.bilibili.com</chatserver>',
  '<d p="12.34,1,25,16777215,1700000000,0,uid,1">前方高能</d>',
  '<d p="15.00,4,25,16711680,1700000001,0,uid,2">厉害了</d>',
  '<d p="16.20,5,25,255,1700000002,0,uid,3">顶部弹幕</d>',
  '<d p="bad,1,25,255,0,0,uid,4"></d>',
  '</i>',
].join('\n');

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

  beforeEach(() => {
    mockedRequest.mockReset();
    clearBilibiliCache();
    // dandanplay Provider 需凭据（localStorage）；B 站源无凭据恒可用
    globalThis.localStorage?.setItem('peanutmov.danmaku.dandanplay.appId', 'test-app');
    globalThis.localStorage?.setItem('peanutmov.danmaku.dandanplay.secret', 'test-secret');
  });

  it('B 站无结果时回退 dandanplay；成功结果写入缓存（二次调用不发请求）', async () => {
    mockedRequest
      .mockRejectedValueOnce(new Error('bilibili down')) // B 站源失败
      .mockRejectedValueOnce(new Error('tencent down')) // 腾讯源也失败 → 回退 dandanplay
      .mockResolvedValueOnce({ matched: true, matches: [{ animeTitle: '庆余年', episodes: [{ episodeId: 42, episodeTitle: '第01集' }] }] })
      .mockResolvedValueOnce({ count: 1, comments: [[10, 1, 16777215, '前方高能']] });

    const first = await danmakuService.match('庆余年', 2019, 1);
    expect(first).not.toBeNull();
    expect(first!.provider).toBe('dandanplay');
    expect(first!.comments.length).toBe(1);

    mockedRequest.mockClear();
    const second = await danmakuService.match('庆余年', 2019, 1);
    expect(second).not.toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('B 站无结果时先走腾讯源，腾讯命中就不再请求 dandanplay', async () => {
    mockedRequest
      .mockRejectedValueOnce(new Error('bilibili down'))
      .mockResolvedValueOnce({
        ret: 0,
        data: {
          areaBoxList: [
            { boxId: 'MainNeed', itemList: [{ doc: { id: 'cover1' }, videoInfo: { title: '庆余年', year: 2019 } }] },
          ],
        },
      })
      .mockResolvedValueOnce({ c: { title: '庆余年', video_ids: ['vidEp1', 'vidEp2'] } })
      .mockResolvedValueOnce({ segment_index: { '0': { segment_start: '0', segment_name: 't/v1/0/30000' } } })
      .mockResolvedValueOnce({ barrage_list: [{ content: '腾讯弹幕', time_offset: '5000' }] });

    // 集号 2：避开上一个用例写入同一缓存键
    const result = await danmakuService.match('庆余年', 2019, 2);

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('tencent');
    expect(result!.comments).toEqual([{ time: 5, mode: 'scroll', color: 0xffffff, text: '腾讯弹幕' }]);
    expect(mockedRequest).toHaveBeenCalledTimes(5);
  });

  it('远端题名与查询片名不符时不采用（防串片）', async () => {
    mockedRequest
      .mockRejectedValueOnce(new Error('nav down'))
      .mockRejectedValueOnce(new Error('tencent down'))
      .mockResolvedValueOnce({ matched: true, matches: [{ animeTitle: '完全无关的片', episodes: [{ episodeId: 1, episodeTitle: '第01集' }] }] })
      .mockResolvedValueOnce({ count: 1, comments: [[1, 1, 16777215, '弹幕']] });
    const result = await danmakuService.match('伪装者', 2015, 1);
    expect(result).toBeNull();
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
