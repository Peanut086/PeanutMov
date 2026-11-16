/**
 * B 站直连弹幕源单测：wbi 签名、片名/集号匹配、空结果处理、XML 触顶后的分片补量
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bilibiliProvider, clearBilibiliCache } from '@/services/danmaku/bilibili';
import { parseSegmentReply } from '@/services/danmaku/bilibiliProto';
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

function seasonResponse(title: string, episodes: Array<{ title: string; cid: number; duration?: number }>) {
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

/* ---------- 分片补量（Phase1 遗留 ⑦，实测契约见 bilibili.ts）---------- */

const encoder = new TextEncoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest & 0x7f);
  return out;
}
const tag = (field: number, wire: number): number[] => varint(field * 8 + wire);
const bytesField = (field: number, payload: number[]): number[] => [...tag(field, 2), ...varint(payload.length), ...payload];
const numField = (field: number, value: number): number[] => [...tag(field, 0), ...varint(value)];

/** 一条 Dm：2=时间(ms) 3=模式 5=颜色 7=文本 */
function dm(timeMs: number, text: string, mode = 1, color = 0xffffff): number[] {
  return bytesField(1, [...numField(2, timeMs), ...numField(3, mode), ...numField(5, color), ...bytesField(7, [...encoder.encode(text)])]);
}

/** DmSegMobileReply：顶层 4/5 是弹幕样式配置（实测每条响应都带），与弹幕无关 */
function segReply(entries: number[][]): ArrayBuffer {
  return new Uint8Array([...bytesField(4, [1, 2, 3, 4]), ...bytesField(5, [...encoder.encode('{"fill_color":"https://x"}')]), ...entries.flat()]).buffer;
}

/** 生成 n 条 XML 弹幕，用来把条数推过扇出阈值 */
function xmlWith(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) rows.push(`<d p="${(i * 0.3).toFixed(2)},1,25,16777215,1700000000,0,u,${i}">x${i}</d>`);
  return `<i>${rows.join('')}</i>`;
}

describe('parseSegmentReply（分片 protobuf）', () => {
  it('解码时间/模式/颜色/文本，忽略顶层样式字段', () => {
    const out = parseSegmentReply(new Uint8Array(segReply([dm(12_340, '前方高能'), dm(15_000, '顶部表态', 5, 0xff0000)])));
    expect(out).toEqual([
      { time: 12.34, mode: 'scroll', color: 0xffffff, text: '前方高能' },
      { time: 15, mode: 'top', color: 0xff0000, text: '顶部表态' },
    ]);
  });

  it('空文本与缺时间字段的条目跳过；空 body（-304/-352）返回空数组', () => {
    expect(parseSegmentReply(new Uint8Array(segReply([dm(1000, ''), dm(0, 'x')])))).toHaveLength(1);
    expect(parseSegmentReply(new Uint8Array(segReply([bytesField(1, [...numField(3, 1), ...bytesField(7, [...encoder.encode('没有时间')])])])))).toEqual([]);
    expect(parseSegmentReply(new Uint8Array(segReply([])))).toEqual([]);
    expect(parseSegmentReply(new Uint8Array(0))).toEqual([]);
  });

  it('oid 这类超过 2^31 的 varint 不截断（乘法累加，非位运算）', () => {
    const out = parseSegmentReply(new Uint8Array(segReply([dm(43_611_326_038, '大数值时间轴')])));
    expect(out[0]!.time).toBeCloseTo(43_611_326.038, 2);
  });
});

describe('bilibiliProvider 分片补量', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  /** httpClient 的分片选项写成 `arrayBuffer`（大写 B），按大小写不敏感识别二进制请求 */
  const isBytes = (options?: { responseType?: string }): boolean => String(options?.responseType).toLowerCase() === 'arraybuffer';

  /** 按 url 分派，不依赖调用顺序：分片并发下 once 链会错位 */
  function route(options: { xml: string; season: { title: string; cid: number; duration?: number }[]; segment?: (index: number) => ArrayBuffer | Error }) {
    mockedRequest.mockImplementation(((url: string, init?: { responseType?: string }) => {
      const value: unknown = (() => {
        if (url.includes('/nav')) return NAV_RESPONSE;
        if (url.includes('search/type')) return searchResponse('庆余年', 1234);
        if (url.includes('pgc/view/web/season')) return seasonResponse('庆余年', options.season);
        if (isBytes(init)) {
          const index = Number(new URL(url).searchParams.get('segment_index'));
          return options.segment?.(index) ?? segReply([]);
        }
        return options.xml;
      })();
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }) as never);
  }

  const segmentIndexes = (): number[] =>
    mockedRequest.mock.calls
      .filter(([, options]) => isBytes(options))
      .map(([url]) => Number(new URL(url).searchParams.get('segment_index')));

  beforeEach(() => {
    mockedRequest.mockReset();
    clearBilibiliCache();
  });

  it('XML 未触顶时不扇出（实测冷门片分片是 XML 子集，净新增 0）', async () => {
    route({ xml: xmlWith(884), season: [{ title: '1', cid: 555, duration: 1_509_000 }] });

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result!.comments).toHaveLength(884);
    expect(mockedRequest).toHaveBeenCalledTimes(4); // nav + 搜索 + 季 + XML
    expect(segmentIndexes()).toEqual([]);
  });

  it('XML 触顶且有时长时按 360s 扇出，并与 XML 合并', async () => {
    route({
      xml: xmlWith(3000),
      season: [{ title: '1', cid: 555, duration: 1_436_000 }], // 24 分钟 → 4 片
      segment: (index) => segReply([dm(index * 60_000, `分片${index}弹幕`)]),
    });

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(segmentIndexes()).toEqual([1, 2, 3, 4]);
    expect(mockedRequest.mock.calls[4]?.[0]).toContain('type=1');
    expect(mockedRequest.mock.calls[4]?.[0]).toContain('oid=555');
    expect(result!.comments).toHaveLength(3004);
    expect(result!.comments[3000]).toMatchObject({ time: 60, text: '分片1弹幕' });
    expect(result!.matchedTitle).toBe('庆余年');
  });

  it('长片扇出上限 10 片（连发过多会触发 -352 风控）', async () => {
    route({ xml: xmlWith(3000), season: [{ title: '1', cid: 555, duration: 10_392_000 }] }); // 2.9 小时 → 本应 29 片

    await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(segmentIndexes()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('预取场景即使触顶也不扇出（整季批量预取的请求量会进风控区）', async () => {
    route({
      xml: xmlWith(3000),
      season: [{ title: '1', cid: 555, duration: 1_436_000 }],
      segment: (index) => segReply([dm(index * 60_000, `分片${index}弹幕`)]),
    });

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1, scene: 'prefetch' });

    expect(result!.comments).toHaveLength(3000); // 只剩 XML 基线，离线仍可用
    expect(segmentIndexes()).toEqual([]);
    expect(mockedRequest).toHaveBeenCalledTimes(4); // nav + 搜索 + 季 + XML
  });

  it('季接口没给时长时不扇出（无别的途径能查分片总数）', async () => {
    route({ xml: xmlWith(3000), season: [{ title: '1', cid: 555 }] });

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result!.comments).toHaveLength(3000);
    expect(segmentIndexes()).toEqual([]);
  });

  it('越界分片抛错只丢该片，XML 结果保留', async () => {
    route({
      xml: xmlWith(3000),
      season: [{ title: '1', cid: 555, duration: 1_509_000 }], // 5 片，最后一片实测 304
      segment: (index) => (index === 5 ? new Error('E_HTTP_304') : segReply([dm(index * 60_000, '弹幕')])),
    });

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(segmentIndexes()).toEqual([1, 2, 3, 4, 5]);
    expect(result!.comments).toHaveLength(3004);
  });

  it('频控 -352 的近空响应体解出 0 条，不影响结果', async () => {
    route({
      xml: xmlWith(3000),
      season: [{ title: '1', cid: 555, duration: 720_000 }],
      segment: () => new Uint8Array(39).buffer,
    });

    const result = await bilibiliProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result!.comments).toHaveLength(3000);
  });
});
