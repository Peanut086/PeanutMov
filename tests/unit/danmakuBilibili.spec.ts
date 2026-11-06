/**
 * B 站直连弹幕源单测：wbi 签名、片名/集号匹配、空结果处理
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bilibiliProvider, clearBilibiliCache } from '@/services/danmaku/bilibili';
import { md5 } from '@/services/danmaku/md5';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

const NAV_RESPONSE = {
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

const DM_XML = [
  '<i>',
  '<d p="12.34,1,25,16777215,1700000000,0,uid,1">前方高能</d>',
  '<d p="15.00,4,25,16711680,1700000001,0,uid,2">厉害了</d>',
  '</i>',
].join('\n');

function searchResponse(title: string, seasonId: number) {
  return { code: 0, data: { result: [{ title: `<em class="keyword">${title}</em>`, season_id: seasonId }] } };
}

function seasonResponse(title: string, episodes: Array<{ title: string; cid: number }>) {
  return { code: 0, result: { title, episodes } };
}

describe('md5', () => {
  it('标准测试向量', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
});

describe('bilibiliProvider', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  beforeEach(() => {
    mockedRequest.mockReset();
    clearBilibiliCache();
  });

  it('搜索→分集→弹幕，返回匹配题名', async () => {
    mockedRequest
      .mockResolvedValueOnce(NAV_RESPONSE)
      .mockResolvedValueOnce(searchResponse('庆余年', 1234))
      .mockResolvedValueOnce(seasonResponse('庆余年', [{ title: '1', cid: 555 }, { title: '2', cid: 556 }]))
      .mockResolvedValueOnce(DM_XML);

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('庆余年');
    expect(result!.comments).toHaveLength(2);
    expect(result!.comments[1]).toMatchObject({ mode: 'bottom', text: '厉害了' });
    expect(mockedRequest.mock.calls[3]?.[0]).toContain('oid=555');
  });

  it('搜索请求带 wbi 签名（wts + w_rid）', async () => {
    mockedRequest
      .mockResolvedValueOnce(NAV_RESPONSE)
      .mockResolvedValueOnce(searchResponse('庆余年', 1234))
      .mockResolvedValueOnce(seasonResponse('庆余年', [{ title: '1', cid: 555 }]))
      .mockResolvedValueOnce(DM_XML);

    await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    const url = mockedRequest.mock.calls[1]?.[0] ?? '';
    const query = new URL(url).searchParams;
    expect(query.get('wts')).toMatch(/^\d+$/);
    expect(query.get('w_rid')).toMatch(/^[0-9a-f]{32}$/);
    expect(query.get('keyword')).toBe('庆余年');
  });

  it('片名归一化后不完全相等时不采用（防串片）', async () => {
    mockedRequest
      .mockResolvedValueOnce(NAV_RESPONSE)
      .mockResolvedValueOnce(searchResponse('伪装者2', 9))
      .mockResolvedValueOnce({ code: 0, data: { result: [] } });

    const result = await bilibiliProvider.match({ title: '伪装者', year: 2015, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(3); // nav + 番剧库 + 影视库，未请求季
  });

  it('集号越界返回 null', async () => {
    mockedRequest
      .mockResolvedValueOnce(NAV_RESPONSE)
      .mockResolvedValueOnce(searchResponse('庆余年', 1234))
      .mockResolvedValueOnce(seasonResponse('庆余年', [{ title: '1', cid: 555 }]));

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 5 });

    expect(result).toBeNull();
  });

  it('本集没有弹幕返回 null', async () => {
    mockedRequest
      .mockResolvedValueOnce(NAV_RESPONSE)
      .mockResolvedValueOnce(searchResponse('庆余年', 1234))
      .mockResolvedValueOnce(seasonResponse('庆余年', [{ title: '1', cid: 555 }]))
      .mockResolvedValueOnce('<i></i>');

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result).toBeNull();
  });
});
