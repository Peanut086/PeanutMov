import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-4：线路地址探活（拿不拿得到字节）
 *
 * 真机上默认那条线路指向 `mv.gzlcl.com`，DNS 都解析不了，`resolvePlay` 却照样成功——
 * 旧探测把「爬虫答了」当成「线路可播」。这里钉住新口径：
 * **能读到 2xx 才算可播，读到明确的拒绝才算挂死，判不出来就留白**，
 * 不给线路泼脏水（超时、5xx、被 CORS 挡住的裸读一律 unknown）。
 */

let native = true;
let proxyAvailable = true;

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => native };
});

vi.mock('@/native/localProxy', () => ({
  LocalProxy: {
    proxy: vi.fn(async () => {
      if (!proxyAvailable) throw new Error('proxy unavailable');
      return { url: 'http://127.0.0.1:9978/token-1/' };
    }),
  },
}));

const { probeUrlLiveness, __resetUrlLivenessProbe } = await import('@/services/urlLivenessProbe');

const URL = 'https://dead.example.com/1.m3u8';

function calls(): string[] {
  return vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
}

describe('probeUrlLiveness', () => {
  beforeEach(() => {
    native = true;
    proxyAvailable = true;
    __resetUrlLivenessProbe();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 206 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('经代理读到 206 → alive，且只做一次空读', async () => {
    const result = await probeUrlLiveness(URL, { Referer: 'https://a/' });
    expect(result.verdict).toBe('alive');
    expect(result.viaProxy).toBe(true);
    expect(calls()).toHaveLength(1);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Range']).toBe('bytes=0-0');
  });

  it('代理与直连都建立不起连接 → dead（下载引擎用同一地址也拿不到字节）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await probeUrlLiveness(URL);
    expect(result.verdict).toBe('dead');
    expect(calls()).toHaveLength(2);
  });

  it('dead 结论按 URL 缓存：同址的第二条线路零流量复用（真机线路 0/1/2 同址的形态）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await probeUrlLiveness(URL);
    const again = await probeUrlLiveness(URL);
    expect(again.verdict).toBe('dead');
    expect(calls()).toHaveLength(2);
  });

  it('超时 → unknown，且不缓存（下次进详情还会再试）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 5);
          }),
      ),
    );
    const result = await probeUrlLiveness(URL, undefined, 5);
    expect(result.verdict).toBe('unknown');
    const second = await probeUrlLiveness(URL, undefined, 5);
    expect(second.verdict).toBe('unknown');
    expect(calls().length).toBeGreaterThan(1);
  });

  it('代理侧的假 404（token 过期）不判死，直连 206 仍算 alive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        String(input).includes('127.0.0.1')
          ? new Response('proxy token not found or expired', { status: 404 })
          : new Response('', { status: 206 }),
      ),
    );
    const result = await probeUrlLiveness(URL);
    expect(result.verdict).toBe('alive');
    expect(result.viaProxy).toBe(false);
  });

  it('上游 5xx 只算 unknown：瞬时故障不给线路记失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        String(input).includes('127.0.0.1')
          ? new Response('bad gateway', { status: 502 })
          : (Promise.reject(new TypeError('Failed to fetch')) as unknown as Response),
      ),
    );
    const result = await probeUrlLiveness(URL);
    expect(result.verdict).toBe('unknown');
  });

  it('非 http 地址（blob/本地）不探测，直接 unknown', async () => {
    const result = await probeUrlLiveness('blob:http://localhost/xyz');
    expect(result.verdict).toBe('unknown');
    expect(calls()).toHaveLength(0);
  });

  it('非原生环境没有代理通路：裸读被 CORS 挡住时不判死（证据不可归因）', async () => {
    native = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await probeUrlLiveness(URL);
    expect(result.verdict).toBe('unknown');
    expect(calls()).toHaveLength(1);
  });
});
