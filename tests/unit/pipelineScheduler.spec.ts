/**
 * 调度器集成单测（Phase 1-2 判据）
 *
 * 覆盖真实链路：fetch → 解码 → 指纹 → 规则 → 解析器 → 降级。
 * 所有 URL 均为 example.com 合成样本（AC-105）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/shared/errors';
import { setRules, crawl, getRules, DEFAULT_BUDGET_MS } from '@/sources/pipeline/scheduler';
import { defaultRules } from '@/sources/pipeline/rules/defaults';
import { subRawParser } from '@/sources/pipeline/parsers';
import { fingerprintOf } from '@/sources/pipeline/fingerprint';
import { tolerantParse } from '@/sources/pipeline/jsonTolerant';

const API = 'https://site.example.com/api.php/provide/vod/';

const TVBOX_JSON = JSON.stringify({
  code: 1,
  list: [{ vod_id: 1, vod_name: '示例影片', vod_play_from: '线路1', vod_play_url: '第1集$https://cdn.example.com/a.m3u8' }],
});

function respond(body: string, init: { status?: number; contentType?: string; bytes?: Uint8Array } = {}): Response {
  const payload: BodyInit = init.bytes ?? body;
  return new Response(payload, {
    status: init.status ?? 200,
    headers: init.contentType ? { 'content-type': init.contentType } : {},
  });
}

describe('调度器：格式分流', () => {
  beforeEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('application/json + TVBox 形状 → json.tvbox', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(TVBOX_JSON, { contentType: 'application/json' }));

    const result = await crawl<{ list: unknown[] }>({ intent: 'catalog', url: API });

    expect(result.ruleId).toBe('cms.json');
    expect(result.parserId).toBe('json.tvbox');
    expect(result.value.list).toHaveLength(1);
    expect(result.attempts.at(-1)?.ok).toBe(true);
  });

  it('text/html 但正文是 JSON（CHG-06）→ cms.json-on-html-mime', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond(TVBOX_JSON, { contentType: 'text/html; charset=utf-8' }),
    );

    const result = await crawl<{ list: unknown[] }>({ intent: 'catalog', url: API });

    expect(result.ruleId).toBe('cms.json-on-html-mime');
    expect(result.value.list).toHaveLength(1);
  });

  it('真正的 HTML 落地页 → E_UNSUPPORTED_FORMAT，且不重试', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond('<!doctype html><html><body>blocked</body></html>', { contentType: 'text/html' }),
    );

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FORMAT',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('图片魔数（伪装成 application/json）→ 拒绝且 detail 标出 magic', async () => {
    const bmp = new Uint8Array([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { contentType: 'application/json', bytes: bmp }));

    try {
      await crawl({ intent: 'catalog', url: API });
      throw new Error('预期抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const error = e as AppError;
      expect(error.code).toBe('E_UNSUPPORTED_FORMAT');
      expect(error.detail).toContain('图片');
      expect(error.detail).toContain('bmp');
    }
  });

  it('空响应 → E_UNSUPPORTED_FORMAT，detail 说明响应体为空', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('   ', { contentType: 'application/json' }));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FORMAT',
    });
  });

  it('JSON 但缺 list/class → NOT_TVBOX 文案', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond(JSON.stringify({ code: 1, data: [] }), { contentType: 'application/json' }),
    );

    try {
      await crawl({ intent: 'catalog', url: API });
      throw new Error('预期抛出');
    } catch (e) {
      const error = e as AppError;
      expect(error.code).toBe('E_UNSUPPORTED_FORMAT');
      expect(error.message).toContain('TVBox');
    }
  });

  it('JSON 数组响应（少数站点）→ 包成 {list}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond(JSON.stringify([{ vod_id: 1 }]), { contentType: 'application/json' }),
    );

    const result = await crawl<{ list: unknown[] }>({ intent: 'catalog', url: API });
    expect(result.value.list).toHaveLength(1);
  });

  it('403 且无可用变体 → E_HTTP_403（不误判成格式错误）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { status: 403 }));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({ code: 'E_HTTP_403' });
  });

  it('404 空响应体 → E_HTTP_404（不被 reject.empty 吞掉）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { status: 404 }));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({ code: 'E_HTTP_404' });
  });

  it('401 → E_AUTH（与 httpClient 同一映射）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { status: 401 }));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({ code: 'E_AUTH' });
  });

  it('网络失败 → E_NETWORK', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({ code: 'E_NETWORK' });
  });
});

describe('调度器：订阅意图', () => {
  beforeEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  it('JSON 订阅原样返回文本', async () => {
    const body = JSON.stringify({ sites: [{ key: 'a', name: 'A', type: 1, api: 'https://a.example.com' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(body, { contentType: 'application/json' }));

    const result = await crawl<{ text: string }>({ intent: 'subscription', url: 'https://sub.example.com/s.json' });

    expect(result.ruleId).toBe('sub.raw');
    expect(result.parserId).toBe('sub.raw');
    expect(result.value.text).toBe(body);
  });

  it('逐行 URL 多仓索引原样返回文本', async () => {
    const body = 'https://a.example.com/box.json\nhttps://b.example.com/box.json';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(body, { contentType: 'text/plain' }));

    const result = await crawl<{ text: string }>({ intent: 'subscription', url: 'https://sub.example.com/dc.txt' });

    expect(result.ruleId).toBe('sub.raw');
    expect(result.value.text).toBe(body);
  });

  it('GBK 订阅按 GBK 解码（不产生替换字符）', async () => {
    // `{"name":"中文"}` 的 GBK 编码（中文部分）
    const prefix = new TextEncoder().encode('{"name":"');
    const suffix = new TextEncoder().encode('"}');
    const gbkName = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const bytes = new Uint8Array([...prefix, ...gbkName, ...suffix]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond('', { contentType: 'text/plain', bytes }),
    );

    const result = await crawl<{ text: string }>({ intent: 'subscription', url: 'https://sub.example.com/s.json' });
    expect(result.value.text).toBe('{"name":"中文"}');
  });

  it('图片伪装 → E_UNSUPPORTED_FORMAT', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('', { contentType: 'image/png', bytes: png }));

    await expect(crawl({ intent: 'subscription', url: 'https://sub.example.com/s.json' })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FORMAT',
    });
  });
});

describe('调度器：播放页意图', () => {
  beforeEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  it('页面含 m3u8 → 取出绝对地址', async () => {
    const html = '<script>const url = "/2026/x/index.m3u8?sign=1";</script>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(html, { contentType: 'text/html' }));

    const result = await crawl<string>({
      intent: 'playpage',
      url: 'https://site.example.com/share/abc',
    });

    expect(result.ruleId).toBe('playpage.html-media');
    expect(result.value).toBe('https://site.example.com/2026/x/index.m3u8?sign=1');
  });

  it('页面本身就是清单 → 原样返回 URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond('#EXTM3U\n#EXT-X-VERSION:3\n', { contentType: 'application/vnd.apple.mpegurl' }),
    );

    const result = await crawl<string>({ intent: 'playpage', url: 'https://site.example.com/play/x/index.m3u8' });
    expect(result.value).toBe('https://site.example.com/play/x/index.m3u8');
  });

  it('页面无媒体地址 → E_NO_PLAY_URL（不是格式不支持）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond('<html><body>该视频已下架</body></html>', { contentType: 'text/html' }),
    );

    await expect(crawl({ intent: 'playpage', url: 'https://site.example.com/share/gone' })).rejects.toMatchObject({
      code: 'E_NO_PLAY_URL',
    });
  });
});

describe('调度器：XML 意图', () => {
  beforeEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  it('RSS 响应 → xml.vod 归一成 TVBox list', async () => {
    const rss = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>XML 影片</title>
    <guid>42</guid>
    <enclosure url="https://img.example.com/1.jpg" />
    <link>https://cdn.example.com/42.m3u8</link>
  </item>
</channel></rss>`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(rss, { contentType: 'application/rss+xml' }));

    const result = await crawl<{ list: Array<Record<string, unknown>> }>({ intent: 'catalog', url: API });

    expect(result.ruleId).toBe('catalog.xml-vod');
    expect(result.parserId).toBe('xml.vod');
    expect(result.value.list).toHaveLength(1);
    expect(result.value.list[0]?.['vod_name']).toBe('XML 影片');
    expect(result.value.list[0]?.['vod_id']).toBe('42');
    expect(result.value.list[0]?.['vod_play_url']).toBe('XML 影片$https://cdn.example.com/42.m3u8');
    expect(result.value.list[0]?.['vod_play_from']).toBe('线路1');
  });
});

describe('调度器：规则表可替换', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setRules(defaultRules());
    vi.restoreAllMocks();
  });

  it('setRules 替换规则集后按新规则匹配', async () => {
    const custom = {
      id: 'custom.rule',
      priority: 1,
      intent: ['catalog' as const],
      when: { all: [{ field: 'status' as const, op: 'eq' as const, value: 200 }] },
      parser: 'reject.fixed',
      parserOptions: { code: 'E_UNSUPPORTED_FORMAT', message: '自定义拒绝' },
      terminal: true,
      retry: { maxAttempts: 1, backoffMs: [], retryOn: [] },
    };
    setRules([custom]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(TVBOX_JSON, { contentType: 'application/json' }));

    await expect(crawl({ intent: 'catalog', url: API })).rejects.toMatchObject({ message: '自定义拒绝' });
  });

  it('默认规则表含 CHG-06 与图片拒绝规则', () => {
    const ids = getRules().map((rule) => rule.id);
    expect(ids).toContain('cms.json-on-html-mime');
    expect(ids).toContain('reject.image-masquerade');
    expect(ids).toContain('catalog.xml-vod');
  });

  it('各意图默认预算', () => {
    expect(DEFAULT_BUDGET_MS.probe).toBe(3000);
    expect(DEFAULT_BUDGET_MS.subscription).toBeGreaterThanOrEqual(10000);
  });
});

describe('subRawParser 与容错链', () => {
  it('空正文 → 拒绝', () => {
    const text = '   ';
    const fp = fingerprintOf({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text,
      bytes: new TextEncoder().encode(text),
      url: 'https://a.example.com',
    });
    expect(() =>
      subRawParser.parse({
        intent: 'subscription',
        url: 'https://a.example.com',
        status: 200,
        headers: new Headers(),
        text,
        bytes: new TextEncoder().encode(text),
        charset: 'utf-8',
        fingerprint: fp,
        options: {},
        signal: undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {}, scope() { return this; } } as never,
        utils: {} as never,
      }),
    ).toThrow(AppError);
  });

  it('含 // 注释的订阅仍被放行（交给 subscriptionParser 容错）', () => {
    const text = '{\n// 注释\n"sites":[]\n}';
    expect(tolerantParse(text)?.relaxed).toBe('comments');
  });
});
