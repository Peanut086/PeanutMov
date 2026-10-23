/**
 * 管道与既有契约的交叉回归
 *
 * 两个容易在重构中悄悄丢掉的既有语义：
 * 1. AC-15：探测窗口内 3s 超时且不重试（即使规则写了 8s / 2 次重试）；
 * 2. 订阅 2MB 上限（原实现先看 content-length 再看字节数）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { httpClient } from '@/sources/base/httpClient';
import { TIMEOUT_TEST_CONNECTION_MS } from '@/shared/constants';
import { setRules, crawl } from '@/sources/pipeline/scheduler';
import { defaultRules } from '@/sources/pipeline/rules/defaults';

const API = 'https://site.example.com/api.php/provide/vod/';

const TVBOX_JSON = JSON.stringify({ code: 1, list: [{ vod_id: 1 }] });

describe('探测窗口（AC-15）', () => {
  beforeEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('窗口内的超时按 3s 收窄，不被规则里的 8s 覆盖', async () => {
    const timeouts: number[] = [];
    vi.spyOn(httpClient, 'requestWithMeta').mockImplementation(async (_url, options) => {
      timeouts.push(options?.timeoutMs ?? -1);
      return { data: new TextEncoder().encode(TVBOX_JSON).buffer, status: 200, headers: new Headers() };
    });

    await httpClient.withProbeTimeout(
      TIMEOUT_TEST_CONNECTION_MS,
      () => crawl({ intent: 'catalog', url: API }),
      'https://site.example.com',
    );

    expect(timeouts).toEqual([TIMEOUT_TEST_CONNECTION_MS]);
  });

  it('窗口内失败不重试（fetch 只调用一次）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      httpClient.withProbeTimeout(
        TIMEOUT_TEST_CONNECTION_MS,
        () => crawl({ intent: 'catalog', url: API }),
        'https://site.example.com',
      ),
    ).rejects.toMatchObject({ code: 'E_NETWORK' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('窗口外按规则重试（网络失败重试一次）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({ code: 'E_NETWORK' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('订阅响应体上限（2MB）', () => {
  beforeEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('超过 maxBytes → E_INVALID_INPUT 且不进入解析', async () => {
    const body = JSON.stringify({ sites: [], pad: 'x'.repeat(64) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );

    await expect(
      crawl({ intent: 'subscription', url: 'https://sub.example.com/s.json', maxBytes: 16 }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });

  it('未超过上限正常解析', async () => {
    const body = JSON.stringify({ sites: [] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );

    const result = await crawl<{ text: string }>({
      intent: 'subscription',
      url: 'https://sub.example.com/s.json',
      maxBytes: 2 * 1024 * 1024,
    });
    expect(result.value.text).toBe(body);
  });
});
