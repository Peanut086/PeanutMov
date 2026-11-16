/**
 * FIX-PLAY-C1/C2：播放错误归因与本地解码容错
 *
 * 断言：
 * - `toPlayError` 优先用原生 `errorCodeName` 精确分类，缺席时回退 message 正则；
 *   detail 带上 code/cause/pos 归因字段（「复制错误信息」直接可用）
 * - 本地播放的解码类错误：第一次走「跳过坏段复位重播」（prepare 带 +10s 续播位），
 *   第二次收口成 E_LOCAL_CORRUPT（指引重新下载，而不是误导性的「切换线路」）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { toPlayError } from '@/player/NativeEngine';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';
import { LOCAL_DECODE_SKIP_SEC } from '@/player/constants';

const h = vi.hoisted(() => {
  const stateListeners = new Set<(data: Record<string, unknown>) => void>();
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
    progress: vi.fn(async () => ({ positionMs: 0, durationMs: 60000, droppedFrames: 0 })),
  };
  return { stateListeners, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    ...h.fakes,
    addListener: vi.fn(async (_event: string, cb: (d: Record<string, unknown>) => void) => {
      h.stateListeners.add(cb);
      // 与真实 Capacitor 同形：句柄必须带 remove()，否则复位重备后旧监听器不会被摘掉
      return { remove: async () => h.stateListeners.delete(cb) };
    }),
  },
  exoHeadersOf: (headers: Record<string, string>) =>
    Object.entries(headers).map(([key, value]) => ({ key, value })),
  isExoPlayerAvailable: vi.fn(async () => true),
}));

function emitState(data: Record<string, unknown>): void {
  for (const cb of [...h.stateListeners]) cb(data);
}

function makeLocalSource(): PlaybackSource {
  return {
    url: 'file:///data/user/0/com.qoder.cinema/files/downloads/media-1/ep-1.ts',
    localPath: 'downloads/media-1/ep-1.ts',
    format: 'ts',
    headers: {},
    subtitles: [],
    lineId: 'local',
    quality: null,
    expiresAt: null,
    isLocal: true,
  };
}

function makeOptions(playback: PlaybackSource): PlayerLoadOptions {
  return {
    mediaId: 'media-1',
    episodeId: 'episode-1',
    lineId: 'local',
    title: '测试影片',
    posterUrl: null,
    playback,
    startPositionSec: 0,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: true,
    preferNativeEngine: true,
  };
}

const DECODE_ERROR = {
  state: 'error',
  message: 'MediaCodecVideoRenderer error (index=0, reason=android.media.MediaCodec$CodecException)',
  errorCodeName: 'ERROR_CODE_DECODING_FAILED',
  causeChain: 'DecoderException: mediaCode 0x2',
  positionMs: 2_401_000,
};

describe('toPlayError 结构化归因（FIX-PLAY-C1）', () => {
  it('errorCodeName 为 IO 类 → E_NETWORK（复用网络自动重试）', () => {
    const e = toPlayError({
      state: 'error',
      message: 'Server returned HTTP 503',
      errorCodeName: 'ERROR_CODE_IO_BAD_HTTP_STATUS',
    });
    expect(e.code).toBe('E_NETWORK');
    expect(e.detail).toContain('code=ERROR_CODE_IO_BAD_HTTP_STATUS');
  });

  it('errorCodeName 为解码类 → E_DECODE，detail 带 cause 链与位置', () => {
    const e = toPlayError(DECODE_ERROR);
    expect(e.code).toBe('E_DECODE');
    expect(e.detail).toContain('cause=DecoderException: mediaCode 0x2');
    expect(e.detail).toContain('pos=2401.0s');
  });

  it('旧插件没有 errorCodeName：回退 message 正则（网络词 → E_NETWORK）', () => {
    const e = toPlayError({ state: 'error', message: 'connection timeout while reading source' });
    expect(e.code).toBe('E_NETWORK');
    const d = toPlayError({ state: 'error', message: 'MediaCodecVideoRenderer error' });
    expect(d.code).toBe('E_DECODE');
  });
});

describe('本地解码错误一次性容错（FIX-PLAY-C2）', () => {
  afterEach(() => {
    h.stateListeners.clear();
    document.body.innerHTML = '';
    h.fakes.prepare.mockClear();
    h.fakes.play.mockClear();
  });

  async function mountLocal(): Promise<PlayerController> {
    const ctl = new PlayerController({ onProgress: () => {} });
    const el = document.createElement('div');
    document.body.appendChild(el);
    ctl.mount(el);
    const loadPromise = ctl.load(makeOptions(makeLocalSource()));
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalledTimes(1));
    emitState({ state: 'ready', duration: 60000 });
    await loadPromise;
    return ctl;
  }

  it('首次解码错误 → 跳过坏段复位重播（+10s 续播位），不发 error', async () => {
    const ctl = await mountLocal();
    const notices: string[] = [];
    const errors: string[] = [];
    ctl.on('notice', ({ message }) => notices.push(message));
    ctl.on('error', (e) => errors.push(e.code));

    emitState(DECODE_ERROR);

    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalledTimes(2));
    const second = h.fakes.prepare.mock.calls[1]![0] as { startPositionMs: number };
    expect(second.startPositionMs).toBe(LOCAL_DECODE_SKIP_SEC * 1000);
    emitState({ state: 'ready', duration: 60000 });
    await vi.waitFor(() => expect(h.fakes.play).toHaveBeenCalled());

    expect(notices).toEqual(['离线解码异常，正在跳过损坏片段']);
    expect(errors).toEqual([]);
    await ctl.destroy();
  });

  it('跳过一次仍解码失败 → 收口 E_LOCAL_CORRUPT，不再复位', async () => {
    const ctl = await mountLocal();
    const errors: string[] = [];
    ctl.on('error', (e) => errors.push(e.code));

    emitState(DECODE_ERROR);
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalledTimes(2));
    emitState({ state: 'ready', duration: 60000 });

    emitState(DECODE_ERROR);

    await vi.waitFor(() => expect(errors).toEqual(['E_LOCAL_CORRUPT']));
    expect(h.fakes.prepare).toHaveBeenCalledTimes(2);
    await ctl.destroy();
  });

  it('在线播放的解码错误不受本地容错分支影响（维持 E_DECODE 原样上报）', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const el = document.createElement('div');
    document.body.appendChild(el);
    ctl.mount(el);
    const remote: PlaybackSource = { ...makeLocalSource(), url: 'https://a.com/v.m3u8', isLocal: false };
    const loadPromise = ctl.load(makeOptions(remote));
    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
    emitState({ state: 'ready', duration: 60000 });
    await loadPromise;
    const errors: string[] = [];
    ctl.on('error', (e) => errors.push(e.code));

    emitState(DECODE_ERROR);

    await vi.waitFor(() => expect(errors).toEqual(['E_DECODE']));
    await ctl.destroy();
  });
});
