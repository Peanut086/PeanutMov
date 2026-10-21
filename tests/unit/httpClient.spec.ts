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
