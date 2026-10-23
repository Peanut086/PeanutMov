/**
 * 管道指纹与解码单测（Phase 0 判据）
 *
 * 覆盖 7 类样本：JSON / HTML 包 JSON / XML / 图片魔数 / GBK / 空响应 / 逐行 URL。
 * 全部使用合成样本（example.com），不落任何第三方地址（AC-105）。
 */
import { describe, expect, it } from 'vitest';

import { decodeBody } from '@/sources/pipeline/decode';
import { fingerprintOf, jsonKeysOf, magicOf, mimeOf, retryAfterMsOf } from '@/sources/pipeline/fingerprint';

const ENCODER = new TextEncoder();

function fpOf(body: string, init: { contentType?: string; status?: number; bytes?: Uint8Array } = {}) {
  const bytes = init.bytes ?? ENCODER.encode(body);
  const headers = new Headers(init.contentType ? { 'content-type': init.contentType } : {});
  return fingerprintOf({
    status: init.status ?? 200,
    headers,
    text: body,
    bytes,
    url: 'https://site.example.com/api',
  });
}

describe('decodeBody', () => {
  it('UTF-8 正文按 UTF-8 解码', () => {
    const decoded = decodeBody({ bytes: ENCODER.encode('{"name":"中文"}'), contentType: 'application/json' });
    expect(decoded.text).toBe('{"name":"中文"}');
    expect(decoded.charset).toBe('utf-8');
  });

  it('header 声明 GBK 时按 GBK 解码（中文不乱码）', () => {
    // "中文" 的 GBK 字节
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const decoded = decodeBody({ bytes: gbkBytes, contentType: 'text/html; charset=gbk' });
    expect(decoded.text).toBe('中文');
    expect(decoded.charset).toBe('gbk');
  });

  it('无 charset 且正文是 GBK：探测为 GBK', () => {
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const decoded = decodeBody({ bytes: gbkBytes, contentType: 'text/html' });
    expect(decoded.text).toBe('中文');
    expect(decoded.charset).toBe('gbk');
  });

  it('GB2312 / GB18030 归一为 GBK', () => {
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeBody({ bytes: gbkBytes, contentType: 'text/html; charset=gb2312' }).charset).toBe('gbk');
    expect(decodeBody({ bytes: gbkBytes, contentType: 'text/html; charset=GB18030' }).charset).toBe('gbk');
  });

  it('UTF-8 BOM 被剥离', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...ENCODER.encode('{"a":1}')]);
    const decoded = decodeBody({ bytes, contentType: 'application/json' });
    expect(decoded.text).toBe('{"a":1}');
  });

  it('不支持的 charset 名不抛错（落到探测）', () => {
    const decoded = decodeBody({ bytes: ENCODER.encode('{"a":1}'), contentType: 'text/plain; charset=x-unknown-enc' });
    expect(decoded.text).toBe('{"a":1}');
  });
});

describe('magicOf', () => {
  it('识别 PNG / JPEG / GIF / BMP', () => {
    expect(magicOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('png');
    expect(magicOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(magicOf(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('gif');
    expect(magicOf(new Uint8Array([0x42, 0x4d, 0x00, 0x00]))).toBe('bmp');
  });

  it('JSON 正文不误判为图片', () => {
    expect(magicOf(ENCODER.encode('{"list":[]}'))).toBeNull();
  });
});

describe('jsonKeysOf', () => {
  it('词法扫描顶层键，不要求合法 JSON', () => {
    const keys = jsonKeysOf('{"code":1,"list":[{"vod_id":1}],"class":[]}');
    expect(keys).toContain('code');
    expect(keys).toContain('list');
    expect(keys).toContain('class');
    expect(keys).toContain('vod_id');
  });

  it('截断的 JSON 也能扫出键（不 parse）', () => {
    expect(jsonKeysOf('{"code":1,"list":[{"vod_id":1')).toEqual(expect.arrayContaining(['code', 'list']));
  });
});

describe('mimeOf / retryAfterMsOf', () => {
  it('mime 去参数并小写', () => {
    expect(mimeOf('Text/HTML; charset=UTF-8')).toBe('text/html');
    expect(mimeOf(null)).toBe('');
  });

  it('Retry-After 秒数转毫秒', () => {
    expect(retryAfterMsOf('30')).toBe(30_000);
    expect(retryAfterMsOf(null)).toBeNull();
    expect(retryAfterMsOf('not-a-date')).toBeNull();
  });
});

describe('fingerprintOf 结构判定', () => {
  it('JSON：首字符 { + 顶层键', () => {
    const fp = fpOf('{"code":1,"list":[]}', { contentType: 'application/json' });
    expect(fp.looksLikeJson).toBe(true);
    expect(fp.firstChar).toBe('{');
    expect(fp.jsonKeys).toContain('list');
    expect(fp.looksLikeHtml).toBe(false);
    expect(fp.empty).toBe(false);
  });

  it('text/html 但正文是 JSON（CHG-06 场景）', () => {
    const fp = fpOf('{"code":1,"list":[]}', { contentType: 'text/html; charset=utf-8' });
    expect(fp.mime).toBe('text/html');
    expect(fp.looksLikeJson).toBe(true);
    expect(fp.looksLikeHtml).toBe(false);
  });

  it('真正的 HTML 落地页', () => {
    const fp = fpOf('<!doctype html><html><body>blocked</body></html>', { contentType: 'text/html' });
    expect(fp.looksLikeHtml).toBe(true);
    expect(fp.looksLikeJson).toBe(false);
  });

  it('XML / RSS', () => {
    const fp = fpOf('<?xml version="1.0"?><rss><channel><item><title>A</title></item></channel></rss>', {
      contentType: 'application/rss+xml',
    });
    expect(fp.looksLikeXml).toBe(true);
    expect(fp.looksLikeJson).toBe(false);
  });

  it('图片魔数优先于 Content-Type（伪装成 .json 的 BMP）', () => {
    const bytes = new Uint8Array([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]);
    const fp = fpOf('\u0042\u004d', { contentType: 'application/json', bytes });
    expect(fp.magic).toBe('bmp');
    expect(fp.looksLikeImage).toBe(true);
  });

  it('空响应', () => {
    const fp = fpOf('   \n  ', { contentType: 'application/json' });
    expect(fp.empty).toBe(true);
  });

  it('逐行 URL 列表（多仓索引）', () => {
    const fp = fpOf('https://a.example.com/box.json\nhttps://b.example.com/box.json', {
      contentType: 'text/plain',
    });
    expect(fp.looksLikeJson).toBe(false);
    expect(fp.looksLikeHtml).toBe(false);
    expect(fp.looksLikeXml).toBe(false);
    expect(fp.empty).toBe(false);
  });

  it('结构哈希不含易变内容：列表条目变化不影响 hash', () => {
    const a = fpOf('{"code":1,"list":[{"vod_id":1}]}', { contentType: 'application/json' });
    const b = fpOf('{"code":1,"list":[{"vod_id":2},{"vod_id":3}]}', { contentType: 'application/json' });
    expect(a.hash).toBe(b.hash);
  });

  it('结构哈希随顶层键变化', () => {
    const a = fpOf('{"code":1,"list":[]}', { contentType: 'application/json' });
    const b = fpOf('{"code":1,"class":[]}', { contentType: 'application/json' });
    expect(a.hash).not.toBe(b.hash);
  });
});
