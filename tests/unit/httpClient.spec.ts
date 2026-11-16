/**
 * 源适配层 HTTP 客户端：状态码 → 错误码映射（REV-16 补充修复）
 *
 * 断言 401 与 403 不再合并：
 * - 401 → `E_AUTH`（"认证失败，请检查账号或 Token"）
 * - 403 → `E_HTTP_403`（"无权限访问(403)"）
 * 两者都保留 `httpStatus`，且 `retryable === false`（不重试）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/shared/errors';
import { AlistAdapter } from '@/sources/alist/AlistAdapter';
import { httpClient, httpRequest } from '@/sources/base/httpClient';
import type { Source } from '@/types';

function stubFetch(status: number, body = ''): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(body, { status, statusText: '' }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('预期抛出 AppError，但请求成功返回');
}

function makeAlistSource(): Source {
  const now = Date.now();
  return {
    id: 'alist-1',
    key: 'alist-1',
    name: 'AList 测试源',
    type: 'alist',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: 'https://alist.example.com',
    pathPrefix: null,
    auth: { mode: 'token', username: null, password: null, token: 'cached-token' },
    headers: {},
    ext: { root: '/' },
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpClient 401/403 区分（REV-16 / AC-39）', () => {
  it('HTTP 401 → E_AUTH，保留 httpStatus 且不可重试', async () => {
    const fetchMock = stubFetch(401);

    const error = await captureError(httpRequest('https://alist.example.com/api/fs/list', { responseType: 'none' }));

    expect(error.code).toBe('E_AUTH');
    expect(error.message).toBe('认证失败，请检查账号或 Token');
    expect(error.httpStatus).toBe(401);
    expect(error.retryable).toBe(false);
    // 不可重试：默认 retries=1，但只应发出一次请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 403 → E_HTTP_403，保留 httpStatus 且不可重试', async () => {
    const fetchMock = stubFetch(403);

    const error = await captureError(httpRequest('https://alist.example.com/api/fs/list', { responseType: 'none' }));

    expect(error.code).toBe('E_HTTP_403');
    expect(error.message).toBe('无权限访问(403)');
    expect(error.httpStatus).toBe(403);
    expect(error.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('403 文案不与 E_AUTH 相同，即使显式要求重试也只请求一次', async () => {
    const fetchMock = stubFetch(403);

    const error = await captureError(
      httpRequest('https://alist.example.com/api/fs/list', { responseType: 'none', retries: 2 }),
    );

    expect(error.code).toBe('E_HTTP_403');
    expect(error.message).not.toBe(new AppError('E_AUTH').message);
    expect(error.detail).toContain('HTTP 403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx 仍可重试（retryable 语义未被本次修改影响）', async () => {
    const fetchMock = stubFetch(503);

    const error = await captureError(httpRequest('https://alist.example.com/api/fs/list', { responseType: 'none' }));

    expect(error.code).toBe('E_HTTP_5XX');
    expect(error.httpStatus).toBe(503);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AList 适配器 401/403 区分（REV-16 同类合并）', () => {
  it('业务码 401 → E_AUTH', async () => {
    stubFetch(200, JSON.stringify({ code: 401, message: 'token is expired', data: null }));

    const error = await captureError(new AlistAdapter().listCategories(makeAlistSource()));

    expect(error.code).toBe('E_AUTH');
  });

  it('业务码 403 → E_HTTP_403（不再退化为"需要登录"）', async () => {
    stubFetch(200, JSON.stringify({ code: 403, message: 'permission denied', data: null }));

    const error = await captureError(new AlistAdapter().listCategories(makeAlistSource()));

    expect(error.code).toBe('E_HTTP_403');
    expect(error.message).toBe('无权限访问(403)');
    expect(error.retryable).toBe(false);
  });

  it('适配器 httpClient 导出仍可用（防止误改公共入口）', () => {
    expect(typeof httpClient.request).toBe('function');
    expect(typeof httpClient.requestWithMeta).toBe('function');
  });
});

/**
 * OPT-08：截止时间必须覆盖「响应头 + 响应体」整段。
 *
 * 此前定时器在 `fetchOnce` 的 finally 里就清掉了，`readBody` 不受任何预算约束：
 * 服务端回了 200 头之后吊住连接，调用方（尤其不带 signal 的弹幕 XML / 详情刷新）永久挂起。
 */
describe('httpClient 超时覆盖响应体读取（OPT-08）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 200 头 + 永不结束的 body；signal abort（含到达时已 abort）时按 undici 语义以 AbortError 退出读取 */
  function stubStalledBody(): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: new Headers(),
      text: () =>
        new Promise<string>((_resolve, reject) => {
          const onAbort = (): void => {
            const err = new Error('The signal has been aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener('abort', onAbort);
        }),
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('响应头已到但 body 停滞：到点抛 E_TIMEOUT，而不是无限等待', async () => {
    vi.useFakeTimers();
    stubStalledBody();

    const call = httpRequest<string>('https://slow.example.com/danmaku.xml', {
      responseType: 'text',
      timeoutMs: 1000,
      retries: 0,
    });
    // 先挂上断言再推进时钟：否则到点那一刻是无人处理的 rejection，Node 会记一条 unhandled
    const settled = captureError(call);
    await vi.advanceTimersByTimeAsync(1000);

    const error = await settled;
    expect(error.code).toBe('E_TIMEOUT');
    expect(error.detail).toContain('1000ms');
  });

  it('body 停滞期间外部取消：抛 E_ABORTED 且不重试（与首字节前取消同语义）', async () => {
    const controller = new AbortController();
    const fetchMock = stubStalledBody();

    const call = httpRequest<string>('https://slow.example.com/danmaku.xml', {
      responseType: 'text',
      timeoutMs: 60_000,
      retries: 2,
      signal: controller.signal,
    });
    controller.abort();

    const error = await captureError(call);
    expect(error.code).toBe('E_ABORTED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
