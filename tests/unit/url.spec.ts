import { describe, expect, it } from 'vitest';

import { normalizeBaseUrl, isValidHttpUrl, guessFormatFromUrl, joinUrl, withQuery, toAbsoluteUrl, redactUrl } from '@/shared/url';

/**
 * shared/url.ts 单测（AC-05 地址归一化、AC-40 格式推断）
 */
describe('URL 工具（AC-05 / AC-40）', () => {
  it('归一化根地址：去尾斜杠、域名小写、去默认端口', () => {
    expect(normalizeBaseUrl('https://Example.COM/')).toBe('https://example.com');
    expect(normalizeBaseUrl('https://example.com///')).toBe('https://example.com');
    expect(normalizeBaseUrl('http://example.com:80/a/')).toBe('http://example.com/a');
    expect(normalizeBaseUrl('https://example.com:443')).toBe('https://example.com');
    expect(normalizeBaseUrl('https://example.com/Movies')).toBe('https://example.com/Movies');
  });

  it('带 / 与不带 / 归一化为同一形式（AC-05）', () => {
    expect(normalizeBaseUrl('https://nas.example.com/dav/')).toBe(
      normalizeBaseUrl('https://nas.example.com/dav'),
    );
  });

  it('协议校验：仅接受 http/https 绝对地址', () => {
    expect(isValidHttpUrl('https://a.com')).toBe(true);
    expect(isValidHttpUrl('http://a.com:8080/x')).toBe(true);
    expect(isValidHttpUrl('ftp://a.com')).toBe(false);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('example.com')).toBe(false);
    expect(isValidHttpUrl('   ')).toBe(false);
    expect(isValidHttpUrl(null)).toBe(false);
  });

  it('格式推断：m3u8 / mp4 / webm / ts，未知返回 null', () => {
    expect(guessFormatFromUrl('https://a.com/x.m3u8?token=1')).toBe('hls');
    expect(guessFormatFromUrl('https://a.com/x.MP4')).toBe('mp4');
    expect(guessFormatFromUrl('https://a.com/x.webm#t=10')).toBe('webm');
    expect(guessFormatFromUrl('https://a.com/x.ts')).toBe('ts');
    expect(guessFormatFromUrl('https://a.com/x.mpd')).toBe(null);
    expect(guessFormatFromUrl(null)).toBe(null);
  });

  it('拼接：避免重复斜杠，绝对地址直接返回', () => {
    expect(joinUrl('https://a.com/', '/api/x')).toBe('https://a.com/api/x');
    expect(joinUrl('https://a.com', 'api', 'x')).toBe('https://a.com/api/x');
    expect(joinUrl('https://a.com', 'https://b.com/y')).toBe('https://b.com/y');
  });

  it('相对地址转绝对；协议相对补全', () => {
    expect(toAbsoluteUrl('https://a.com/x/', '../y.mp4')).toBe('https://a.com/y.mp4');
    expect(toAbsoluteUrl('https://a.com', '//cdn.b.com/p.jpg')).toBe('https://cdn.b.com/p.jpg');
    expect(toAbsoluteUrl('https://a.com', 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(toAbsoluteUrl('not-a-url', 'x.mp4')).toBe(null);
  });

  it('查询参数拼接与脱敏', () => {
    expect(withQuery('https://a.com/x', { ac: 'detail', pg: 2, skip: null })).toBe(
      'https://a.com/x?ac=detail&pg=2',
    );
    expect(withQuery('https://a.com/x?t=1', { pg: 2 })).toBe('https://a.com/x?t=1&pg=2');
    expect(redactUrl('https://a.com/x?token=secret&api_key=abc&id=1')).toBe(
      'https://a.com/x?token=***&api_key=***&id=1',
    );
  });
});
