import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import type { AppErrorShape } from '@/types';
import { NativeEngine, type NativeEngineEvents } from '@/player/NativeEngine';
import { logger } from '@/shared/logger';

type StateListener = (data: {
  state: string;
  message?: string;
  duration?: number;
  positionMs?: number;
  targetMs?: number;
  latencyMs?: number;
  errorCodeName?: string;
  causeChain?: string;
  hasVideoTrack?: boolean;
  videoTrackCount?: number;
  videoWidth?: number;
  videoHeight?: number;
  firstFrameRendered?: boolean;
  audioOnly?: boolean;
  visible?: boolean;
  playerAttached?: boolean;
  surfaceValid?: boolean;
  surfaceShown?: boolean;
  surfaceWidth?: number;
  surfaceHeight?: number;
  webViewBackgroundTransparent?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  reason?: string;
  sessionId?: string;
  requestGeneration?: number;
  generation?: number;
  valid?: boolean;
}) => void;

const h = vi.hoisted(() => {
  const stateListeners = new Set<StateListener>();
  const removeListener = vi.fn(async (cb: StateListener) => {
    stateListeners.delete(cb);
  });
  const fakes = {
    prepare: vi.fn(async (_options: unknown) => undefined),
    setRect: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setRate: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setAudioOnly: vi.fn(async () => undefined),
    setBackgroundPlayback: vi.fn(async () => undefined),
    release: vi.fn(async (_options: unknown): Promise<void> => undefined),
    progress: vi.fn(async () => ({ positionMs: 0, durationMs: 0, droppedFrames: 0 })),
    addListener: vi.fn(async (_event: string, cb: StateListener) => {
      stateListeners.add(cb);
      return { remove: async () => { await removeListener(cb); } };
    }),
  };
  return { stateListeners, removeListener, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: { ...h.fakes },
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

function emitState(data: Parameters<StateListener>[0]): void {
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

function makeEvents(overrides: Partial<NativeEngineEvents> = {}): NativeEngineEvents {
  return {
    onLoadedMetadata: vi.fn(),
    onTimeUpdate: vi.fn(),
    onWaiting: vi.fn(),
    onEnded: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountHost(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 12, y: 24, left: 12, top: 24, right: 332, bottom: 224, width: 320, height: 200 }),
  });
  document.body.appendChild(el);
  return el;
}

const engines: NativeEngine[] = [];

function createEngine(events = makeEvents()): NativeEngine {
  const engine = new NativeEngine(events);
  engines.push(engine);
  engine.attach(mountHost());
  return engine;
}

function prepareOptions(call = 0): Record<string, unknown> {
  return h.fakes.prepare.mock.calls[call][0] as Record<string, unknown>;
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('NativeEngine 原生会话与 Surface 诊断', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    h.stateListeners.clear();
    h.fakes.prepare.mockResolvedValue(undefined);
    h.fakes.release.mockResolvedValue(undefined);
    h.fakes.progress.mockResolvedValue({ positionMs: 0, durationMs: 0, droppedFrames: 0 });
    h.fakes.addListener.mockImplementation(async (_event, cb) => {
      h.stateListeners.add(cb);
      return { remove: async () => { await h.removeListener(cb); } };
    });
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.destroy()));
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('load 成功：prepare 带 rect/headers/session token，READY 不等于首帧', async () => {
    const events = makeEvents();
    const engine = createEngine(events);
    const info = vi.spyOn(logger, 'info');
    h.fakes.progress.mockResolvedValue({ positionMs: 1000, durationMs: 90000, droppedFrames: 2 });

    const loadPromise = engine.load(makeSource());
    await flush();
    const prepared = prepareOptions();
    expect(prepared).toMatchObject({
      url: 'https://example.com/video.m3u8',
      headers: [{ key: 'Referer', value: 'https://example.com/' }],
      rect: { x: 12, y: 24, width: 320, height: 200 },
      sessionId: expect.any(String),
      requestGeneration: 1,
    });

    emitState({
      state: 'ready',
      duration: 90000,
      hasVideoTrack: true,
      videoWidth: 1920,
      videoHeight: 1080,
      sessionId: prepared.sessionId as string,
      requestGeneration: prepared.requestGeneration as number,
    });
    await expect(loadPromise).resolves.toBeUndefined();
    expect(events.onLoadedMetadata).toHaveBeenCalledWith(90, true);
    expect(engine.getFrameStats()).toEqual({ videoWidth: 1920, videoHeight: 1080, totalFrames: 0 });
    expect(info).toHaveBeenCalledWith('NativeEngine.ready', {
      durationMs: 90000,
      positionMs: 0,
      hasVideoTrack: true,
      videoWidth: 1920,
      videoHeight: 1080,
      sessionId: prepared.sessionId,
      requestGeneration: 1,
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(events.onTimeUpdate).toHaveBeenCalledWith(1, 90, 1);
    expect(engine.getDroppedFrames()).toBe(2);
  });

  it('ready 前 error：load 拒绝且不触发运行期 onError', async () => {
    const events = makeEvents();
    const engine = createEngine(events);
    const loadPromise = engine.load(makeSource());
    await flush();
    const prepared = prepareOptions();

    emitState({
      state: 'error',
      message: 'Source error',
      sessionId: prepared.sessionId as string,
      requestGeneration: prepared.requestGeneration as number,
    });

    await expect(loadPromise).rejects.toMatchObject({ code: 'E_NETWORK' });
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('播放中 error：走 onError（解码类映射 E_DECODE）', async () => {
    const errors: AppErrorShape[] = [];
    const engine = createEngine(makeEvents({ onError: (e) => errors.push(e) }));
    const loadPromise = engine.load(makeSource());
    await flush();
    emitState({ state: 'ready', duration: 1000 });
    await loadPromise;

    emitState({ state: 'error', message: 'Decoder init failed' });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('E_DECODE');
  });

  it('prepare 本身失败：抛 E_DECODE，销毁仍等待监听解绑与 release', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('bridge unavailable'));
    const engine = createEngine();

    await expect(engine.load(makeSource())).rejects.toMatchObject({ code: 'E_DECODE' });
    await engine.destroy();
    expect(h.removeListener).toHaveBeenCalledTimes(1);
    expect(h.fakes.release).toHaveBeenCalledTimes(1);
  });

  it('未知时长与 seek 真实落点进入诊断回调及可导出日志', async () => {
    const onSeekSettled = vi.fn();
    const engine = createEngine(makeEvents({ onSeekSettled }));
    const info = vi.spyOn(logger, 'info');

    const loadPromise = engine.load(makeSource());
    await flush();
    emitState({ state: 'ready', duration: -9223372036854776000, positionMs: 0 });
    await loadPromise;
    emitState({ state: 'seeksettled', targetMs: 300000, latencyMs: 107, positionMs: 0 });

    expect(onSeekSettled).toHaveBeenCalledWith({ targetMs: 300000, latencyMs: 107, positionMs: 0 });
    expect(info).toHaveBeenCalledWith('NativeEngine.ready', {
      durationMs: null,
      positionMs: 0,
      hasVideoTrack: null,
      videoWidth: 0,
      videoHeight: 0,
      sessionId: expect.any(String),
      requestGeneration: 1,
    });
    expect(info).toHaveBeenCalledWith('NativeEngine.seekSettled', {
      targetMs: 300000,
      latencyMs: 107,
      positionMs: 0,
    });
  });

  it('ended 后 destroy 可等待：先解绑再 release，完成后停止轮询', async () => {
    const onTimeUpdate = vi.fn();
    const events = makeEvents({ onTimeUpdate });
    const engine = createEngine(events);
    const loadPromise = engine.load(makeSource());
    await flush();
    emitState({ state: 'ready', duration: 1000 });
    await loadPromise;
    emitState({ state: 'ended' });
    expect(events.onEnded).toHaveBeenCalledTimes(1);

    const removal = deferred<void>();
    const release = deferred<void>();
    h.removeListener.mockImplementationOnce(() => removal.promise);
    h.fakes.release.mockImplementationOnce(() => release.promise);
    let destroyed = false;
    const destroying = engine.destroy().then(() => { destroyed = true; });
    await flush();
    expect(h.fakes.release).not.toHaveBeenCalled();

    removal.resolve(undefined);
    await flush();
    expect(h.fakes.release).toHaveBeenCalledWith({ sessionId: expect.any(String), requestGeneration: 1 });
    expect(destroyed).toBe(false);

    release.resolve(undefined);
    await destroying;
    const timeUpdatesBefore = onTimeUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTimeUpdate.mock.calls.length).toBe(timeUpdatesBefore);
  });

  it('错误 session token 被忽略，无 token 的旧插件事件仍兼容', async () => {
    const events = makeEvents();
    const engine = createEngine(events);
    const loadPromise = engine.load(makeSource());
    await flush();
    const prepared = prepareOptions();

    emitState({
      state: 'ready',
      duration: 1000,
      sessionId: prepared.sessionId as string,
      requestGeneration: (prepared.requestGeneration as number) + 1,
    });
    emitState({
      state: 'firstframe',
      sessionId: 'other-session',
      requestGeneration: prepared.requestGeneration as number,
    });
    expect(events.onLoadedMetadata).not.toHaveBeenCalled();
    expect(engine.getFrameStats()).toBeNull();

    emitState({ state: 'ready', duration: 1000, hasVideoTrack: true });
    emitState({ state: 'firstframe' });
    await loadPromise;
    expect(events.onLoadedMetadata).toHaveBeenCalledTimes(1);
    expect(engine.getFrameStats()?.totalFrames).toBe(1);
  });

  it('第二次 load 等待旧监听解绑与 release，旧 token 不能结算新会话', async () => {
    const events = makeEvents();
    const engine = createEngine(events);
    const firstLoad = engine.load(makeSource());
    await flush();
    const first = prepareOptions();
    emitState({
      state: 'ready',
      duration: 1000,
      sessionId: first.sessionId as string,
      requestGeneration: first.requestGeneration as number,
    });
    await firstLoad;

    const removal = deferred<void>();
    const release = deferred<void>();
    h.removeListener.mockImplementationOnce(() => removal.promise);
    h.fakes.release.mockImplementationOnce(() => release.promise);
    const secondLoad = engine.load(makeSource());
    await flush();
    expect(h.removeListener).toHaveBeenCalledTimes(1);
    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);

    removal.resolve(undefined);
    await flush();
    expect(h.fakes.release).toHaveBeenCalledWith({
      sessionId: first.sessionId,
      requestGeneration: first.requestGeneration,
    });
    expect(h.fakes.prepare).toHaveBeenCalledTimes(1);

    release.resolve(undefined);
    await flush();
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    const second = prepareOptions(1);
    expect(second.requestGeneration).toBe(2);
    expect(second.sessionId).not.toBe(first.sessionId);

    emitState({
      state: 'ready',
      duration: 2000,
      sessionId: first.sessionId as string,
      requestGeneration: first.requestGeneration as number,
    });
    expect(events.onLoadedMetadata).toHaveBeenCalledTimes(1);
    emitState({
      state: 'ready',
      duration: 2000,
      sessionId: second.sessionId as string,
      requestGeneration: second.requestGeneration as number,
    });
    await secondLoad;
    expect(events.onLoadedMetadata).toHaveBeenLastCalledWith(2, undefined);
  });

  it('addListener 返回前销毁：迟到句柄会被解绑，且不再 prepare', async () => {
    const listener = deferred<{ remove: () => Promise<void> }>();
    const remove = vi.fn(async () => undefined);
    h.fakes.addListener.mockImplementationOnce(() => listener.promise);
    const engine = createEngine();

    const outcome = engine.load(makeSource()).catch((e: unknown) => e);
    await flush();
    await engine.destroy();
    listener.resolve({ remove });
    await expect(outcome).resolves.toMatchObject({ code: 'E_ABORTED' });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.fakes.prepare).not.toHaveBeenCalled();
  });

  it('Surface 局部事件保留旧字段，轨道/首帧/纯音频状态进入快照', async () => {
    const engine = createEngine();
    const loadPromise = engine.load(makeSource());
    await flush();
    emitState({ state: 'ready', duration: 1000, hasVideoTrack: true, videoWidth: 1920, videoHeight: 1080 });
    await loadPromise;

    emitState({
      state: 'surface',
      visible: true,
      playerAttached: true,
      videoTrackCount: 1,
      surfaceValid: true,
      surfaceShown: true,
      surfaceWidth: 1920,
      surfaceHeight: 1080,
      webViewBackgroundTransparent: true,
      rect: { x: 12, y: 24, width: 320, height: 200 },
      reason: 'attached',
    });
    emitState({ state: 'surface', generation: 8, valid: true });
    emitState({ state: 'firstframe' });

    expect(engine.getSurfaceDiagnostic()).toMatchObject({
      reason: 'attached',
      visible: true,
      audioOnly: false,
      playerAttached: true,
      hasVideoTrack: true,
      videoTrackCount: 1,
      videoWidth: 1920,
      videoHeight: 1080,
      firstFrameRendered: true,
      surfaceValid: true,
      surfaceShown: true,
      surfaceWidth: 1920,
      surfaceHeight: 1080,
      webViewBackgroundTransparent: true,
      rect: { x: 12, y: 24, width: 320, height: 200 },
    });
    expect(engine.getFrameStats()?.totalFrames).toBe(1);

    emitState({ state: 'surface', audioOnly: true, firstFrameRendered: false });
    expect(engine.getFrameStats()).toBeNull();
    expect(engine.getSurfaceDiagnostic()).toMatchObject({ audioOnly: true, firstFrameRendered: false });
  });

  it('新会话重置 Surface 与首帧，旧 progress 回执不能写入新会话', async () => {
    const events = makeEvents();
    const engine = createEngine(events);
    const oldProgress = deferred<{ positionMs: number; durationMs: number; droppedFrames: number }>();
    h.fakes.progress.mockImplementationOnce(() => oldProgress.promise);
    const firstLoad = engine.load(makeSource());
    await flush();
    const first = prepareOptions();
    emitState({
      state: 'ready',
      duration: 1000,
      hasVideoTrack: true,
      sessionId: first.sessionId as string,
      requestGeneration: first.requestGeneration as number,
    });
    emitState({
      state: 'surface',
      visible: true,
      sessionId: first.sessionId as string,
      requestGeneration: first.requestGeneration as number,
    });
    emitState({
      state: 'firstframe',
      sessionId: first.sessionId as string,
      requestGeneration: first.requestGeneration as number,
    });
    await firstLoad;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.fakes.progress).toHaveBeenCalledTimes(1);

    const secondLoad = engine.load(makeSource());
    expect(engine.getSurfaceDiagnostic()).toBeNull();
    await flush();
    const second = prepareOptions(1);
    emitState({
      state: 'ready',
      duration: 2000,
      positionMs: 5000,
      hasVideoTrack: true,
      sessionId: second.sessionId as string,
      requestGeneration: second.requestGeneration as number,
    });
    await secondLoad;
    expect(engine.getFrameStats()).toEqual({ videoWidth: 0, videoHeight: 0, totalFrames: 0 });

    emitState({
      state: 'firstframe',
      sessionId: first.sessionId as string,
      requestGeneration: first.requestGeneration as number,
    });
    oldProgress.resolve({ positionMs: 999999, durationMs: 888888, droppedFrames: 99 });
    await flush();
    expect(engine.getCurrentTime()).toBe(5);
    expect(engine.getDuration()).toBe(2);
    expect(engine.getDroppedFrames()).toBe(0);
    expect(events.onTimeUpdate).not.toHaveBeenCalled();
  });
});
