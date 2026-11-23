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

  /**
   * P1-5：单/双字母签名键（`?s=` 夸克直链签名、`?do=` 网盘代理口令）。
   * 真机 39 处 `?s=` 里 35 处是采集站搜索词、4 处才是签名——只按形状决定打不打，
   * 无差别盖掉会把「哪个词发到哪个源」这条线索废掉。口径与原生 `LogRedactor` 一致。
   */
  it('短签名键只在长成签名样子时打码', () => {
    expect(redactUrl('https://a.com/d.m3u8?s=ZEOp28Xq1i79ab34%2F&t=1763000000')).toBe(
      'https://a.com/d.m3u8?s=***&t=1763000000',
    );
    expect(redactUrl('https://a.com/api.php/provide/vod/?ac=detail&s=剑来')).toBe(
      'https://a.com/api.php/provide/vod/?ac=detail&s=剑来',
    );
    expect(redactUrl('https://a.com/x?s=abc12')).toBe('https://a.com/x?s=abc12');
    expect(redactUrl('https://a.com/proxy?do=YWJjZGVmZ2hpamsxMjM0')).toBe(
      'https://a.com/proxy?do=***',
    );
    // 幂等：已打码的再跑一遍不能变形
    expect(redactUrl('https://a.com/d.m3u8?s=***&t=1')).toBe('https://a.com/d.m3u8?s=***&t=1');
  });

  /**
   * OPT-26（P0-②-2）：引擎链日志会把直链原样打出来，CDN 签名族必须一并盖住。
   * 口径：参数名含凭据语素（auth/sign/secret/token/key…）**且**值长成签名样子才打码——
   * 只按名字会把 `keyword=` 这类搜索词一起盖掉（那是请求侧唯一线索）。
   */
  it('CDN 签名参数按「名 + 形」双重判定打码', () => {
    // 阿里云 CDN 时间戳防盗链：真机下载/播放链路最常见的一族
    expect(redactUrl('https://a.com/vod/1.m3u8?auth_key=1794912583-a-b-c')).toBe(
      'https://a.com/vod/1.m3u8?auth_key=***',
    );
    // 网宿（夸克/UC 直链走的就是这一族）
    expect(redactUrl('https://a.com/d.mp4?wsSecret=9a8b7c6d5e4f3a2b1c0d&wsTime=1763000000')).toBe(
      'https://a.com/d.mp4?wsSecret=***&wsTime=1763000000',
    );
    // 对象存储预签名：`X-Amz-Signature` / `OSSAccessKeyId` 都不是旧名单里的精确名
    expect(redactUrl('https://a.com/f.mp4?X-Amz-Signature=DEADBEEF0123&x=1')).toBe(
      'https://a.com/f.mp4?X-Amz-Signature=***&x=1',
    );
    expect(redactUrl('https://a.com/f.mp4?OSSAccessKeyId=LTAI5t9YngqQ&Expires=1763000000')).toBe(
      'https://a.com/f.mp4?OSSAccessKeyId=***&Expires=1763000000',
    );
    // 名字像凭据、值却不是签名样子的（普通序号 / 纯数字时间戳）保持原样
    expect(redactUrl('https://a.com/api?signature=1&Expires=1763000000')).toBe(
      'https://a.com/api?signature=1&Expires=1763000000',
    );
    // 精确凭据名是无条件打码的（旧口径不变，与形状无关）
    expect(redactUrl('https://a.com/api?auth=0&token=x')).toBe('https://a.com/api?auth=***&token=***');
    // 搜索词不能被牵连：`keyword` 里含 `key`，中文编码后也像签名字符集
    const encoded = encodeURIComponent('士兵突击');
    expect(redactUrl(`https://a.com/search?keyword=${encoded}`)).toBe(
      `https://a.com/search?keyword=${encoded}`,
    );
  });
});
