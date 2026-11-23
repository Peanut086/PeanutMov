/**
 * 在线流停滞看门狗（OPT-26 / P2-⑫）
 *
 * 真机形态：第 10 集昨天能看、今天点开就是「画面停住 + 没有任何报错」——
 * 签名直链过期后 ExoPlayer 只会一直报 buffering，WebView 连 waiting 都不发，
 * 引擎侧永远不会把一个错误交给面板。所以播放器必须自己发现「位置不再推进」，
 * 把它作为**事实**上报（`stall` 事件），由播放页决定重新取址。
 *
 * 这里断言四条边界：
 * 1. 在线档位是 25 秒（比本地宽），到点才报，每次加载只报一次；
 * 2. 位置在推进就不报（哪怕已经播了很久）；
 * 3. 位置不动但缓冲仍在涨 = 弱网，不报；缓冲也停住才报，且报的是「断供」；
 * 4. 本地产物不受影响——仍是复位重备一次、再停滞收口成 E_LOCAL_STALL。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const h = vi.hoisted(() => {
  type StateCb = (data: { state: string; message?: string; duration?: number }) => void;
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
    progress: vi.fn(async () => ({ positionMs: 12_000, durationMs: 600_000, droppedFrames: 0 })),
  };
  return { stateListeners, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    ...h.fakes,
    addListener: vi.fn(async (_event: string, cb: (d: { state: string }) => void) => {
      h.stateListeners.add(cb as never);
      return { remove: async () => undefined };
    }),
  },
  exoHeadersOf: (headers: Record<string, string>) =>
    Object.entries(headers).map(([key, value]) => ({ key, value })),
  isExoPlayerAvailable: vi.fn(async () => true),
}));

import type { PlaybackSource, AppErrorShape } from '@/types';
import { logger } from '@/shared/logger';
import { isExoPlayerAvailable } from '@/native/exoPlayerPlugin';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';
import { NET_STALL_STUCK_MS, STALL_STUCK_MS } from '@/player/constants';

const PLAY_URL = 'https://cdn.example.com/vod/10.m3u8?sign=abcdef';

interface StallEvent {
  positionSec: number;
  stuckMs: number;
  bufferedStalled: boolean | null;
}

function makeSource(isLocal = false, format: PlaybackSource['format'] = 'hls'): PlaybackSource {
  return {
    url: PLAY_URL,
    format,
    headers: {},
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal,
  };
}

function makeOptions(
  preferNativeEngine?: boolean,
  isLocal = false,
  format: PlaybackSource['format'] = 'hls',
): PlayerLoadOptions {
  return {
    mediaId: 'media-1',
    episodeId: 'episode-1',
    lineId: 'line-1',
    title: '士兵突击',
    posterUrl: null,
    playback: makeSource(isLocal, format),
    startPositionSec: 0,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: isLocal,
    ...(preferNativeEngine === undefined ? {} : { preferNativeEngine }),
  };
}

function emitState(data: { state: string; message?: string; duration?: number }): void {
  for (const cb of [...h.stateListeners]) cb(data);
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

/** 原生链路：prepare 已发起 → 交回 ready + 时长，加载即落定 */
async function loadNative(ctl: PlayerController, isLocal = false): Promise<void> {
  mount(ctl);
  const running = ctl.load(makeOptions(true, isLocal));
  await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
  emitState({ state: 'ready', duration: 600_000 });
  await running;
}

/** WebView 链路：`<video>` 建好 + loadedmetadata 即落定，随后把时钟交给假定时器 */
async function loadVideo(ctl: PlayerController): Promise<void> {
  mount(ctl);
  // mp4：jsdom 里没有 MSE，HLS 会在能力判定处直接拒掉（那是另一条链路的事）
  const running = ctl.load(makeOptions(undefined, false, 'mp4'));
  await vi.waitFor(() => {
    if (document.querySelector('video') === null) throw new Error('video 未创建');
  });
  const el = video();
  // jsdom 的 play() 是「Not implemented」的拒绝，引擎只认 promise 落定
  Object.defineProperty(el, 'play', { configurable: true, value: async () => undefined });
  Object.defineProperty(el, 'error', { configurable: true, value: null });
  el.dispatchEvent(new Event('loadedmetadata'));
  await running;
}

function collectStalls(ctl: PlayerController): StallEvent[] {
  const stalls: StallEvent[] = [];
  ctl.on('stall', (payload) => stalls.push(payload));
  return stalls;
}

describe('在线流停滞看门狗（P2-⑫）', () => {
  afterEach(() => {
    vi.useRealTimers();
    h.stateListeners.clear();
    document.body.innerHTML = '';
    vi.mocked(isExoPlayerAvailable).mockImplementation(async () => true);
    h.fakes.prepare.mockImplementation(async () => undefined);
    h.fakes.progress.mockImplementation(async () => ({
      positionMs: 12_000,
      durationMs: 600_000,
      droppedFrames: 0,
    }));
    vi.clearAllMocks();
  });

  it('位置 25 秒不动：报一次事实（buffered 原生给不出），且每次加载只报一次', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNative(ctl);
    const stalls = collectStalls(ctl);
    vi.useFakeTimers();
    await ctl.play();

    // 窗口之内不许报：早一步就是把弱网误成断流
    await vi.advanceTimersByTimeAsync(NET_STALL_STUCK_MS - 8_000);
    expect(stalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.stuckMs).toBeGreaterThanOrEqual(NET_STALL_STUCK_MS);
    // 位置读数必须与引擎当前值一致：这一路「停在同一处不动」就是要抓的形态
    expect(stalls[0]!.positionSec).toBe(ctl.getState().currentTime);
    // 原生桥上没有 buffered 进度，判定只能只看位置——未知必须报成 null，不能报成"缓冲也停了"
    expect(stalls[0]!.bufferedStalled).toBeNull();
    // 上报机会每次加载只有一次：恢复动作由播放页接手，不能变成无限重连
    await vi.advanceTimersByTimeAsync(90_000);
    expect(stalls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '在线流停滞，交由播放页重新取址',
      expect.objectContaining({ engine: 'native', url: PLAY_URL }),
    );
    await ctl.destroy();
  });

  it('位置在推进：再多等几十秒也不报（看门狗不许成为常态噪音）', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadVideo(ctl);
    const startedAt = Date.now();
    // 位置跟着（假）时钟走：真实播放就是这个形态
    Object.defineProperty(video(), 'currentTime', {
      configurable: true,
      get: () => (Date.now() - startedAt) / 1000,
    });
    const stalls = collectStalls(ctl);
    vi.useFakeTimers();
    await ctl.play();
    await vi.advanceTimersByTimeAsync(NET_STALL_STUCK_MS + 35_000);
    expect(stalls).toHaveLength(0);
    await ctl.destroy();
  });

  it('位置不动但缓冲在涨 = 弱网：不报；缓冲也停住才报，报的是断供', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadVideo(ctl);
    let growing = true;
    let bufferedReads = 0;
    Object.defineProperty(video(), 'currentTime', { configurable: true, get: () => 30 });
    Object.defineProperty(video(), 'buffered', {
      configurable: true,
      get: () => {
        bufferedReads += 1;
        return {
          length: 1,
          start: () => 0,
          end: () => (growing ? 60 + bufferedReads : 60),
        };
      },
    });
    const stalls = collectStalls(ctl);
    vi.useFakeTimers();
    await ctl.play();

    // 喂不饱不是断供：窗口一直顺延，重新取址只会白烧一次爬虫调用
    await vi.advanceTimersByTimeAsync(NET_STALL_STUCK_MS + 30_000);
    expect(stalls).toHaveLength(0);

    growing = false;
    await vi.advanceTimersByTimeAsync(NET_STALL_STUCK_MS + 5_000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ positionSec: 30, bufferedStalled: true });
    await ctl.destroy();
  });

  it('本地产物不受在线分支影响：仍是一次复位重备、再停滞收口 E_LOCAL_STALL', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNative(ctl, true);
    const stalls = collectStalls(ctl);
    const errors: AppErrorShape[] = [];
    const notices: string[] = [];
    ctl.on('error', (e) => errors.push(e));
    ctl.on('notice', (n) => notices.push(n.message));
    vi.useFakeTimers();
    await ctl.play();

    await vi.advanceTimersByTimeAsync(STALL_STUCK_MS + 4_000);
    expect(stalls).toHaveLength(0);
    expect(notices).toContain('离线起播异常，正在重试');
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    emitState({ state: 'ready', duration: 600_000 });

    await vi.advanceTimersByTimeAsync(STALL_STUCK_MS + 4_000);
    expect(stalls).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('E_LOCAL_STALL');
    await ctl.destroy();
  });
});
