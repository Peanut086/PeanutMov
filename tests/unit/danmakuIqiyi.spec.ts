/**
 * 爱奇艺直连弹幕源单测：搜索选专辑、分集正片优选、分片签名与目录位、Brotli + protobuf/XML 双负载
 */
import { brotliCompressSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { md5 } from '@/services/danmaku/md5';
import { iqiyiProvider } from '@/services/danmaku/iqiyi';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

const ALBUM_ID = '4029879027085400';
const TVID = 2055742301;
/** 与 iqiyi.ts 同步的分片签名后缀 */
const BULLET_SALT = 'cbzuw1259a';

function album(title: string, opts: Partial<{ qipuId: string; channel: string; year: string }> = {}) {
  return { title, qipuId: opts.qipuId ?? ALBUM_ID, channel: opts.channel ?? '电视剧', year: { value: opts.year ?? '2023' } };
}

const SEARCH_RESPONSE = {
  code: 'A00000',
  data: {
    templates: [
      { template: 10, albumInfo: album('<em>狂飙</em>2', { qipuId: '4029879027085999', year: '2025' }) },
      { template: 10, albumInfo: album('狂飙 高光集锦', { channel: '综艺' }) },
      { template: 10, albumInfo: album('狂飙', { year: '2023' }) },
      { template: 10, albumInfo: album('狂飙', { qipuId: '3000000000000000', year: '2020' }) },
    ],
  },
};

/** 分集：同集号并存正片与预告，按时长取最长 */
const EPISODES_RESPONSE = {
  code: 'A00000',
  data: {
    total: 3,
    epsodelist: [
      { order: 1, tvId: TVID, duration: '45:12', name: '狂飙 第1集' },
      { order: 2, tvId: TVID + 1, duration: '45:12', name: '狂飙 第2集' },
      { order: 2, tvId: 999, duration: '00:48', name: '狂飙 第2集 预告' },
    ],
  },
};

/* ---------- 分片负载 ---------- */

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function tag(field: number, wireType: number): number[] {
  return varint(field * 8 + wireType);
}

function bytes(parts: number[]): Uint8Array {
  return new Uint8Array(parts);
}

function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function text(field: number, value: string): number[] {
  const raw = new TextEncoder().encode(value);
  return [...tag(field, 2), ...varint(raw.length), ...raw];
}

function message(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...varint(body.length), ...body];
}

/** 顶层 field 6 = 时间块；块内 field 1 = 起始秒、field 2 = 单条（2 文本 / 6 秒 / 8 颜色） */
function protoPayload(blocks: Array<{ start: number; items: Array<{ text: string; time?: number; color?: string }> }>): Uint8Array {
  const parts: number[] = [];
  for (const block of blocks) {
    const body = [...varintField(1, block.start)];
    for (const item of block.items) {
      const comment = [...text(2, item.text), ...(item.time !== undefined ? varintField(6, item.time) : []), ...(item.color !== undefined ? text(8, item.color) : [])];
      body.push(...message(2, comment));
    }
    parts.push(...message(6, body));
  }
  return bytes(parts);
}

const XML_PAYLOAD = new TextEncoder().encode(
  '<bullet><chatroot><chat><p><showTime>12.34</showTime><content>旧版 &amp; 实体</content><color>#ff0000</color></p>' +
    '<p><showTime>13</showTime><content>十进制色</content><color>255</color></p>' +
    '<p><showTime>14</showTime><content>  </content></p></chat></chatroot></bullet>',
);

/** 分片是静态 .br 文件：mock 里用 Node 的 brotli 压成 ArrayBuffer，走 Web 通路 */
function br(payload: Uint8Array): ArrayBuffer {
  const compressed = brotliCompressSync(payload);
  return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;
}

const EMPTY_PAYLOAD = new TextEncoder().encode('');

function pageOf(url: string): number {
  return Number(/_60_(\d+)_/.exec(new URL(url).pathname)?.[1] ?? 0);
}

/** httpClient 的分片选项写成 `arrayBuffer`（大写 B），按大小写不敏感识别二进制请求 */
function isBytes(options?: { responseType?: string }): boolean {
  return String(options?.responseType).toLowerCase() === 'arraybuffer';
}

describe('iqiyiProvider', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  function route(payload: (page: number) => ArrayBuffer | Error) {
    mockedRequest.mockImplementation(((url: string, options?: { responseType?: string }) => {
      if (isBytes(options)) {
        const value = payload(pageOf(url));
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
      if (url.startsWith('https://mesh.if.iqiyi.com')) return Promise.resolve(SEARCH_RESPONSE);
      if (url.startsWith('https://pcw-api.iqiyi.com')) return Promise.resolve(EPISODES_RESPONSE);
      return Promise.resolve({});
    }) as never);
  }

  /** 45:12 = 2712s → 46 个 60s 分片 */
  const FULL_PAGES = 46;

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('同名候选按年份选专辑，分集同号并存时取最长正片', async () => {
    route(() => br(protoPayload([{ start: 0, items: [{ text: '弹幕', time: 5 }] }])));
    await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 2 });

    const episodesUrl = new URL(String(mockedRequest.mock.calls[1]?.[0]));
    expect(episodesUrl.searchParams.get('aid')).toBe(ALBUM_ID);
    // 预告 tvId=999 被排除
    expect(pageOf(String(mockedRequest.mock.calls[2]?.[0]))).toBe(1);
    expect(new URL(String(mockedRequest.mock.calls[2]?.[0])).pathname).toContain(`/${TVID + 1}_60_1_`);
  });

  it('分片地址带 CDN 目录位与 md5 签名后缀', async () => {
    route(() => br(protoPayload([{ start: 0, items: [{ text: '弹幕', time: 5 }] }])));
    await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    const path = new URL(String(mockedRequest.mock.calls[2]?.[0])).pathname;
    const sign = md5(`${TVID}_60_1${BULLET_SALT}`).slice(-8);
    // 目录位取 tvid 末 4 的前两位 / 末 2 位
    expect(path).toBe(`/bullet/23/01/${TVID}_60_1_${sign}.br`);
  });

  it('protobuf 分片：块起始秒兜底、文本/时间/颜色映射', async () => {
    const page1 = protoPayload([
      {
        start: 60,
        items: [
          { text: '跟随块起点', color: 'ff1964' },
          { text: '自带时间', time: 75, color: '00ff00' },
          { text: '   ' },
          { text: '坏颜色', time: 80, color: 'not-a-color' },
        ],
      },
    ]);
    route((page) => (page === 1 ? br(page1) : br(EMPTY_PAYLOAD)));

    const result = await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('狂飙');
    expect(result!.comments).toEqual([
      { time: 60, mode: 'scroll', color: 0xff1964, text: '跟随块起点' },
      { time: 75, mode: 'scroll', color: 0x00ff00, text: '自带时间' },
      { time: 80, mode: 'scroll', color: 0xffffff, text: '坏颜色' },
    ]);
  });

  it('首字节是 `<` 时按旧版 XML 解析（实体还原 + 多种颜色写法）', async () => {
    route((page) => (page === 1 ? br(XML_PAYLOAD) : br(EMPTY_PAYLOAD)));

    const result = await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(result!.comments).toEqual([
      { time: 12.34, mode: 'scroll', color: 0xff0000, text: '旧版 & 实体' },
      { time: 13, mode: 'scroll', color: 0x0000ff, text: '十进制色' },
    ]);
  });

  it('分片数随时长收敛：2712s → 46 片，空负载不影响整集', async () => {
    route((page) => (page === 1 ? br(protoPayload([{ start: 0, items: [{ text: '弹幕', time: 5 }] }])) : br(EMPTY_PAYLOAD)));

    const result = await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(result!.comments).toHaveLength(1);
    expect(mockedRequest.mock.calls.filter((call) => String(call[0]).includes('cmts.iqiyi.com'))).toHaveLength(FULL_PAGES);
  });

  it('单片失败不影响整集（返回已成功的部分）', async () => {
    route((page) => {
      if (page === 1) return new Error('segment down');
      return br(protoPayload([{ start: page * 60, items: [{ text: `幸存${page}`, time: 0 }] }]));
    });

    const result = await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(FULL_PAGES - 1);
    expect(result!.comments.some((c) => c.text === '幸存1')).toBe(false);
  });

  it('全部负载解出 0 字节时返回 null', async () => {
    route(() => br(EMPTY_PAYLOAD));
    expect(await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
  });

  it('搜索被风控（code=-1）时退避重试一次，仍失败才放弃', async () => {
    let searches = 0;
    mockedRequest.mockImplementation(((url: string) => {
      if (url.startsWith('https://mesh.if.iqiyi.com')) {
        searches += 1;
        return Promise.resolve({ code: '-1' });
      }
      return Promise.resolve({});
    }) as never);

    const result = await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(result).toBeNull();
    expect(searches).toBe(2);
  }, 10_000);

  it('年份对不上时不串专辑', async () => {
    mockedRequest.mockImplementation(((url: string) => {
      if (url.startsWith('https://mesh.if.iqiyi.com')) {
        return Promise.resolve({ code: 'A00000', data: { templates: [{ albumInfo: album('狂飙', { year: '2023' }) }] } });
      }
      return Promise.resolve({});
    }) as never);

    expect(await iqiyiProvider.match({ title: '狂飙', year: 2019, episode: 1 })).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('综艺类专辑不参与（集号语义与播放器不一致）', async () => {
    mockedRequest.mockResolvedValueOnce({
      code: 'A00000',
      data: { templates: [{ albumInfo: album('狂飙', { channel: '综艺', year: '2023' }) }] },
    });

    expect(await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('tvId 非纯数字（如外链）时不发分片请求', async () => {
    mockedRequest.mockImplementation(((url: string, options?: { responseType?: string }) => {
      if (isBytes(options)) return Promise.resolve(br(protoPayload([{ start: 0, items: [{ text: '不该出现', time: 1 }] }])));
      if (url.startsWith('https://mesh.if.iqiyi.com')) return Promise.resolve(SEARCH_RESPONSE);
      if (url.startsWith('https://pcw-api.iqiyi.com')) {
        return Promise.resolve({ code: 'A00000', data: { total: 1, epsodelist: [{ order: 1, tvId: 'ext_123', duration: '45:12' }] } });
      }
      return Promise.resolve({});
    }) as never);

    expect(await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
    expect(mockedRequest.mock.calls.filter((call) => String(call[0]).includes('cmts.iqiyi.com'))).toHaveLength(0);
  });

  it('本集时长低于 5 分钟按预告处理', async () => {
    mockedRequest.mockImplementation(((url: string, options?: { responseType?: string }) => {
      if (isBytes(options)) return Promise.resolve(br(protoPayload([{ start: 0, items: [{ text: '不该出现', time: 1 }] }])));
      if (url.startsWith('https://mesh.if.iqiyi.com')) return Promise.resolve(SEARCH_RESPONSE);
      if (url.startsWith('https://pcw-api.iqiyi.com')) {
        return Promise.resolve({ code: 'A00000', data: { total: 1, epsodelist: [{ order: 1, tvId: TVID, duration: '00:48' }] } });
      }
      return Promise.resolve({});
    }) as never);

    expect(await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
  });

  it('分集目标集号在第二页才命中时翻页', async () => {
    const page1 = { code: 'A00000', data: { total: 31, epsodelist: Array.from({ length: 30 }, (_, i) => ({ order: i + 1, tvId: 1000000000 + i, duration: '45:00' })) } };
    const page2 = { code: 'A00000', data: { total: 31, epsodelist: [{ order: 31, tvId: 3720011601, duration: '45:00' }] } };
    let episodeCalls = 0;
    mockedRequest.mockImplementation(((url: string, options?: { responseType?: string }) => {
      if (isBytes(options)) return Promise.resolve(br(protoPayload([{ start: 0, items: [{ text: '弹幕', time: 1 }] }])));
      if (url.startsWith('https://mesh.if.iqiyi.com')) return Promise.resolve(SEARCH_RESPONSE);
      if (url.startsWith('https://pcw-api.iqiyi.com')) {
        episodeCalls += 1;
        return Promise.resolve(episodeCalls === 1 ? page1 : page2);
      }
      return Promise.resolve({});
    }) as never);

    const result = await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 31 });

    expect(episodeCalls).toBe(2);
    expect(result).not.toBeNull();
    expect(new URL(String(mockedRequest.mock.calls[3]?.[0])).pathname).toContain('/3720011601_60_1_');
  });

  it('集号小于 1 直接放弃', async () => {
    expect(await iqiyiProvider.match({ title: '狂飙', year: 2023, episode: 0 })).toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
