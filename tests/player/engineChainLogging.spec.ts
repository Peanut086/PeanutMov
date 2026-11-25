/**
 * 引擎链日志测试（OPT-26 / P0-②-2）
 *
 * 背景：真机那一轮「格式不支持」，界面报了错、导出日志里却一行查不到——
 * 回退是静默的（只 `emit('notice')`），失败没有落盘，事后只能靠用户复述。
 *
 * 断言的是**可归因性**，不是措辞：
 * - 每一次换引擎（原生→内置、内置→原生）都有一行 warn，带 from / to；
 * - 回退链用尽有一行 error，带的是原始失败（不是被后一个错误覆盖后的）；
 * - 每行都带 `code` 与 `url`，能回答「哪个引擎在哪个地址上拒的」；
 * - 加载期错误不被重复计成运行期报错（同一次失败只有一条处置线索）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const h = vi.hoisted(() => {
  type StateCb = (data: {
    state: string;
    message?: string;
    duration?: number;
    errorCodeName?: string;
    causeChain?: string;
    positionMs?: number;
  }) => void;
  const stateListeners = new Set<StateCb>();
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

import type { PlaybackSource } from '@/types';
import { logger } from '@/shared/logger';
import { toErrorShape } from '@/shared/errors';
import { guidanceOf } from '@/shared/sourceFailure';
import { getExoPlayerStatus } from '@/native/exoPlayerPlugin';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';

/** 带 CDN 鉴权参数：日志里的地址必须是脱敏后的形状（脱敏在真 logger 里，见 url.spec.ts） */
const PLAY_URL = 'https://a.com/vod/10.mp4';

function makeSource(format: PlaybackSource['format'] = 'mp4'): PlaybackSource {
  return {
    url: PLAY_URL,
    format,
    headers: {},
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal: false,
  };
}

function makeOptions(
  preferNativeEngine?: boolean,
  format: PlaybackSource['format'] = 'mp4',
): PlayerLoadOptions {
  return {
    mediaId: 'media-1',
    episodeId: 'episode-1',
    lineId: 'line-1',
    title: '士兵突击',
    posterUrl: null,
    playback: makeSource(format),
    startPositionSec: 0,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: false,
    ...(preferNativeEngine === undefined ? {} : { preferNativeEngine }),
  };
}

function emitState(data: {
  state: string;
  message?: string;
  duration?: number;
  errorCodeName?: string;
  causeChain?: string;
  positionMs?: number;
}): void {
  for (const cb of [...h.stateListeners]) cb(data);
}

function logPayload(message: string, level: 'info' | 'warn' | 'error') {
  const spy = level === 'warn' ? logger.warn : level === 'error' ? logger.error : logger.info;
  const hit = vi.mocked(spy).mock.calls.find((call) => call[0] === message);
  return hit?.[1] as Record<string, unknown> | undefined;
}

function loggedMessages(level: 'info' | 'warn' | 'error'): string[] {
  const spy = level === 'warn' ? logger.warn : level === 'error' ? logger.error : logger.info;
  return vi.mocked(spy).mock.calls.map((call) => String(call[0]));
}

function mount(ctl: PlayerController): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  ctl.mount(el);
}

function video(): HTMLVideoElement {
  const el = document.querySelector('video');
  if (!el) throw new Error('video 未创建');
  return el as HTMLVideoElement;
}

async function waitForVideo(): Promise<void> {
  await vi.waitFor(() => {
    if (document.querySelector('video') === null) throw new Error('video 未创建');
  });
}

/** jsdom 的 `<video>` 不会自己失败：派发 error 即让 load 以 E_DECODE 落定（MediaError 缺席走 default） */
function failVideo(): void {
  video().dispatchEvent(new Event('error'));
}

/** 真机上 `<video>` 失败时带的是 MediaError.code=4（SRC_NOT_SUPPORTED）；补上才走能力档那条映射 */
function setMediaError(el: HTMLVideoElement, code: number, message: string): void {
  Object.defineProperty(el, 'error', { value: { code, message }, configurable: true });
}

function settleVideo(): void {
  video().dispatchEvent(new Event('loadedmetadata'));
}

describe('引擎链日志（P0-②-2）', () => {
  afterEach(() => {
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.mocked(getExoPlayerStatus).mockResolvedValue({
      available: true,
      supported: true,
      safeMode: false,
      reason: null,
    });
    h.fakes.prepare.mockImplementation(async () => undefined);
    vi.clearAllMocks();
  });

  it('内置引擎失败并降级原生成功：两跳都留痕，终点记到 native', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const loadPromise = ctl.load(makeOptions());
    await waitForVideo();
    failVideo();
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
    emitState({ state: 'ready', duration: 60000 });
    emitState({ state: 'firstframe', positionMs: 0 });
    await loadPromise;

    expect(ctl.getEngineKind()).toBe('native');
    expect(logPayload('内置引擎（<video>）加载失败', 'warn')).toMatchObject({
      code: 'E_DECODE',
      url: PLAY_URL,
      format: 'mp4',
      isLocal: false,
    });
    expect(logPayload('引擎回退：内置引擎失败，降级原生引擎', 'warn')).toMatchObject({
      from: 'webview',
      to: 'native',
      code: 'E_DECODE',
      url: PLAY_URL,
    });
    expect(logPayload('播放引擎就绪', 'info')).toMatchObject({ from: null, to: 'native', url: PLAY_URL });
    // 加载期那一次 error 事件同时打到运行期监听上，但不能算成第二条处置线索
    expect(loggedMessages('warn')).not.toContain('播放中引擎报错');
    // VideoEngine 只记现场（原始 MediaError.code），不带结论
    expect(logPayload('WebView MediaError', 'warn')).toMatchObject({ src: PLAY_URL });
    await ctl.destroy();
  });

  it('原生引擎失败后回退内置：回退不再无声，桥接原文留在 detail', async () => {
    h.fakes.prepare.mockRejectedValueOnce(
      new Error('UnrecognizedInputFormatException: Neither allowed m3u8 nor mp4'),
    );
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const loadPromise = ctl.load(makeOptions(true));
    await waitForVideo();
    settleVideo();
    await loadPromise;

    const dropped = logPayload('引擎回退：原生引擎加载失败', 'warn');
    expect(dropped).toMatchObject({ from: 'native', to: 'webview', code: 'E_DECODE', url: PLAY_URL });
    expect(String(dropped?.message)).toBe('原生引擎加载失败');
    expect(String(dropped?.detail)).toContain('UnrecognizedInputFormatException');
    expect(logPayload('播放引擎就绪', 'info')).toMatchObject({ to: 'video' });
    await ctl.destroy();
  });

  it('两级都失败：error 带的是原始 WebView 失败，回退链用尽可见', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('native prepare failed'));
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    // 立刻挂上 catch：这一轮注定失败，晚一步登记处理器会被 Node 记成未处理拒绝
    const outcome = ctl.load(makeOptions()).catch((e: unknown) => e);
    await waitForVideo();
    failVideo();
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());

    expect(await outcome).toBeInstanceOf(Error);
    expect(logPayload('引擎回退：内置引擎失败，降级原生引擎', 'warn')).toBeDefined();
    const exhausted = logPayload('播放引擎加载失败：原生降级也未通过', 'error');
    expect(exhausted).toMatchObject({ code: 'E_DECODE', url: PLAY_URL, webview: 'E_DECODE' });
    // 原生那一跳的桥接原文也在同一行里，两条失败不必靠时间去对
    expect(String(exhausted?.detail)).toContain('native prepare failed');
    expect(loggedMessages('info')).not.toContain('播放引擎就绪');
    await ctl.destroy();
  });

  /**
   * 真机那一轮的主案发现场：`<video>` 报 `MEDIA_ERR_SRC_NOT_SUPPORTED`（code 4）。
   * 运行期日志要同时留下原始码（只有它能证明"本机接不住"）和映射后的子原因，
   * 否则事后又只剩一句「暂不支持该格式」。
   */
  it('运行期报错留痕：原始 MediaError 码与映射后的子原因一起入日志', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const loadPromise = ctl.load(makeOptions());
    await waitForVideo();
    settleVideo();
    await loadPromise;
    expect(ctl.getEngineKind()).toBe('video');

    const el = video();
    Object.defineProperty(el, 'play', { configurable: true, value: async () => undefined });
    Object.defineProperty(el, 'getVideoPlaybackQuality', {
      configurable: true,
      value: () => ({ totalVideoFrames: 1 }),
    });
    await ctl.play();
    Object.defineProperty(el, 'error', {
      value: { code: 4, message: 'MEDIA_SRC_NOT_SUPPORTED' },
      configurable: true,
    });
    const reported = new Promise<string[]>((resolve) => {
      const codes: string[] = [];
      ctl.on('error', (e) => codes.push(e.code));
      setTimeout(() => resolve(codes), 0);
    });
    el.dispatchEvent(new Event('error'));

    const codes = await reported;
    expect(codes).toEqual(['E_UNSUPPORTED_FORMAT']);
    expect(logPayload('WebView MediaError', 'warn')).toMatchObject({
      mediaErrorCode: 4,
      mediaErrorMessage: 'MEDIA_SRC_NOT_SUPPORTED',
      src: PLAY_URL,
    });
    expect(logPayload('播放中引擎报错', 'warn')).toMatchObject({
      engine: 'video',
      code: 'E_UNSUPPORTED_FORMAT',
      reason: 'player_capability',
    });
    await ctl.destroy();
  });

  /*
   * P1-②-3 的归属口径：两个引擎都没播起来时，结论只能有一个，但现场必须都留下。
   * 真机那一轮「格式不支持」之后又跟着换源、换线各撞一次网络——错误按最后一步归，
   * 用户就被指回自己机器；反过来把原生那句泛化的 E_DECODE 当结论，又会把源站断连
   * 说成"你设备播不了"。规则按证据强弱走：原生说得出确定性原因（拿不到地址、网络断了、
   * 404/5xx、源正忙）就以它为准，只给出泛化解码失败时沿用内置结论。
   */
  it('原生给出确定性原因时按原生归：内置那句 code 4 不再冒充结论', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const outcome = ctl.load(makeOptions()).catch((e: unknown) => e);
    await waitForVideo();
    failVideo();
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
    // 真机上原生这一跳多半不是 prepare 直接拒，而是 prepare 成功后 exostate 报 error：
    // 那条路给出的是 `{code:'E_NETWORK'}` 这样的明文结论（不是 Error 实例）
    emitState({ state: 'error', message: 'ERROR_CODE_IO_NETWORK_ATTEMPT_FAILED' });

    const shape = toErrorShape(await outcome);
    expect(shape.code).toBe('E_NETWORK');
    // 面板只念结论，明细里两边的原文都在
    expect(shape.message).toBe('视频加载失败，请检查网络');
    expect(String(shape.detail)).toContain('原生: 视频加载失败，请检查网络');
    expect(String(shape.detail)).toContain('内置: ');
    expect(logPayload('播放引擎加载失败：原生降级也未通过', 'error')).toMatchObject({
      code: 'E_NETWORK',
      attributedCode: 'E_NETWORK',
      webview: 'E_DECODE',
    });
    // 链里真的跑过原生 → 面板不再给「用原生引擎重试」
    expect(ctl.getNativeAttemptedInLastChain()).toBe(true);
    await ctl.destroy();
  });

  it('原生只有泛化 E_DECODE 时沿用内置结论：能力档不被编造成源站问题', async () => {
    h.fakes.prepare.mockRejectedValueOnce(new Error('ExoPlayer gave up'));
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const outcome = ctl.load(makeOptions()).catch((e: unknown) => e);
    await waitForVideo();
    setMediaError(video(), 4, 'MEDIA_SRC_NOT_SUPPORTED');
    failVideo();
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());

    const shape = toErrorShape(await outcome);
    expect(shape.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(shape.reason).toBe('player_capability');
    // 结论决定出口：只有这一档允许「用原生引擎重试」，但本轮已经用过 → 入口必须关
    expect(guidanceOf(shape).actions).toContain('retry-native');
    expect(ctl.getNativeAttemptedInLastChain()).toBe(true);
    await ctl.destroy();
  });

  it('原生不可用：链在内置就断了，"没用过原生"这件事留在日志与状态里', async () => {
    vi.mocked(getExoPlayerStatus).mockResolvedValueOnce({
      available: false,
      supported: false,
      safeMode: false,
      reason: 'plugin_missing',
    });
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const outcome = ctl.load(makeOptions()).catch((e: unknown) => e);
    await waitForVideo();
    setMediaError(video(), 4, 'MEDIA_SRC_NOT_SUPPORTED');
    failVideo();

    const shape = toErrorShape(await outcome);
    expect(shape.code).toBe('E_UNSUPPORTED_FORMAT');
    expect(shape.reason).toBe('player_capability');
    expect(ctl.getNativeAttemptedInLastChain()).toBe(false);
    const exhausted = logPayload('播放引擎加载失败：回退链已用尽', 'error');
    expect(exhausted).toMatchObject({
      code: 'E_UNSUPPORTED_FORMAT',
      nativeAttempted: false,
      attributedCode: null,
      attributedDetail: null,
    });
    await ctl.destroy();
  });

  it.each([402, 403])('原生 HLS %i 直接交回页面刷新，不再把坏地址交给内置引擎', async (status) => {
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const errors: string[] = [];
    const notices: string[] = [];
    ctl.on('error', (e) => errors.push(e.code));
    ctl.on('notice', ({ message }) => notices.push(message));
    const outcome = ctl.load(makeOptions(true, 'hls')).catch((e: unknown) => e);
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalledTimes(1));
    emitState({
      state: 'error',
      message: 'Source error',
      errorCodeName: 'ERROR_CODE_IO_BAD_HTTP_STATUS',
      causeChain: `InvalidResponseCodeException: Response code: ${status}`,
      positionMs: 1_842_300,
    });

    const shape = toErrorShape(await outcome);
    expect(shape.httpStatus).toBe(status);
    expect(shape.code).toBe(status === 402 ? 'E_SOURCE_UNAVAILABLE' : 'E_HTTP_403');
    expect(errors).toEqual([shape.code]);
    expect(notices).toEqual([]);
    expect(document.querySelector('video')).toBeNull();
    expect(logPayload('原生 HLS 地址失效，交回页面重新获取', 'warn')).toMatchObject({
      from: 'native',
      to: 'resolve',
      httpStatus: status,
    });
    expect(loggedMessages('warn')).not.toContain('播放中引擎报错');
    await ctl.destroy();
  });

  it('原生 HTTP 403 的确定性结论不被内置 code 4 覆盖', async () => {
    h.fakes.prepare.mockRejectedValue(new Error('InvalidResponseCodeException: Response code: 403'));
    const ctl = new PlayerController({ onProgress: () => {} });
    mount(ctl);
    const errors: string[] = [];
    ctl.on('error', (e) => errors.push(e.code));
    const outcome = ctl.load(makeOptions()).catch((e: unknown) => e);
    await waitForVideo();
    setMediaError(video(), 4, 'MEDIA_SRC_NOT_SUPPORTED');
    failVideo();
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalledTimes(1));

    const shape = toErrorShape(await outcome);
    expect(shape.code).toBe('E_HTTP_403');
    expect(shape.httpStatus).toBe(403);
    expect(errors).toEqual(['E_HTTP_403']);
    expect(loggedMessages('warn')).not.toContain('播放中引擎报错');
    await ctl.destroy();
  });
});
