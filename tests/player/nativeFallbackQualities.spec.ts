/**
 * WebView 失败降级原生后，清晰度面板必须仍有档位（A2 回归）
 *
 * 缺陷：主原生构造点接了 `onQualitiesChange`，但"WebView 加载失败 → 自动降级原生"
 * 的第二个构造点漏接，导致恰好在最需要选清晰度的失败场景下面板为空。
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
      return () => {
        h.stateListeners.delete(cb);
      };
    }),
  },
  exoHeadersOf: (headers: Record<string, string>) =>
    Object.entries(headers).map(([key, value]) => ({ key, value })),
  isExoPlayerAvailable: vi.fn(async () => true),
}));

function emitState(data: Record<string, unknown>): void {
  for (const cb of [...h.stateListeners]) cb(data);
}

function makeOptions(): PlayerLoadOptions {
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
    episodeId: 'episode-1',
    lineId: 'line-1',
    title: '测试影片',
    posterUrl: null,
    playback,
    startPositionSec: 0,
    totalEpisodes: 1,
    episodes: [{ episodeId: 'episode-1', number: 1, title: '第 1 集' }],
    preferLocal: false,
  };
}

describe('原生降级路径的清晰度回调（A2）', () => {
  afterEach(() => {
    h.stateListeners.clear();
    document.body.innerHTML = '';
    h.fakes.prepare.mockClear();
  });

  it('WebView 失败 → 原生接管后，qualities 事件仍能透出档位', async () => {
    const ctl = new PlayerController({ onProgress: () => {} });
    const el = document.createElement('div');
    document.body.appendChild(el);
    ctl.mount(el);

    const levels: string[][] = [];
    const notices: string[] = [];
    ctl.on('qualitychange', ({ levels: next }) => levels.push(next));
    ctl.on('notice', ({ message }) => notices.push(message));

    const loadPromise = ctl.load(makeOptions());

    // WebView 先起播 → 派发 error 让其 load 失败，触发自动降级
    await vi.waitFor(() => {
      if (document.querySelector('video') === null) throw new Error('video 未创建');
    });
    document.querySelector('video')!.dispatchEvent(new Event('error'));

    await vi.waitFor(() => expect(h.fakes.prepare).toHaveBeenCalled());
    emitState({ state: 'ready', duration: 60_000 });
    await loadPromise;

    expect(ctl.getEngineKind()).toBe('native');
    expect(notices).toContain('内置引擎加载失败，自动切换到原生引擎');

    emitState({
      state: 'qualities',
      qualities: [
        { id: 1, label: '1080p', width: 1920, height: 1080, bitrate: 4_000_000 },
        { id: 2, label: '720p', width: 1280, height: 720, bitrate: 2_000_000 },
      ],
    });

    // 漏接回调时这里只会剩 load 阶段的空数组
    expect(levels).toContainEqual(['1080p', '720p']);

    await ctl.destroy();
  });
});