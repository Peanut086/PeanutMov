import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SiteAdapter } from '@/sources/site/SiteAdapter';
import type { Source } from '@/types';

/**
 * CHG-05 / AC-111：站点源（TVBox JSON）响应分类
 *
 * 只验证"非 JSON / 认证 / 404 / 网络"四类的归类与文案，
 * 不断言 httpClient 内部实现（那是 httpClient.spec.ts 的职责）。
 */
const HTML_BODY = '<!doctype html><html><head><title>拦截</title></head><body>blocked</body></html>';
const IMAGE_BODY = '\u0089PNG\r\n\u001a\n';
const PLAIN_BODY = 'hello, this is not json';
const TVBOX_BODY = JSON.stringify({
  code: 1,
  list: [{ vod_id: 1, vod_name: '示例影片', vod_play_from: '线路1', vod_play_url: '第1集$https://cdn.example.com/a.m3u8' }],
});

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-site',
    key: 'src-site',
    name: '站点源',
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://site.example.com/api.php/provide/vod/',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function respond(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.contentType ? { 'content-type': init.contentType } : {},
  });
}

describe('SiteAdapter 响应分类（AC-111）', () => {
  const adapter = new SiteAdapter();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('200 + text/html → E_UNSUPPORTED_FORMAT，health=bad_config，文案指明"不是订阅 JSON"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(HTML_BODY, { contentType: 'text/html; charset=utf-8' }));
    const result = await adapter.testConnection(makeSource());

    expect(result.ok).toBe(false);
    expect(result.health).toBe('bad_config');
    expect(result.error?.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(result.error?.message).toContain('不是订阅 JSON');
  });

  it('200 + image/png → E_UNSUPPORTED_FORMAT（图片被当订阅的典型场景）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(IMAGE_BODY, { contentType: 'image/png' }));
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(result.health).toBe('bad_config');
    expect(result.error?.detail).toContain('图片');
  });

  it('200 + 非 JSON 文本 → E_UNSUPPORTED_FORMAT 且 detail 含响应片段', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(PLAIN_BODY, { contentType: 'text/plain' }));
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(result.error?.detail).toContain('不是合法 JSON');
    expect(result.error?.detail).toContain('hello');
  });

  it('200 + JSON 但缺 list/class → E_UNSUPPORTED_FORMAT（NOT_TVBOX 文案）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond(JSON.stringify({ code: 1, data: [] }), { contentType: 'application/json' }),
    );
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(result.error?.message).toContain('TVBox');
    expect(result.health).toBe('bad_config');
  });

  it('401 → E_AUTH，health=auth_failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { status: 401 }));
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_AUTH');
    expect(result.health).toBe('auth_failed');
  });

  it('403 → E_HTTP_403，health=auth_failed（不合并成 E_AUTH）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { status: 403 }));
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_HTTP_403');
    expect(result.health).toBe('auth_failed');
  });

  it('404 → E_HTTP_404，health=unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { status: 404 }));
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_HTTP_404');
    expect(result.health).toBe('unreachable');
  });

  it('网络失败（DNS/连接）→ E_NETWORK，health=unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await adapter.testConnection(makeSource());

    expect(result.error?.code).toBe('E_NETWORK');
    expect(result.health).toBe('unreachable');
  });

  it('合法 TVBox JSON → ok，并带回条目数', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(TVBOX_BODY, { contentType: 'application/json' }));
    const result = await adapter.testConnection(makeSource());

    expect(result.ok).toBe(true);
    expect(result.health).toBe('ok');
    expect(result.itemCount).toBe(1);
  });

  it('JSON 数组响应（少数站点）→ ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond(JSON.stringify([{ vod_id: 1, vod_name: 'A' }]), { contentType: 'application/json' }),
    );
    const result = await adapter.testConnection(makeSource());

    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(1);
  });

  it('非 JSON 类错误不会新增 ErrorCode（沿用既有枚举）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(HTML_BODY, { contentType: 'text/html' }));
    const result = await adapter.testConnection(makeSource());

    const { ERROR_MESSAGES } = await import('@/shared/errors');
    expect(Object.keys(ERROR_MESSAGES)).toContain(result.error?.code);
    expect(result.error?.message).not.toBe(ERROR_MESSAGES.E_UNSUPPORTED_FORMAT);
  });
});
