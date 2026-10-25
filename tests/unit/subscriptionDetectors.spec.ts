/**
 * 订阅内容检测器单测（v1.7 / CHG-18，AC-114 / AC-116）
 */
import { describe, expect, it } from 'vitest';

import {
  detectCmsApiPayload,
  detectLiveList,
  looksLikeHtmlText,
  sniffHtmlConfigLinks,
} from '@/sources/pipeline/detectors';

describe('detectCmsApiPayload（AC-116）', () => {
  it('macCMS 响应形态（code+list）命中', () => {
    expect(detectCmsApiPayload('{"code":1,"msg":"ok","page":1,"list":[{"vod_id":1}],"class":[]}')).toBe(true);
  });

  it('仅 class 的分类接口命中', () => {
    expect(detectCmsApiPayload('{"code":1,"class":[{"type_id":1,"type_name":"电影"}]}')).toBe(true);
  });

  it('TVBox 订阅（sites[]）不误判', () => {
    expect(detectCmsApiPayload('{"sites":[{"key":"a","name":"A","api":"https://x","type":0}]}')).toBe(false);
  });

  it('多仓索引（urls[]）不误判', () => {
    expect(detectCmsApiPayload('{"urls":["https://a.com/1.json"]}')).toBe(false);
  });

  it('直播 txt / HTML / 非 JSON 不误判', () => {
    expect(detectCmsApiPayload('#EXTM3U\n#EXTINF:-1,CCTV\nhttp://a/1.m3u8')).toBe(false);
    expect(detectCmsApiPayload('<html><body>hi</body></html>')).toBe(false);
    expect(detectCmsApiPayload('not json')).toBe(false);
  });
});

describe('detectLiveList（AC-114）', () => {
  it('多路 m3u → live-list', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="cctv1" group-title="央视频道",CCTV-1\nhttp://a/1.m3u8\n#EXTINF:-1,CCTV-2\nhttp://a/2.m3u8';
    expect(detectLiveList(m3u)).toEqual({ kind: 'live-list', format: 'm3u', channelCount: 2 });
  });

  it('单流 m3u8（无 EXTINF）→ single-stream', () => {
    expect(detectLiveList('#EXTM3U\nhttp://a/video.m3u8')).toEqual({
      kind: 'single-stream',
      format: 'm3u',
      channelCount: 0,
    });
  });

  it('仅 1 路 EXTINF → single-stream', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1,广东体育\nhttp://a/gd.m3u8';
    expect(detectLiveList(m3u)).toEqual({ kind: 'single-stream', format: 'm3u', channelCount: 1 });
  });

  it('TVBox txt（#genre#）→ live-list', () => {
    const txt = '央视频道,#genre#\nCCTV-1,http://a/1.m3u8\nCCTV-2,http://a/2.m3u8#需要验证';
    const result = detectLiveList(txt);
    expect(result?.kind).toBe('live-list');
    expect(result?.format).toBe('txt');
    expect(result?.channelCount).toBe(2);
  });

  it('TVBox 订阅 JSON 不误判为直播', () => {
    expect(detectLiveList('{"sites":[]}')).toBeNull();
  });
});

describe('looksLikeHtmlText', () => {
  it('doctype / 标签开头命中，JSON 不命中', () => {
    expect(looksLikeHtmlText('<!DOCTYPE html><html>…</html>')).toBe(true);
    expect(looksLikeHtmlText('{"sites":[]}')).toBe(false);
  });
});

describe('sniffHtmlConfigLinks（AC-113）', () => {
  it('抽取同域 .json/.txt/api.php 候选，跨域剔除，api.php 优先', () => {
    const html = [
      '<html><body>',
      '<a href="https://cdn.other.com/box.json">外域</a>',
      '<a href="/dc.txt">影视仓多仓</a>',
      '<a href="api.php?ou=index">接口</a>',
      '<a href="https://example.com/tv.json">单仓</a>',
      '</body></html>',
    ].join('');
    const links = sniffHtmlConfigLinks(html, 'https://example.com/', 5);
    expect(links[0]).toBe('https://example.com/api.php?ou=index');
    expect(links.some((l) => l === 'https://example.com/dc.txt')).toBe(true);
    expect(links.some((l) => l === 'https://example.com/tv.json')).toBe(true);
    expect(links.every((l) => l.startsWith('https://example.com/'))).toBe(true);
  });

  it('meta refresh 跳转目标作为候选', () => {
    const html = '<html><head><meta http-equiv="refresh" content="0; url=/real.json"></head></html>';
    expect(sniffHtmlConfigLinks(html, 'https://example.com/short')).toEqual(['https://example.com/real.json']);
  });

  it('上限截断', () => {
    const html = ['<a href="/1.json">1</a>', '<a href="/2.json">2</a>', '<a href="/3.txt">3</a>', '<a href="/4.json">4</a>'].join('');
    expect(sniffHtmlConfigLinks(html, 'https://example.com/x', 3).length).toBe(3);
  });
});
