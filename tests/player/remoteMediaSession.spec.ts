/**
 * B1/B2 回归：MediaSession 远端指令 + 后台播放 / 纯音频
 *
 * 断言：
 * - `remote` 事件 → `remotecommand`，未知指令不透出
 * - `playing` / `paused` 事件只同步 JS 状态，不回写引擎（否则原生↔JS 形成回环）
 * - prepare 带上 title/subtitle/artworkUrl（media3 1.3.1 的会话元数据只能来自 MediaItem）
 * - 后台播放 / 纯音频开关转发到插件，且切集重建引擎后自动重放
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { PlayerController } from '@/player/PlayerController';
import type { PlayerLoadOptions } from '@/player/types';

const h = vi.hoisted(() => {
  const stateListeners = new Set<(data: Record<string, unknown>) => void>();
  const fakes = {
    prepare: vi.fn(async () => undefined),
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
    progress: vi.fn(async () => ({ positionMs: 0, durationMs: 0, droppedFrames: 0 })),
  };
  return { stateListeners, fakes };
});

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    ...h.fakes,
    addListener: vi.fn(async (_event: string, cb: (d: Record<string, unknown>) => void) => {
      h.stateListeners.add(cb);
      return { remove: async () => { h.stateListeners.delete(cb); } };
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

function makeOptions(episodeId = 'episode-1'): PlayerLoadOptions {
  const playback: PlaybackSource = {
    url: 'https://a.com/video.mp4',
    format: 'mp4',
    headers: {},
    subtitles: [],
    lineId: 'line-1',
    quality: null,
    expiresAt: null,
    isLocal: false,
  };
  return {
    mediaId: 'media-1',
    episodeId,
    lineId: 'line-1',
    title: '测试影片',
    posterUrl: 'https://a.com/cover.jpg',
    playback,
    startPositionSec: 0,
    totalEpisodes: 2,
    episodes: [
      { episodeId: 'episode-1', number: 1, title: '第 1 集' },
      { episodeId: 'episode-2', number: 2, title: '风暴前夜' },
    ],
    preferLocal: false,
    preferNativeEngine: true,
  };
}

/** 起播到 ready，返回已接管原生的 controller */
async function loadNative(ctl: PlayerController, episodeId = 'episode-1'): Promise<void> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  ctl.mount(el);
  // 二次 load 时旧的 prepare 调用记录会让 waitFor 立刻返回，ready 就发早了
  h.fakes.prepare.mockClear();
  const pending = ctl.load(makeOptions(episodeId));
  await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
  emitState({ state: 'ready', duration: 60_000 });
  emitState({ state: 'firstframe', positionMs: 0 });
  await pending;
}

describe('MediaSession 远端指令与后台播放（B1/B2）', () => {
  afterEach(() => {
    h.stateListeners.clear();
    document.body.innerHTML = '';
    for (const fake of Object.values(h.fakes)) fake.mockClear();
  });

  it('remote 事件透出上/下集与停止，未知指令被丢弃', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNative(ctl);

    const commands: string[] = [];
    ctl.on('remotecommand', ({ command }) => commands.push(command));

    emitState({ state: 'remote', command: 'next' });
    emitState({ state: 'remote', command: 'previous' });
    emitState({ state: 'remote', command: 'stop' });
    emitState({ state: 'remote', command: 'launch-app' });
    emitState({ state: 'remote' });

    expect(commands).toEqual(['next', 'previous', 'stop']);
    await ctl.destroy();
  });

  it('playing/paused 只同步 JS 状态，不回写引擎', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNative(ctl);

    emitState({ state: 'playing' });
    expect(ctl.getPlayerState()).toBe('playing');

    emitState({ state: 'paused' });
    expect(ctl.getPlayerState()).toBe('paused');

    // 回写会让「原生暂停 → JS 暂停 → 原生暂停」无限打转
    expect(h.fakes.play).not.toHaveBeenCalled();
    expect(h.fakes.pause).not.toHaveBeenCalled();
    await ctl.destroy();
  });

  it('prepare 带会话元数据：标题 / 当前集名 / 封面', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNative(ctl, 'episode-2');

    expect(h.fakes.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '测试影片',
        subtitle: '风暴前夜',
        artworkUrl: 'https://a.com/cover.jpg',
      }),
    );
    await ctl.destroy();
  });

  it('后台播放 / 纯音频开关转发插件，并在切集重建引擎后重放', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    await loadNative(ctl);

    ctl.setBackgroundPlayback(true);
    ctl.setAudioOnly(true);
    expect(h.fakes.setBackgroundPlayback).toHaveBeenLastCalledWith({ enabled: true });
    expect(h.fakes.setAudioOnly).toHaveBeenLastCalledWith({ enabled: true });

    // 起播时两个开关默认关（各一次），设置后各再来一次
    expect(h.fakes.setBackgroundPlayback).toHaveBeenCalledTimes(2);
    h.fakes.setBackgroundPlayback.mockClear();
    h.fakes.setAudioOnly.mockClear();

    await loadNative(ctl, 'episode-2');

    expect(h.fakes.setBackgroundPlayback).toHaveBeenCalledWith({ enabled: true });
    expect(h.fakes.setAudioOnly).toHaveBeenCalledWith({ enabled: true });
    await ctl.destroy();
  });
});