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
import { NATIVE_METADATA_TIMEOUT_MS } from '@/player/constants';
import { getExoPlayerStatus } from '@/native/exoPlayerPlugin';

const h = vi.hoisted(() => {
  const stateListeners = new Set<(data: {
    state: string;
    message?: string;
    duration?: number;
    positionMs?: number;
    hasVideoTrack?: boolean;
  }) => void>();
  const fakes = {
    prepare: vi.fn(async () => undefined),
    setRect: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setRate: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setResizeMode: vi.fn(async () => undefined),
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
      return { remove: async () => { h.stateListeners.delete(cb as never); } };
    }),
  },
  exoHeadersOf: (headers: Record<string, string>) =>
    Object.entries(headers).map(([key, value]) => ({ key, value })),
  isExoPlayerAvailable: vi.fn(async () => true),
  getExoPlayerStatus: vi.fn(async () => ({
    available: true,
    supported: true,
    safeMode: false,
    reason: null,
  })),
}));

function emitState(data: {
  state: string;
  message?: string;
  duration?: number;
  positionMs?: number;
  hasVideoTrack?: boolean;
}): void {
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
    vi.useRealTimers();
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.mocked(getExoPlayerStatus).mockResolvedValue({
      available: true,
      supported: true,
      safeMode: false,
      reason: null,
    });
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
    const nativeAttempts: boolean[] = [];
    ctl.on('enginechange', ({ kind }) => kinds.push(kind));
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('nativeattempt', ({ active }) => nativeAttempts.push(active));

    const loadPromise = ctl.load(makeOptions(true));
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
    expect(nativeAttempts).toEqual([true]);
    emitState({ state: 'ready', duration: 60000 });
    emitState({ state: 'firstframe', positionMs: 0 });
    await loadPromise;

    expect(ctl.getEngineKind()).toBe('native');
    expect(kinds).toEqual(['native']);
    expect(notices).toEqual([]);
    expect(document.querySelector('video')).toBeNull();
    await ctl.destroy();
    expect(nativeAttempts).toEqual([true, false]);
    expect(h.fakes.release).toHaveBeenCalled();
  });

  it('开关开 + prepare 失败：发 notice 并回退 VideoEngine（不发 error）', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('prepare failed'));
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const kinds: string[] = [];
    const notices: string[] = [];
    const errors: string[] = [];
    const nativeAttempts: boolean[] = [];
    ctl.on('enginechange', ({ kind }) => kinds.push(kind));
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('error', (e) => errors.push(e.code));
    ctl.on('nativeattempt', ({ active }) => nativeAttempts.push(active));

    const loadPromise = ctl.load(makeOptions(true));
    // 原生失败 → 回退创建 <video>
    await vi.waitFor(() => {
      if (document.querySelector('video') === null) throw new Error('video 未创建');
    });
    expect(nativeAttempts).toEqual([true, false]);
    document.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    await loadPromise;

    expect(ctl.getEngineKind()).toBe('video');
    expect(kinds).toEqual(['video']);
    expect(notices).toEqual(['原生加载解码失败，已切回内置引擎']);
    expect(errors).toEqual([]);
    expect(h.fakes.release).toHaveBeenCalled();
    await ctl.destroy();
  });

  it('开关开 + 插件不可用：发 notice 并回退 VideoEngine', async () => {
    vi.mocked(getExoPlayerStatus).mockResolvedValueOnce({
      available: false,
      supported: false,
      safeMode: false,
      reason: 'plugin_missing',
    });
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const notices: string[] = [];
    const nativeAttempts: boolean[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('nativeattempt', ({ active }) => nativeAttempts.push(active));

    const loadPromise = ctl.load(makeOptions(true));
    await vi.waitFor(() => {
      if (document.querySelector('video') === null) throw new Error('video 未创建');
    });
    document.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    await loadPromise;

    expect(notices).toEqual(['原生播放器插件不可用，已切回内置引擎']);
    expect(ctl.getEngineKind()).toBe('video');
    expect(nativeAttempts).toEqual([]);
    expect(h.fakes.prepare).not.toHaveBeenCalled();
    await ctl.destroy();
  });

  it('开关开 + 安全模式：能力检查前置，提示明确且不调用 prepare', async () => {
    vi.mocked(getExoPlayerStatus).mockResolvedValueOnce({
      available: false,
      supported: true,
      safeMode: true,
      reason: 'safe_mode',
    });
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

    expect(notices).toEqual(['安全模式已关闭原生播放器，已切回内置引擎']);
    expect(ctl.getEngineKind()).toBe('video');
    expect(h.fakes.prepare).not.toHaveBeenCalled();
    await ctl.destroy();
  });

  it('开关开 + prepare 报安全模式：仍按安全模式提示', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('safe mode active: native player disabled'));
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

    expect(notices).toEqual(['安全模式已关闭原生播放器，已切回内置引擎']);
    expect(ctl.getEngineKind()).toBe('video');
    await ctl.destroy();
  });

  it('开关开 + 原生加载超时：提示超时并回退 VideoEngine', async () => {
    vi.useFakeTimers();
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const notices: string[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));

    const loadPromise = ctl.load(makeOptions(true));
    await vi.advanceTimersByTimeAsync(NATIVE_METADATA_TIMEOUT_MS);
    await vi.waitFor(() => {
      if (document.querySelector('video') === null) throw new Error('video 未创建');
    });
    document.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    await loadPromise;

    expect(notices).toEqual(['原生加载超时，已切回内置引擎']);
    expect(ctl.getEngineKind()).toBe('video');
    await ctl.destroy();
  });
});
