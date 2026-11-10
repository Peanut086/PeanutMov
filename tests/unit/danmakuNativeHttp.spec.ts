/**
 * 弹幕原生请求通路单测：CapacitorHttp 分支的响应头合并、错误码与 base64 二进制
 *
 * 真机（原生通路）不在 CI 里，但这段分支决定了优酷 mtop 能否取到 `_m_h5_tk`、
 * 爱奇艺 Brotli 分片能否还原成字节，故在此按协议语义固定。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { httpClient } from '@/sources/base/httpClient';
import { base64ToBytes, requestBytes, requestResponse, requestWithHeaders } from '@/services/danmaku/nativeHttp';

const env = vi.hoisted(() => ({ native: true }));
const capHttp = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native },
  CapacitorHttp: capHttp,
}));

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

/** 优酷一次下发两条同名 set-cookie（token + enc），覆盖式合并会丢掉 token */
const TWO_COOKIES = {
  data: { ret: ['SUCCESS::调用成功'] },
  status: 200,
  headers: {
    'Set-Cookie': '_m_h5_tk=aaa_1794286545; Path=/',
    'set-cookie': '_m_h5_tk_enc=bbb; Path=/',
    'Content-Type': 'application/json',
  },
};

describe('nativeHttp 原生通路', () => {
  beforeEach(() => {
    env.native = true;
    capHttp.request.mockReset();
    vi.mocked(httpClient.request).mockReset();
    vi.mocked(httpClient.requestWithMeta).mockReset();
  });

  it('同名响应头（大小写不同）以逗号合并，且键名统一小写', async () => {
    capHttp.request.mockResolvedValueOnce(TWO_COOKIES);

    const response = await requestResponse<{ ret: string[] }>('https://acs.youku.com/h5/mtop.youku.h5web.danmu.list/1.0/', {
      responseType: 'json',
      timeoutMs: 8000,
    });

    const cookie = response.headers['set-cookie'] ?? '';
    expect(cookie).toContain('_m_h5_tk=aaa_1794286545');
    expect(cookie).toContain('_m_h5_tk_enc=bbb');
    expect(cookie.split(', ')).toHaveLength(2);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.data.ret[0]).toContain('SUCCESS');
  });

  it('服务端已把同名头并成数组时按原样展开（不丢条目）', async () => {
    capHttp.request.mockResolvedValueOnce({
      data: {},
      status: 200,
      headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] as unknown as string },
    });

    const response = await requestResponse('https://acs.youku.com/h5/mtop/', { responseType: 'json' });

    expect(response.headers['set-cookie']).toBe('a=1; Path=/,b=2; Path=/');
  });

  it('请求参数按 Capacitor 约定映射（headers/data/双超时），非 2xx 抛 HTTP 错误', async () => {
    capHttp.request.mockResolvedValueOnce({ data: 'x', status: 403, headers: {} });

    await expect(
      requestWithHeaders<string>('https://api.bilibili.com/x/v1/dm/list.so?aid=1', {
        method: 'POST',
        headers: { Referer: 'https://www.bilibili.com' },
        body: 'a=1',
        responseType: 'text',
        timeoutMs: 6000,
      }),
    ).rejects.toThrow('HTTP 403');

    expect(capHttp.request).toHaveBeenCalledWith({
      url: 'https://api.bilibili.com/x/v1/dm/list.so?aid=1',
      method: 'POST',
      headers: { Referer: 'https://www.bilibili.com' },
      data: 'a=1',
      responseType: 'text',
      connectTimeout: 6000,
      readTimeout: 6000,
    });
  });

  it('二进制分片回 base64 字符串时还原为字节（容忍 MIME 换行）', async () => {
    capHttp.request.mockResolvedValue({ data: 'SGVsbG8g\nd29ybGQ=\n', status: 200, headers: {} });

    const bytes = await requestBytes('https://cmts.iqiyi.com/bullet/23/01/1_60_1_deadbeef.br');

    expect(new TextDecoder().decode(bytes)).toBe('Hello world');
    expect(capHttp.request.mock.calls[0]?.[0]).toMatchObject({ responseType: 'arraybuffer' });
  });

  it('空响应体不误判为失败，回 0 字节；重定向状态抛错', async () => {
    capHttp.request.mockResolvedValueOnce({ data: '', status: 200, headers: {} });
    expect(await requestBytes('https://cmts.iqiyi.com/bullet/x.br')).toHaveLength(0);

    capHttp.request.mockResolvedValueOnce({ data: '', status: 302, headers: {} });
    await expect(requestBytes('https://cmts.iqiyi.com/bullet/x.br')).rejects.toThrow('HTTP 302');
  });
});

describe('nativeHttp Web 通路', () => {
  beforeEach(() => {
    env.native = false;
    capHttp.request.mockReset();
    vi.mocked(httpClient.request).mockReset();
    vi.mocked(httpClient.requestWithMeta).mockReset();
  });

  it('走 httpClient 时两条 set-cookie 都不丢（Headers.forEach 会分别 yield）', async () => {
    vi.mocked(httpClient.requestWithMeta).mockResolvedValueOnce({
      data: {},
      status: 200,
      headers: new Headers([
        ['set-cookie', '_m_h5_tk=aaa_1794286545; Path=/'],
        ['set-cookie', '_m_h5_tk_enc=bbb; Path=/'],
      ]),
    });

    const response = await requestResponse('https://acs.youku.com/h5/mtop/', { responseType: 'json' });

    expect(response.headers['set-cookie']).toContain('_m_h5_tk=aaa_1794286545');
    expect(response.headers['set-cookie']).toContain('_m_h5_tk_enc=bbb');
    expect(capHttp.request).not.toHaveBeenCalled();
  });

  it('二进制请求按 arrayBuffer 交给 httpClient', async () => {
    vi.mocked(httpClient.request).mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);

    const bytes = await requestBytes('https://cmts.iqiyi.com/bullet/x.br', { timeoutMs: 4000 });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(httpClient.request).toHaveBeenCalledWith('https://cmts.iqiyi.com/bullet/x.br', { timeoutMs: 4000, responseType: 'arrayBuffer' });
  });
});

describe('base64ToBytes', () => {
  it('容忍 MIME 变体的换行与填充', () => {
    expect(new TextDecoder().decode(base64ToBytes('aGVhZA==\r\n'))).toBe('head');
    expect(base64ToBytes('')).toHaveLength(0);
  });
});
