/**
 * PlayerController 原生引擎路由测试（v1.8/CHG-25）
 *
 * 断言：
 * - 开关未开（默认）→ 走 VideoEngine，插件零调用，enginechange 为 'video'
 * - 开关开 + 插件可用 + prepare 成功 → enginechange 'native'，不创建 <video>
 * - 开关开 + prepare 失败 → 发 notice、静默回退 VideoEngine（不发 error，不触发换线兜底）
 * - 开关开 + 插件不可用 → 发 notice + 回退
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';
import { isExoPlayerAvailable } from '@/native/exoPlayerPlugin';

const h = vi.hoisted(() => {
  const stateListeners = new Set<(data: { state: string; message?: string; duration?: number }) => void>();
  const fakes = {
    prepare: vi.fn(async () => undefined),
    setRect: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setRate: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    progress: vi.fn(async () => ({ positionMs: 0, durationMs: 0, droppedFrames: 0 })),
  };
  return { stateListeners, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    ...h.fakes,
    addListener: vi.fn(async (_event: string, cb: (d: { state: string }) => void) => {
      h.stateListeners.add(cb as never);
      return () => {
        h.stateListeners.delete(cb as never);
      };
    }),
  },
  exoHeadersOf: (headers: Record<string, string>) =>
    Object.entries(headers).map(([key, value]) => ({ key, value })),
  isExoPlayerAvailable: vi.fn(async () => true),
}));

function emitState(data: { state: string; message?: string; duration?: number }): void {
  for (const cb of [...h.stateListeners]) cb(data);
}

function makeSource(): PlaybackSource {
  return {
    url: 'https://a.com/video.mp4',
    format: 'mp4',
    headers: {},
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal: false,
  };
}

function makeOptions(preferNativeEngine?: boolean): PlayerLoadOptions {
  return {
    mediaId: 'media-1',
    episodeId: 'episode-1',
    lineId: 'line-1',
    title: '测试影片',
    posterUrl: null,
    playback: makeSource(),
    startPositionSec: 0,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: false,
    ...(preferNativeEngine === undefined ? {} : { preferNativeEngine }),
  };
}

function mount(ctl: PlayerController): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  ctl.mount(el);
  return el;
}

/** VideoEngine 在 jsdom 中不会自动触发 loadedmetadata——手动派发结算 load */
async function settleVideoLoad(ctl: PlayerController): Promise<void> {
  const loadPromise = ctl.load(makeOptions());
  await vi.waitFor(() => {
    if (document.querySelector('video') === null) throw new Error('video 未创建');
  });
  document.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
  await loadPromise;
}

describe('PlayerController 原生引擎路由（v1.8/CHG-25）', () => {
  afterEach(() => {
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.mocked(isExoPlayerAvailable).mockImplementation(async () => true);
    h.fakes.prepare.mockImplementation(async () => undefined);
  });

  it('开关未开：走 VideoEngine，插件零调用', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const kinds: string[] = [];
    ctl.on('enginechange', ({ kind }) => kinds.push(kind));

    await settleVideoLoad(ctl);

    expect(h.fakes.prepare).not.toHaveBeenCalled();
    expect(ctl.getEngineKind()).toBe('video');
    expect(kinds).toEqual(['video']);
    await ctl.destroy();
  });

  it('开关开 + 可用：走 NativeEngine，不创建 <video>', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const kinds: string[] = [];
    const notices: string[] = [];
    ctl.on('enginechange', ({ kind }) => kinds.push(kind));
    ctl.on('notice', ({ message }) => notices.push(message));

    const loadPromise = ctl.load(makeOptions(true));
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
    emitState({ state: 'ready', duration: 60000 });
    await loadPromise;

    expect(ctl.getEngineKind()).toBe('native');
    expect(kinds).toEqual(['native']);
    expect(notices).toEqual([]);
    expect(document.querySelector('video')).toBeNull();
    await ctl.destroy();
    expect(h.fakes.release).toHaveBeenCalled();
  });

  it('开关开 + prepare 失败：发 notice 并回退 VideoEngine（不发 error）', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('prepare failed'));
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const kinds: string[] = [];
    const notices: string[] = [];
    const errors: string[] = [];
    ctl.on('enginechange', ({ kind }) => kinds.push(kind));
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('error', (e) => errors.push(e.code));

    const loadPromise = ctl.load(makeOptions(true));
    // 原生失败 → 回退创建 <video>
    await vi.waitFor(() => {
      if (document.querySelector('video') === null) throw new Error('video 未创建');
    });
    document.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    await loadPromise;

    expect(ctl.getEngineKind()).toBe('video');
    expect(kinds).toEqual(['video']);
    expect(notices).toEqual(['原生引擎不可用，已切回内置引擎']);
    expect(errors).toEqual([]);
    expect(h.fakes.release).toHaveBeenCalled();
    await ctl.destroy();
  });

  it('开关开 + 插件不可用：发 notice 并回退 VideoEngine', async () => {
    vi.mocked(isExoPlayerAvailable).mockImplementation(async () => false);
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const notices: string[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));

    const loadPromise = ctl.load(makeOptions(true));
    await vi.waitFor(() => {
      if (document.querySelector('video') === null) throw new Error('video 未创建');
    });
    document.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    await loadPromise;

    expect(notices).toEqual(['原生引擎不可用，已切回内置引擎']);
    expect(ctl.getEngineKind()).toBe('video');
    expect(h.fakes.prepare).not.toHaveBeenCalled();
    await ctl.destroy();
  });
});
