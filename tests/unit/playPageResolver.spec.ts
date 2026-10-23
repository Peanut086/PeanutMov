/**
 * 网页播放页 → 直链解析
 *
 * 用真实 CMS 采集站返回的三种页面形态做断言（2026-10-23 实测）：
 * 1. `/share/<id>`  —— 相对路径 + sign 查询串（非凡、电影天堂、量子）
 * 2. `/play/<id>`   —— 绝对地址写在 `const vid = '...'`（火狐、光速、极速、新浪）
 * 3. `/play/<id>`   —— 页面内同时有 hls.js/dplayer 的 .js 资源，不得误取
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/shared/errors';
import {
  extractMediaFromPage,
  extractPlayUrlFromPage,
  isPlayPageUrl,
  PLAY_PAGE_NOT_FOUND_MESSAGE,
  resolvePlayPage,
} from '@/sources/site/playPageResolver';

/** 非凡/电影天堂/量子：share 页，相对路径 + sign */
const SHARE_PAGE = `<!DOCTYPE html>
<html><head><title>实习医生风云第十一季01</title>
<link rel="stylesheet" href="/frontend/players/css/share.css?v=1763558904">
<script>
    const vid = "f9195e75b0784070189f10f3aa96e026";
    const url = "/20261003/42433_f9195e75/index.m3u8?sign=4a6a16a50fddffaa71ca9ddc3211fd3f";
    const pic = "/20261003/42433_f9195e75/1.jpg";
    const resumeKey = "f9195e75b0784070189f10f3aa96e026:progress";
</script></head>
<body><div id="container"></div>
<script src="/frontend/players/js/hls.js?v=1778345528"></script>
<script src="/frontend/players/artplayer/artplayer.js"></script>
</body></html>`;

/** 火狐/光速/极速/新浪：play 页，绝对地址写在 const vid */
const PLAY_PAGE = `<head>
<script src="https://s2.pstatp.com/cdn/expire-1-M/hls.js/1.1.5/hls.min.js"></script>
<script src="https://s2.pstatp.com/cdn/expire-1-M/dplayer/1.25.1/DPlayer.min.js"></script>
</head><body><div id="dplayer"></div>
<script>
        const vid = 'https://play.hhuus.com/play/egJxyrGd/index.m3u8';
        const videoConfig = { url: vid, type: 'hls' };
</script></body>`;

/** 部分站点把斜杠转义成 `\\/`（JSON 内嵌场景） */
const ESCAPED_PAGE = `<script>window.__DATA__ = {"play":"https:\\/\\/v.gsuus.com\\/play\\/b82ogkge\\/index.m3u8"};</script>`;

describe('isPlayPageUrl', () => {
  it('share / play / html 页 → true', () => {
    expect(isPlayPageUrl('https://super.ffzy-online6.com/share/f9195e75b0784070189f10f3aa96e026')).toBe(true);
    expect(isPlayPageUrl('https://play.hhuus.com/play/egJxyrGd')).toBe(true);
    expect(isPlayPageUrl('https://v.gsuus.com/play/b82ogkge')).toBe(true);
    expect(isPlayPageUrl('https://www.iqiyi.com/v_21r44r76tek.html')).toBe(true);
  });

  it('直链（含 /play/ 前缀的 m3u8）→ false', () => {
    expect(isPlayPageUrl('https://play.hhuus.com/play/egJxyrGd/index.m3u8')).toBe(false);
    expect(isPlayPageUrl('https://v14.rstu6.com/202610/22/L5nDV0feCd27/video/index.m3u8')).toBe(false);
    expect(isPlayPageUrl('https://cdn.example.com/a.mp4?sign=1')).toBe(false);
    expect(isPlayPageUrl('https://cdn.example.com/a.webm')).toBe(false);
  });

  it('空值与非 http 地址 → false', () => {
    expect(isPlayPageUrl(null)).toBe(false);
    expect(isPlayPageUrl('')).toBe(false);
    expect(isPlayPageUrl('magnet:?xt=urn:btih:abc')).toBe(false);
  });
});

describe('extractPlayUrlFromPage', () => {
  it('share 页：相对路径 + sign 转绝对地址', () => {
    const url = extractPlayUrlFromPage(
      SHARE_PAGE,
      'https://super.ffzy-online6.com/share/f9195e75b0784070189f10f3aa96e026',
    );
    expect(url).toBe(
      'https://super.ffzy-online6.com/20261003/42433_f9195e75/index.m3u8?sign=4a6a16a50fddffaa71ca9ddc3211fd3f',
    );
  });

  it('play 页：绝对地址原样取出，不误取 hls.js / DPlayer 的 .js', () => {
    const url = extractPlayUrlFromPage(PLAY_PAGE, 'https://play.hhuus.com/play/egJxyrGd');
    expect(url).toBe('https://play.hhuus.com/play/egJxyrGd/index.m3u8');
  });

  it('转义斜杠（\\\\/）能被还原', () => {
    const url = extractPlayUrlFromPage(ESCAPED_PAGE, 'https://v.gsuus.com/play/b82ogkge');
    expect(url).toBe('https://v.gsuus.com/play/b82ogkge/index.m3u8');
  });

  it('同一页面同时有 m3u8 与 mp4 时优先 m3u8', () => {
    const html = `
      <script>
        const preview = "https://cdn.example.com/preview.mp4";
        const url = "https://cdn.example.com/main/index.m3u8";
      </script>`;
    const list = extractMediaFromPage(html, 'https://cdn.example.com/play/abc');
    expect(list.map((entry) => entry.url)).toEqual([
      'https://cdn.example.com/main/index.m3u8',
      'https://cdn.example.com/preview.mp4',
    ]);
  });

  it('页面无媒体地址 → null', () => {
    expect(extractPlayUrlFromPage('<html><body>403</body></html>', 'https://x.com/share/1')).toBeNull();
    expect(extractPlayUrlFromPage('', 'https://x.com/share/1')).toBeNull();
    expect(extractPlayUrlFromPage(null, 'https://x.com/share/1')).toBeNull();
  });
});

describe('resolvePlayPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('取页面并解析出直链', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(SHARE_PAGE, { headers: { 'content-type': 'text/html' } }),
    );

    const url = await resolvePlayPage('https://super.ffzy-online6.com/share/f9195e75b0784070189f10f3aa96e026');

    expect(url).toBe(
      'https://super.ffzy-online6.com/20261003/42433_f9195e75/index.m3u8?sign=4a6a16a50fddffaa71ca9ddc3211fd3f',
    );
  });

  it('地址本身返回清单文本 → 原样返回（不重复解析）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('#EXTM3U\n#EXT-X-VERSION:3\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
    );

    const url = await resolvePlayPage('https://x.com/play/abc/index.m3u8');

    expect(url).toBe('https://x.com/play/abc/index.m3u8');
  });

  it('页面里找不到地址 → E_NO_PLAY_URL（不是"格式不支持"），detail 带片段', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>该视频已下架</body></html>', { headers: { 'content-type': 'text/html' } }),
    );

    try {
      await resolvePlayPage('https://x.com/share/gone');
      throw new Error('预期抛出 AppError');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const error = e as AppError;
      expect(error.code).toBe('E_NO_PLAY_URL');
      expect(error.message).toBe(PLAY_PAGE_NOT_FOUND_MESSAGE);
      expect(error.detail).toContain('已下架');
      expect(error.retryable).toBe(false);
    }
  });

  it('网络失败原样抛出（交由上层判定源健康度）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(resolvePlayPage('https://x.com/share/1')).rejects.toBeInstanceOf(AppError);
  });
});
