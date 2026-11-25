import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { NativeEngine } from '@/player/NativeEngine';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';
import { STALL_STUCK_MS } from '@/player/constants';

const h = vi.hoisted(() => {
  type StateData = Record<string, unknown>;
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
    release: vi.fn(async () => undefined),
    progress: vi.fn(async () => ({ positionMs: 1000, durationMs: 0, droppedFrames: 0 })),
  };
  return { stateListeners, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    ...h.fakes,
    addListener: vi.fn(async (_event: string, cb: (data: Record<string, unknown>) => void) => {
      h.stateListeners.add(cb);
      return { remove: async () => h.stateListeners.delete(cb) };
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

function emitState(data: Record<string, unknown>): void {
  for (const cb of [...h.stateListeners]) cb(data);
}

function makeSource(format: PlaybackSource['format'] = 'ts'): PlaybackSource {
  return {
    url: `file:///data/user/0/com.qoder.cinema/files/downloads/media-1/ep-1.${format}`,
    localPath: `downloads/media-1/ep-1.${format}`,
    format,
    headers: {},
    subtitles: [],
    lineId: 'local',
    quality: null,
    expiresAt: null,
    isLocal: true,
  };
}

function makeOptions(
  format: PlaybackSource['format'] = 'ts',
  startPositionSec = 0,
): PlayerLoadOptions {
  const playback = makeSource(format);
  if (startPositionSec > 0) playback.startPositionMs = startPositionSec * 1000;
  return {
    mediaId: 'media-1',
    episodeId: 'episode-1',
    lineId: 'local',
    title: '测试影片',
    posterUrl: null,
    playback,
    startPositionSec,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: true,
    preferNativeEngine: true,
  };
}

function mount(ctl: PlayerController): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  ctl.mount(el);
}

async function settleNativeLoad(
  ctl: PlayerController,
  options: PlayerLoadOptions,
  firstFramePositionMs = 1000,
): Promise<void> {
  const running = ctl.load(options);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.fakes.prepare).toHaveBeenCalled();
  emitState({ state: 'ready', duration: 0, positionMs: firstFramePositionMs });
  emitState({ state: 'firstframe', positionMs: firstFramePositionMs });
  await running;
}

describe('裸 TS 离线播放 P0', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.fakes.progress.mockResolvedValue({ positionMs: 1000, durationMs: 0, droppedFrames: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('NativeEngine.seek 不把目标值冒充成原生真实位置', async () => {
    const engine = new NativeEngine({
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
    });
    engine.attach(document.createElement('div'));

    engine.seek(300);

    expect(h.fakes.seek).toHaveBeenCalledWith({ positionMs: 300_000 });
    expect(engine.getCurrentTime()).toBe(0);
    engine.destroy();
  });

  it('NativeEngine 的 READY 只结算元数据，首帧单独回报', async () => {
    const onFirstFrame = vi.fn();
    const engine = new NativeEngine({
      onLoadedMetadata: vi.fn(),
      onTimeUpdate: vi.fn(),
      onWaiting: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      onFirstFrame,
    });
    engine.attach(document.createElement('div'));

    const running = engine.load(makeSource());
    await vi.advanceTimersByTimeAsync(0);
    emitState({ state: 'ready', duration: 0, positionMs: 0, hasVideoTrack: true });
    await running;
    expect(onFirstFrame).not.toHaveBeenCalled();
    expect(engine.getFrameStats()).toMatchObject({ totalFrames: 0 });

    emitState({ state: 'firstframe', positionMs: 0 });
    expect(onFirstFrame).toHaveBeenCalledWith(0);
    expect(engine.getFrameStats()).toMatchObject({ totalFrames: 1 });
    engine.destroy();
  });

  it('历史续播位落到开头时真实从头重备，并公开不可靠定位能力', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const notices: string[] = [];
    const errors: string[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('error', (error) => errors.push(error.code));

    const running = ctl.load(makeOptions('ts', 1513));
    await vi.advanceTimersByTimeAsync(0);
    emitState({ state: 'ready', duration: 0, positionMs: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    expect(h.fakes.prepare.mock.calls[1]![0]).toMatchObject({ startPositionMs: 0 });
    expect(ctl.getPlaybackCapabilities()).toEqual({
      durationKnown: false,
      seekable: false,
      seekReliable: false,
    });

    emitState({ state: 'ready', duration: 0, positionMs: 0 });
    emitState({ state: 'firstframe', positionMs: 0 });
    await running;

    expect(notices).toContain('此旧文件不支持可靠续播，正在从头播放');
    expect(errors).toEqual([]);
    expect(ctl.getState().currentTime).toBe(0);
    await ctl.destroy();
  });

  it('裸 TS seek 未真实落位时真实从头重备，后续 seek 不再盲试', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    await settleNativeLoad(ctl, makeOptions());
    await ctl.play();
    const notices: string[] = [];
    const errors: string[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('error', (error) => errors.push(error.code));

    ctl.seek(300);
    expect(h.fakes.seek).toHaveBeenCalledWith({ positionMs: 300_000 });
    expect(ctl.getState().currentTime).toBe(1);

    emitState({ state: 'seeksettled', targetMs: 300_000, latencyMs: 107, positionMs: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(notices).toContain('此旧文件不支持可靠定位，正在从头播放');
    expect(errors).toEqual([]);
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    expect(h.fakes.prepare.mock.calls[1]![0]).toMatchObject({ startPositionMs: 0 });
    expect(ctl.getPlaybackCapabilities().seekReliable).toBe(false);

    emitState({ state: 'ready', duration: 0, positionMs: 0 });
    emitState({ state: 'firstframe', positionMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.getState().currentTime).toBe(0);

    ctl.seek(600);
    expect(h.fakes.seek).toHaveBeenCalledTimes(1);
    await ctl.destroy();
  });

  it('裸 TS 成功续播后的合法 seek 首帧不触发二次归零', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    await settleNativeLoad(ctl, makeOptions('ts', 1513), 1_513_000);
    await ctl.play();

    ctl.seek(600);
    emitState({ state: 'firstframe', positionMs: 600 });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);
    expect(ctl.getPlaybackCapabilities().seekReliable).toBe(true);
    await ctl.destroy();
  });

  it('裸 TS seek 超时只收口等待态，不把慢定位误判为永久不可靠', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    await settleNativeLoad(ctl, makeOptions('ts'));
    await ctl.play();
    const notices: string[] = [];
    const waitingStates: boolean[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('statechange', ({ waiting }) => waitingStates.push(waiting));

    ctl.seek(300);
    await vi.advanceTimersByTimeAsync(2500);

    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);
    expect(ctl.getPlaybackCapabilities().seekReliable).toBe(true);
    expect(notices).not.toContain('此旧文件不支持可靠定位，正在从头播放');
    expect(waitingStates.at(-1)).toBe(false);

    emitState({ state: 'seeksettled', targetMs: 300_000, latencyMs: 3200, positionMs: 300_000 });
    expect(waitingStates.at(-1)).toBe(false);
    await ctl.destroy();
  });

  it('总时长未知与 seek 不可靠是两项能力，已知时长后恢复绝对拖动', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const changes: unknown[] = [];
    ctl.on('capabilitychange', (capabilities) => changes.push(capabilities));

    await settleNativeLoad(ctl, makeOptions('mp4'));
    expect(ctl.getPlaybackCapabilities()).toEqual({
      durationKnown: false,
      seekable: false,
      seekReliable: true,
    });

    emitState({ state: 'ready', duration: 60_000, positionMs: 1000 });
    expect(ctl.getPlaybackCapabilities()).toEqual({
      durationKnown: true,
      seekable: true,
      seekReliable: true,
    });
    expect(changes.at(-1)).toEqual(ctl.getPlaybackCapabilities());
    await ctl.destroy();
  });

  it('裸 TS 停滞从头重备；可 seek 的本地 MP4 从真实停滞位置恢复', async () => {
    const raw = new PlayerController({ onProgress: () => {} });
    mount(raw);
    await settleNativeLoad(raw, makeOptions('ts'));
    await raw.play();
    const rawNotices: string[] = [];
    raw.on('notice', ({ message }) => rawNotices.push(message));

    await vi.advanceTimersByTimeAsync(STALL_STUCK_MS + 4000);
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    expect(h.fakes.prepare.mock.calls[1]![0]).toMatchObject({ startPositionMs: 0 });
    expect(rawNotices).toContain('离线播放停滞，正在从头重试');
    emitState({ state: 'ready', duration: 0, positionMs: 0 });
    emitState({ state: 'firstframe', positionMs: 0 });
    await raw.destroy();

    h.stateListeners.clear();
    h.fakes.prepare.mockClear();
    h.fakes.progress.mockResolvedValue({ positionMs: 12_000, durationMs: 60_000, droppedFrames: 0 });
    const mp4 = new PlayerController({ onProgress: () => {} });
    mount(mp4);
    await settleNativeLoad(mp4, makeOptions('mp4'), 12_000);
    await mp4.play();

    await vi.advanceTimersByTimeAsync(STALL_STUCK_MS + 4000);
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    expect(h.fakes.prepare.mock.calls[1]![0]).toMatchObject({ startPositionMs: 12_000 });
    emitState({ state: 'ready', duration: 60_000, positionMs: 12_000 });
    emitState({ state: 'firstframe', positionMs: 12_000 });
    await mp4.destroy();
  });
});
