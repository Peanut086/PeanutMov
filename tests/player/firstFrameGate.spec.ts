import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';
import {
  BLACK_FRAME_CHECK_INTERVAL_MS,
  FIRST_FRAME_POLL_MS,
  FIRST_FRAME_TIMEOUT_MS,
  NO_VIDEO_CHECK_DELAY_MS,
} from '@/player/constants';

interface StateData {
  state: string;
  message?: string;
  duration?: number;
  positionMs?: number;
  hasVideoTrack?: boolean;
  videoWidth?: number;
  videoHeight?: number;
}

const h = vi.hoisted(() => {
  const stateListeners = new Set<(data: StateData) => void>();
  const fakes = {
    prepare: vi.fn(async (_opts: unknown) => undefined),
    setRect: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setRate: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setResizeMode: vi.fn(async () => undefined),
    setBackgroundPlayback: vi.fn(async () => undefined),
    setAudioOnly: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    progress: vi.fn(async () => ({ positionMs: 0, durationMs: 60_000, droppedFrames: 0 })),
    sampleFrameLuma: vi.fn(async () => ({ available: false })),
  };
  return { stateListeners, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    ...h.fakes,
    addListener: vi.fn(async (_event: string, cb: (data: Record<string, unknown>) => void) => {
      h.stateListeners.add(cb as never);
      return { remove: async () => h.stateListeners.delete(cb as never) };
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

function emitState(data: StateData): void {
  for (const cb of [...h.stateListeners]) cb(data);
}

function makeOptions(
  preferNativeEngine = true,
  format: PlaybackSource['format'] = 'mp4',
  isLocal = false,
): PlayerLoadOptions {
  const playback: PlaybackSource = {
    url: isLocal
      ? `file:///data/user/0/com.qoder.cinema/files/downloads/media-1/ep-1.${format}`
      : `https://cdn.example.com/vod/1.${format}`,
    ...(isLocal ? { localPath: `downloads/media-1/ep-1.${format}` } : {}),
    format,
    headers: {},
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal,
  };
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
    preferLocal: isLocal,
    preferNativeEngine,
  };
}

function mount(ctl: PlayerController): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  ctl.mount(el);
}

async function loadNativeReady(
  ctl: PlayerController,
  hasVideoTrack = true,
  format: PlaybackSource['format'] = 'mp4',
  isLocal = false,
): Promise<void> {
  mount(ctl);
  const pending = ctl.load(makeOptions(true, format, isLocal));
  await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
  emitState({
    state: 'ready',
    duration: 60_000,
    positionMs: 0,
    hasVideoTrack,
    videoWidth: hasVideoTrack ? 1920 : 0,
    videoHeight: hasVideoTrack ? 1080 : 0,
  });
  await pending;
}

async function loadVideoReady(
  ctl: PlayerController,
  videoWidth = 1920,
  videoHeight = 1080,
): Promise<HTMLVideoElement> {
  mount(ctl);
  const pending = ctl.load(makeOptions(false));
  await vi.waitFor(() => {
    if (document.querySelector('video') === null) throw new Error('video 未创建');
  });
  const el = document.querySelector('video') as HTMLVideoElement;
  Object.defineProperty(el, 'play', { configurable: true, value: async () => undefined });
  Object.defineProperty(el, 'error', { configurable: true, value: null });
  Object.defineProperty(el, 'videoWidth', { configurable: true, value: videoWidth });
  Object.defineProperty(el, 'videoHeight', { configurable: true, value: videoHeight });
  el.dispatchEvent(new Event('loadedmetadata'));
  await pending;
  return el;
}

const originalFrameCallback = Object.getOwnPropertyDescriptor(
  HTMLMediaElement.prototype,
  'requestVideoFrameCallback',
);

function restoreFrameCallback(): void {
  if (originalFrameCallback) {
    Object.defineProperty(HTMLMediaElement.prototype, 'requestVideoFrameCallback', originalFrameCallback);
    return;
  }
  delete (HTMLMediaElement.prototype as HTMLMediaElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  }).requestVideoFrameCallback;
}

describe('统一首帧闸门（P1-5）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.fakes.progress.mockResolvedValue({ positionMs: 0, durationMs: 60_000, droppedFrames: 0 });
    h.fakes.sampleFrameLuma.mockResolvedValue({ available: false });
  });

  afterEach(async () => {
    restoreFrameCallback();
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('本地裸 TS：READY 不发完全 ready，真实首帧后才结算', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const ready: number[] = [];
    const loaded: string[] = [];
    ctl.on('ready', ({ duration }) => ready.push(duration));
    ctl.on('loaded', ({ episodeId }) => loaded.push(episodeId));
    await loadNativeReady(ctl, true, 'ts', true);

    expect(ctl.getPlayerState()).toBe('loading');
    expect(ready).toEqual([]);
    expect(loaded).toEqual([]);

    const playing = ctl.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fakes.play).toHaveBeenCalledTimes(1);
    expect(ready).toEqual([]);

    emitState({ state: 'firstframe', positionMs: 0 });
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_POLL_MS);
    await playing;

    expect(ready).toEqual([60]);
    expect(loaded).toEqual(['episode-1']);
    expect(ctl.getPlayerState()).toBe('playing');
    await ctl.destroy();
  });

  it('原生明确无视频轨：直接放行，不误报黑屏', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const ready = vi.fn();
    const noVideo = vi.fn();
    ctl.on('ready', ready);
    ctl.on('novideo', noVideo);
    await loadNativeReady(ctl, false);

    expect(ready).toHaveBeenCalledTimes(1);
    await ctl.play();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 2);

    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);
    expect(noVideo).not.toHaveBeenCalled();
    expect(ctl.getPlayerState()).toBe('playing');
    await ctl.destroy();
  });

  it('用户主动纯音频：有视频轨也不等首帧', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const noVideo = vi.fn();
    ctl.on('novideo', noVideo);
    ctl.setAudioOnly(true);
    await loadNativeReady(ctl, true);

    await ctl.play();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 2);

    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);
    expect(noVideo).not.toHaveBeenCalled();
    await ctl.destroy();
  });

  it('首帧超时只重备一次，第二次仍无帧只报一次 novideo', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const notices: string[] = [];
    const noVideo = vi.fn();
    const ready = vi.fn();
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('novideo', noVideo);
    ctl.on('ready', ready);
    await loadNativeReady(ctl, true);

    const playing = ctl.play();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    expect(notices).toEqual(['未检测到画面，正在重试一次']);

    emitState({ state: 'ready', duration: 60_000, hasVideoTrack: true, videoWidth: 1920, videoHeight: 1080 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fakes.play).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS);
    await playing;

    expect(noVideo).toHaveBeenCalledTimes(1);
    expect(noVideo).toHaveBeenCalledWith({
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedSec: 0,
      reason: 'zero-frame',
    });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ctl.getPlayerState()).toBe('playing');

    const noVideoClear = vi.fn();
    ctl.on('novideoclear', noVideoClear);
    emitState({ state: 'firstframe', positionMs: 0 });
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_POLL_MS);
    expect(noVideoClear).toHaveBeenCalledWith({ reason: 'zero-frame' });

    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 3);
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    expect(noVideo).toHaveBeenCalledTimes(1);
    await ctl.destroy();
  });

  it('有解码帧但连续两轮近黑才报黑帧，恢复出画后清除提示', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const noVideo = vi.fn();
    const noVideoClear = vi.fn();
    ctl.on('novideo', noVideo);
    ctl.on('novideoclear', noVideoClear);
    h.fakes.progress.mockResolvedValue({ positionMs: 5_000, durationMs: 60_000, droppedFrames: 0 });
    const black = { available: true, cells: Array.from({ length: 32 * 18 }, () => 0) };
    h.fakes.sampleFrameLuma.mockResolvedValue(black);
    await loadNativeReady(ctl);
    emitState({ state: 'firstframe', positionMs: 5_000 });
    await ctl.play();

    await vi.advanceTimersByTimeAsync(NO_VIDEO_CHECK_DELAY_MS);
    expect(noVideo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BLACK_FRAME_CHECK_INTERVAL_MS);
    expect(noVideo).toHaveBeenCalledTimes(1);
    expect(noVideo).toHaveBeenCalledWith({
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedSec: 5,
      reason: 'black-frame',
      maxLuma: 0,
    });

    const bright = { available: true, cells: Array.from({ length: 32 * 18 }, () => 0) };
    bright.cells[288] = 255;
    h.fakes.sampleFrameLuma.mockResolvedValue(bright);
    await vi.advanceTimersByTimeAsync(BLACK_FRAME_CHECK_INTERVAL_MS);
    expect(noVideoClear).toHaveBeenCalledWith({ reason: 'black-frame' });
    await ctl.destroy();
  });

  it('像素取样永久不可用时只降级，不把取不到当成黑帧', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const noVideo = vi.fn();
    ctl.on('novideo', noVideo);
    h.fakes.progress.mockResolvedValue({ positionMs: 5_000, durationMs: 60_000, droppedFrames: 0 });
    h.fakes.sampleFrameLuma.mockRejectedValue(new Error('sampleFrameLuma unsupported'));
    await loadNativeReady(ctl);
    emitState({ state: 'firstframe', positionMs: 5_000 });
    await ctl.play();

    await vi.advanceTimersByTimeAsync(NO_VIDEO_CHECK_DELAY_MS + BLACK_FRAME_CHECK_INTERVAL_MS * 2);
    expect(h.fakes.sampleFrameLuma).toHaveBeenCalledTimes(1);
    expect(noVideo).not.toHaveBeenCalled();
    await ctl.destroy();
  });

  it('等待首帧时暂停会取消恢复，不擅自重备或重新起播', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNativeReady(ctl, true);

    const playing = ctl.play();
    await vi.advanceTimersByTimeAsync(0);
    ctl.pause();
    await playing;
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 2);

    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);
    expect(h.fakes.play).toHaveBeenCalledTimes(1);
    expect(ctl.getPlayerState()).toBe('paused');
    await ctl.destroy();
  });

  it('等待首帧时引擎报错立即收口，不被后续超时覆盖', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const errors: string[] = [];
    const noVideo = vi.fn();
    ctl.on('error', ({ code }) => errors.push(code));
    ctl.on('novideo', noVideo);
    await loadNativeReady(ctl, true);

    const playing = ctl.play();
    await vi.advanceTimersByTimeAsync(0);
    emitState({ state: 'error', message: 'decoder failed' });
    await playing;
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 2);

    expect(errors).toEqual(['E_DECODE']);
    expect(noVideo).not.toHaveBeenCalled();
    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);
    expect(ctl.getPlayerState()).toBe('error');
    await ctl.destroy();
  });

  it('WebView requestVideoFrameCallback 提交首帧后放行', async () => {
    let frameCallback: (() => void) | null = null;
    Object.defineProperty(HTMLMediaElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: (callback: () => void) => {
        frameCallback = callback;
        return 1;
      },
    });
    const ctl = new PlayerController({ onProgress: () => {} });
    const ready = vi.fn();
    ctl.on('ready', ready);
    await loadVideoReady(ctl);

    const playing = ctl.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).not.toHaveBeenCalled();
    expect(frameCallback).toEqual(expect.any(Function));
    const invokeFrame = frameCallback as unknown as (() => void) | null;
    invokeFrame?.();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_POLL_MS);

    await playing;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ctl.getPlayerState()).toBe('playing');
    await ctl.destroy();
  });

  it('WebView 无帧回调时用 totalVideoFrames 轮询兜底', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const ready = vi.fn();
    ctl.on('ready', ready);
    const el = await loadVideoReady(ctl);
    let totalFrames = 0;
    Object.defineProperty(el, 'getVideoPlaybackQuality', {
      configurable: true,
      value: () => ({ totalVideoFrames: totalFrames }),
    });

    const playing = ctl.play();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_POLL_MS);
    expect(ready).not.toHaveBeenCalled();
    totalFrames = 1;
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_POLL_MS);
    await playing;

    expect(ready).toHaveBeenCalledTimes(1);
    expect(h.fakes.prepare).not.toHaveBeenCalled();
    await ctl.destroy();
  });

  it('WebView 两种帧能力都缺失时诚实放行，不伪造黑屏结论', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const noVideo = vi.fn();
    ctl.on('novideo', noVideo);
    await loadVideoReady(ctl);

    await ctl.play();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 2);

    expect(noVideo).not.toHaveBeenCalled();
    expect(ctl.getPlayerState()).toBe('playing');
    await ctl.destroy();
  });

  it('WebView 元数据尺寸为 0 的纯音频直接放行', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const ready = vi.fn();
    const noVideo = vi.fn();
    ctl.on('ready', ready);
    ctl.on('novideo', noVideo);
    await loadVideoReady(ctl, 0, 0);

    expect(ready).toHaveBeenCalledTimes(1);
    await ctl.play();
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS * 2);

    expect(noVideo).not.toHaveBeenCalled();
    await ctl.destroy();
  });
});
