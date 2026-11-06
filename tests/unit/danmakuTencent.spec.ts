/**
 * 腾讯视频直连弹幕源单测：选季/防串片、分片并发与字段映射
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tencentProvider } from '@/services/danmaku/tencent';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

const SEARCH_RESPONSE = {
  ret: 0,
  data: {
    areaBoxList: [
      {
        boxId: 'MainNeed',
        itemList: [
          { doc: { id: 'season3' }, videoInfo: { title: '庆余年第三季', year: 2026, typeName: '电视剧' } },
          { doc: { id: 'season2' }, videoInfo: { title: '庆余年第二季', year: 2024, typeName: '电视剧' } },
          { doc: { id: 'rjae621myqca41h' }, videoInfo: { title: '<em>庆余年</em>', year: 2019, typeName: '电视剧' } },
        ],
      },
    ],
  },
};

const VINFO_RESPONSE = { c: { title: '庆余年', video_ids: ['vidEp1', 'vidEp2'] } };

const INDEX_RESPONSE = {
  segment_index: {
    // 故意乱序：按 segment_start 排序后再请求
    '30000': { segment_start: '30000', segment_name: 't/v1/30000/60000' },
    '0': { segment_start: '0', segment_name: 't/v1/0/30000' },
  },
};

describe('tencentProvider', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('搜索→分集→分片，按 content_style 映射颜色与位置', async () => {
    mockedRequest
      .mockResolvedValueOnce(SEARCH_RESPONSE)
      .mockResolvedValueOnce(VINFO_RESPONSE)
      .mockResolvedValueOnce(INDEX_RESPONSE)
      .mockResolvedValueOnce({
        barrage_list: [
          { content: '前方高能', time_offset: '12000', content_style: '{"color":"ffffff","gradient_colors":["FFD500"],"position":1}' },
          { content: '  ', time_offset: '1000' },
          { content: '底部弹幕', time_offset: '2000', content_style: '{"position":3}' },
          { content: '坏时间', time_offset: 'x' },
        ],
      })
      .mockResolvedValueOnce({
        barrage_list: [
          { content: '顶部弹幕', time_offset: '35000', content_style: '{"color":"FF1964","position":2}' },
          { content: '样式损坏', time_offset: '36000', content_style: 'not-json' },
        ],
      });

    const result = await tencentProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('庆余年');
    expect(result!.comments).toEqual([
      { time: 12, mode: 'scroll', color: 0xffd500, text: '前方高能' },
      { time: 2, mode: 'bottom', color: 0xffffff, text: '底部弹幕' },
      { time: 35, mode: 'top', color: 0xff1964, text: '顶部弹幕' },
      { time: 36, mode: 'scroll', color: 0xffffff, text: '样式损坏' },
    ]);
    const segmentUrls = mockedRequest.mock.calls.slice(3).map((call) => call[0]);
    expect(segmentUrls).toEqual([
      'https://dm.video.qq.com/barrage/segment/vidEp1/t/v1/0/30000',
      'https://dm.video.qq.com/barrage/segment/vidEp1/t/v1/30000/60000',
    ]);
  });

  it('搜索请求带 Origin 与关键词（缺 Origin 腾讯返回空结果）', async () => {
    mockedRequest
      .mockResolvedValueOnce(SEARCH_RESPONSE)
      .mockResolvedValueOnce(VINFO_RESPONSE)
      .mockResolvedValueOnce(INDEX_RESPONSE)
      .mockResolvedValue({ barrage_list: [{ content: '弹幕', time_offset: '0' }] });

    await tencentProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    const [url, options] = mockedRequest.mock.calls[0] ?? [];
    expect(url).toContain('MbSearch?vplatform=2');
    expect(options?.method).toBe('POST');
    expect(options?.headers?.['Origin']).toBe('https://v.qq.com');
    expect(JSON.parse(String(options?.body)).query).toBe('庆余年');
  });

  it('按年份选中对应季（2019 → 第一季，2024 → 第二季）', async () => {
    mockedRequest
      .mockResolvedValueOnce(SEARCH_RESPONSE)
      .mockResolvedValueOnce({ c: { title: '庆余年', video_ids: [] } });
    await tencentProvider.match({ title: '庆余年', year: 2019, episode: 1 });
    expect(mockedRequest.mock.calls[1]?.[0]).toContain('cid=rjae621myqca41h');

    mockedRequest.mockReset();
    mockedRequest
      .mockResolvedValueOnce(SEARCH_RESPONSE)
      .mockResolvedValueOnce({ c: { title: '庆余年第二季', video_ids: [] } });
    await tencentProvider.match({ title: '庆余年', year: 2024, episode: 1 });
    expect(mockedRequest.mock.calls[1]?.[0]).toContain('cid=season2');
  });

  it('季号冲突的标题不采用（防串到别的季）', async () => {
    mockedRequest.mockResolvedValueOnce(SEARCH_RESPONSE);

    const result = await tencentProvider.match({ title: '庆余年第二季', year: 2019, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('片名完全不符时只发一次搜索请求', async () => {
    mockedRequest.mockResolvedValueOnce({
      ret: 0,
      data: { areaBoxList: [{ boxId: 'MainNeed', itemList: [{ doc: { id: 'x' }, videoInfo: { title: '伪装者2', year: 2015 } }] }] },
    });

    const result = await tencentProvider.match({ title: '伪装者', year: 2015, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('集号越界返回 null', async () => {
    mockedRequest.mockResolvedValueOnce(SEARCH_RESPONSE).mockResolvedValueOnce(VINFO_RESPONSE);

    const result = await tencentProvider.match({ title: '庆余年', year: 2019, episode: 3 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it('单片分片失败不影响整集（返回已成功的部分）', async () => {
    mockedRequest
      .mockResolvedValueOnce(SEARCH_RESPONSE)
      .mockResolvedValueOnce(VINFO_RESPONSE)
      .mockResolvedValueOnce(INDEX_RESPONSE)
      .mockRejectedValueOnce(new Error('segment down'))
      .mockResolvedValueOnce({ barrage_list: [{ content: '幸存弹幕', time_offset: '35000' }] });

    const result = await tencentProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result).not.toBeNull();
    expect(result!.comments).toEqual([{ time: 35, mode: 'scroll', color: 0xffffff, text: '幸存弹幕' }]);
  });

  it('搜索接口返回错误码时返回 null', async () => {
    mockedRequest.mockResolvedValueOnce({ ret: 20607 });

    const result = await tencentProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result).toBeNull();
  });
});
