/**
 * NativeEngine 单元测试（v1.8/CHG-25）
 *
 * 断言：
 * - load 成功流：prepare 带 rect/headers，ready 事件结算，轮询驱动 onTimeUpdate 与丢帧计数
 * - ready 前的 error 事件 → load 拒绝；播放中 error → onError 回调（网络类映射 E_NETWORK）
 * - prepare 本身失败 → 拒绝（E_DECODE）
 * - ended 事件 → onEnded；destroy 释放插件并停轮询
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import type { AppErrorShape } from '@/types';
import { NativeEngine } from '@/player/NativeEngine';

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
    url: 'https://example.com/video.m3u8',
    format: 'hls',
    headers: { Referer: 'https://example.com/' },
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal: false,
  };
}

function mountHost(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('NativeEngine（v1.8/CHG-25）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.fakes.prepare.mockClear();
    h.fakes.release.mockClear();
    h.fakes.progress.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    h.stateListeners.clear();
    document.body.innerHTML = '';
  });

  it('load 成功：prepare 带 rect/headers，ready 结算，轮询驱动 onTimeUpdate/丢帧', async () => {
    const events = {
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    };
    const engine = new NativeEngine(events);
    const host = mountHost();
    engine.attach(host);

    h.fakes.progress.mockResolvedValue({ positionMs: 1000, durationMs: 90000, droppedFrames: 2 });
    const loadPromise = engine.load(makeSource());
    await vi.advanceTimersByTimeAsync(0);

    expect(h.fakes.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/video.m3u8',
        headers: [{ key: 'Referer', value: 'https://example.com/' }],
        rect: expect.objectContaining({ x: 0, y: 0 }),
      }),
    );

    emitState({ state: 'ready', duration: 90000 });
    await expect(loadPromise).resolves.toBeUndefined();
    expect(events.onLoadedMetadata).toHaveBeenCalledWith(90);

    await vi.advanceTimersByTimeAsync(600);
    expect(events.onTimeUpdate).toHaveBeenCalledWith(1, 90, 1);
    expect(engine.getDroppedFrames()).toBe(2);
    expect(engine.getDuration()).toBe(90);

    engine.destroy();
  });

  it('ready 前 error：load 拒绝且不触发 onError 回调', async () => {
    const events = {
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    };
    const engine = new NativeEngine(events);
    engine.attach(mountHost());

    const loadPromise = engine.load(makeSource());
    await vi.advanceTimersByTimeAsync(0);
    emitState({ state: 'error', message: 'Source error' });

    await expect(loadPromise).rejects.toMatchObject({ code: 'E_NETWORK' });
    expect(events.onError).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('播放中 error：走 onError（解码类映射 E_DECODE）', async () => {
    const errors: AppErrorShape[] = [];
    const engine = new NativeEngine({
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: (e) => errors.push(e),
    });
    engine.attach(mountHost());

    const loadPromise = engine.load(makeSource());
    await vi.advanceTimersByTimeAsync(0);
    emitState({ state: 'ready', duration: 1000 });
    await loadPromise;

    emitState({ state: 'error', message: 'Decoder init failed' });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('E_DECODE');
    engine.destroy();
  });

  it('prepare 本身失败：抛 E_DECODE', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('bridge unavailable'));
    const engine = new NativeEngine({
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    });
    engine.attach(mountHost());

    await expect(engine.load(makeSource())).rejects.toMatchObject({ code: 'E_DECODE' });
    engine.destroy();
  });

  it('ended 事件 → onEnded；destroy 调 release 并停止轮询', async () => {
    const events = {
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    };
    const engine = new NativeEngine(events);
    engine.attach(mountHost());

    h.fakes.progress.mockResolvedValue({ positionMs: 500, durationMs: 1000, droppedFrames: 0 });
    const loadPromise = engine.load(makeSource());
    await vi.advanceTimersByTimeAsync(0);
    emitState({ state: 'ready', duration: 1000 });
    await loadPromise;

    emitState({ state: 'ended' });
    expect(events.onEnded).toHaveBeenCalledTimes(1);

    const timeUpdatesBefore = events.onTimeUpdate.mock.calls.length;
    engine.destroy();
    expect(h.fakes.release).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(events.onTimeUpdate.mock.calls.length).toBe(timeUpdatesBefore);
  });
});
