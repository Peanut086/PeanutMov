/**
 * PlayerController 加载路径测试：AC-40 前置守卫 + AC-52 状态栏接线
 *
 * 断言：
 * - `.mpd` 在创建任何引擎实例/发请求之前被拒绝，最终 `E_UNSUPPORTED_FORMAT`
 * - m3u8 预检返回 SAMPLE-AES 文本时抛 `E_DRM_PROTECTED`，且不创建 hls 实例
 * - 预检失败（网络抖动）时回退正常加载，不被误判为 DRM
 * - 进入/退出全屏时调用注入的 `setStatusBarVisible(false/true)`
 */
import { describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';

function makeSource(url: string, format: PlaybackSource['format']): PlaybackSource {
  return {
    url,
    format,
    headers: {},
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal: false,
  };
}

function makeOptions(playback: PlaybackSource): PlayerLoadOptions {
  return {
    mediaId: 'media-1',
    episodeId: 'episode-1',
    lineId: 'line-1',
    title: '测试影片',
    posterUrl: null,
    playback,
    startPositionSec: 0,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: false,
  };
}

/** 挂载容器（PlayerController 需要宿主元素） */
function mount(ctl: PlayerController): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  ctl.mount(el);
  return el;
}

describe('PlayerController 源守卫（AC-40）', () => {
  it('.mpd：不创建 video/hls、不发请求，直接抛 E_UNSUPPORTED_FORMAT', async () => {
    const errors: string[] = [];
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    ctl.on('error', (e) => errors.push(e.code));

    // 打点：验证没有引擎被创建（容器内不会出现 <video>，且不会发起请求）
    const fetchSpy = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(ctl.load(makeOptions(makeSource('https://a.com/manifest.mpd', 'mp4')))).rejects.toThrow(
      /暂不支持 DASH/,
    );
    expect(errors).toEqual(['E_UNSUPPORTED_FORMAT']);
    expect(document.querySelector('video')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('m3u8 预检命中 SAMPLE-AES：抛 E_DRM_PROTECTED 且不创建 hls 实例', async () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.example.com/"',
      '#EXTINF:10,',
      'a.ts',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(manifest)));

    const errors: string[] = [];
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    ctl.on('error', (e) => errors.push(e.code));

    await expect(
      ctl.load(makeOptions(makeSource('https://a.com/index.m3u8', 'hls'))),
    ).rejects.toThrow(/不支持受保护内容/);
    expect(errors).toEqual(['E_DRM_PROTECTED']);
    // 未创建 hls 引擎：容器内无 video 元素
    expect(document.querySelector('video')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('预检失败（网络抖动）不回判 DRM：继续正常加载路径', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    // hls.js 在 happy-dom 不可用 → isHlsSupported()=false → 抛 E_UNSUPPORTED_FORMAT，
    // 关键是**不是** E_DRM_PROTECTED（证明预检失败未误判）
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);

    await expect(
      ctl.load(makeOptions(makeSource('https://a.com/index.m3u8', 'hls'))),
    ).rejects.toThrow(/不支持 HLS/);
    vi.unstubAllGlobals();
  });
});

describe('PlayerController 状态栏接线（AC-52）', () => {
  it('进入全屏调 setStatusBarVisible(false)，退出调 true', async () => {
    const setStatusBarVisible = vi.fn();
    const ctl = new PlayerController({ onProgress: () => {}, setStatusBarVisible });
    mount(ctl);

    await ctl.enterFullscreen();
    expect(setStatusBarVisible).toHaveBeenCalledWith(false);

    await ctl.exitFullscreen();
    expect(setStatusBarVisible).toHaveBeenLastCalledWith(true);
    expect(setStatusBarVisible).toHaveBeenCalledTimes(2);
  });

  it('setStatusBarVisible 抛错不阻断全屏', async () => {
    const setStatusBarVisible = vi.fn(() => {
      throw new Error('StatusBar plugin unavailable');
    });
    const ctl = new PlayerController({ onProgress: () => {}, setStatusBarVisible });
    mount(ctl);

    await expect(ctl.enterFullscreen()).resolves.toBeUndefined();
    expect(ctl.fullscreen.isActive).toBe(true);
    await expect(ctl.exitFullscreen()).resolves.toBeUndefined();
    expect(ctl.fullscreen.isActive).toBe(false);
  });
});
