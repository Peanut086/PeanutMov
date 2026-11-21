import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, watchEffect } from 'vue';

/**
 * 「继续观看」停在哪儿的那一帧（G-B08 数据层）
 *
 * 锁五条口径：
 * 1. 只有「这部 + 这一集」下载完成、且真的落盘成文件的记录才有帧，位置为 0 / 不可信一律不算；
 * 2. 位置按 4 秒归桶，抽的时刻与缓存键同源——不然 100 秒的键里装着 101.6 秒的画面；
 * 3. 键推导只有一个入口（`resumeFrameKey`），看过 30 秒回首页必须补新帧而不是复用旧帧；
 * 4. 抽不出（失败 / 空串）记成 null，坏文件不反复重试，但和"还在排队"分得开；
 * 5. 串行 + 每帧之间让一帧给渲染，单轮截上限（8 / 低端 4），缓存 LRU 16 帧。
 */

const h = vi.hoisted(() => ({
  tool: { value: true },
  lowEnd: { value: false },
  raf: { count: 0 },
  extract: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/deviceTier', () => ({ isLowEndDevice: () => h.lowEnd.value }));

vi.mock('@/native/mediaToolPlugin', () => ({
  isMediaToolAvailable: () => h.tool.value,
  extractSeekFrames: h.extract,
}));

// 只取路径推导这一件，落盘推导的真实实现要碰原生目录
vi.mock('@/services/downloadService', () => ({
  finalFilePathOf: (task: { filePath: string | null }) => task.filePath ?? '',
}));

import type { DownloadTask } from '@/types';
import {
  requestResumeFrames,
  resumeFrameKey,
  resumeFrameOf,
  resumeFrameSupported,
  resumeLocalPathOf,
  __resetResumeFrameState,
} from '@/services/resumeFrameService';

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 't1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:0:2',
    episodeNumber: 2,
    title: '影片一',
    episodeTitle: '第 2 集',
    posterUrl: null,
    url: 'https://example.test/v.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 3,
    resumable: true,
    sink: 'filesystem',
    filePath: 'downloads/m1/e2.mp4',
    blobKey: null,
    ...overrides,
  } as DownloadTask;
}

const REC = { mediaId: 'demo:m1', episodeId: 'demo:m1:0:2', positionSec: 102.6 };

/** 把排队 + 每帧之间的让帧全部跑完 */
async function settle(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.raf.count = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    h.raf.count += 1;
    return setTimeout(() => cb(0), 0);
  });
  h.tool.value = true;
  h.lowEnd.value = false;
  h.extract.mockReset();
  __resetResumeFrameState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resumeFrameService · 哪些历史有帧', () => {
  it('已下载完成的本机成品：用它的相对路径', () => {
    expect(resumeLocalPathOf(REC, [makeTask()])).toBe('downloads/m1/e2.mp4');
  });

  it('没下载 / 没下完 / blob 落盘 / 集号对不上：一律没有帧（卡片保持海报）', () => {
    expect(resumeLocalPathOf(REC, [])).toBeNull();
    expect(resumeLocalPathOf(REC, [makeTask({ status: 'downloading' })])).toBeNull();
    expect(resumeLocalPathOf(REC, [makeTask({ sink: 'idb-blob', filePath: null, blobKey: 'b' })])).toBeNull();
    expect(resumeLocalPathOf(REC, [makeTask({ mediaId: 'demo:other' })])).toBeNull();
    expect(resumeLocalPathOf(REC, [makeTask({ episodeId: 'demo:m1:0:9' })])).toBeNull();
  });

  it('停在 0 秒（没真正看过）不算帧，位置不可信也不算', () => {
    expect(resumeLocalPathOf({ ...REC, positionSec: 0 }, [makeTask()])).toBeNull();
    expect(resumeLocalPathOf({ ...REC, positionSec: Number.NaN }, [makeTask()])).toBeNull();
    expect(resumeLocalPathOf({ ...REC, positionSec: -3 }, [makeTask()])).toBeNull();
  });

  it('电影没有集号：用这部片子的成品，不误判成"对不上"', () => {
    const movie = { mediaId: 'demo:m2', episodeId: null, positionSec: 60 };
    expect(resumeLocalPathOf(movie, [makeTask({ mediaId: 'demo:m2', episodeId: 'demo:m2:0:1' })])).toBe(
      'downloads/m1/e2.mp4',
    );
  });

  it('这台机器没有抽帧桥：一个原生调用都不发', async () => {
    h.tool.value = false;
    expect(resumeFrameSupported()).toBe(false);
    requestResumeFrames([{ path: 'p1', positionSec: 100 }]);
    await settle();
    expect(h.extract).not.toHaveBeenCalled();
  });

  it('路径为空 / 位置不为正：不上队', async () => {
    h.extract.mockResolvedValue(['f']);
    requestResumeFrames([
      { path: '', positionSec: 100 },
      { path: 'p1', positionSec: 0 },
      { path: 'p2', positionSec: Number.NaN },
      { path: 'p3', positionSec: -10 },
    ]);
    await settle();
    expect(h.extract).not.toHaveBeenCalled();
  });
});

describe('resumeFrameService · 4 秒归桶', () => {
  it('键按 4 秒归桶，且对桶值再取一次不变', () => {
    expect(resumeFrameKey('a.mp4', 101.6)).toBe('a.mp4@100');
    expect(resumeFrameKey('a.mp4', 102.6)).toBe('a.mp4@104');
    expect(resumeFrameKey('a.mp4', 0)).toBe('a.mp4@0');
    expect(resumeFrameKey('a.mp4', -8)).toBe('a.mp4@0');
    // 归桶结果本身是幂等的：用桶值拼键得到的还是同一个键
    expect(resumeFrameKey('a.mp4', 100)).toBe(resumeFrameKey('a.mp4', 101.6));
  });

  it('抽的是归桶后的那一秒，不是原始位置', async () => {
    h.extract.mockResolvedValue(['f']);

    requestResumeFrames([{ path: 'p1', positionSec: 102.6 }]);
    await settle();

    expect(h.extract).toHaveBeenCalledWith('p1', [104_000], 160);
    expect(resumeFrameOf(resumeFrameKey('p1', 102.9))).toEqual(resumeFrameOf(resumeFrameKey('p1', 102.6)));
    expect(resumeFrameOf(resumeFrameKey('p1', 102.6))).toBe('f');
  });

  it('落在同一个 4 秒窗口里的两个位置只抽一次', async () => {
    h.extract.mockResolvedValue(['f']);

    requestResumeFrames([
      { path: 'p1', positionSec: 101 },
      { path: 'p1', positionSec: 101.9 },
    ]);
    await settle();

    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('看过 30 秒再回首页：新位置是新键，会补一帧新的，旧帧不被覆盖', async () => {
    h.extract.mockResolvedValueOnce(['old']).mockResolvedValueOnce(['new']);

    requestResumeFrames([{ path: 'p1', positionSec: 100 }]);
    await settle();
    expect(resumeFrameOf(resumeFrameKey('p1', 100))).toBe('old');

    requestResumeFrames([{ path: 'p1', positionSec: 130 }]);
    await settle();

    expect(h.extract).toHaveBeenCalledTimes(2);
    expect(resumeFrameOf(resumeFrameKey('p1', 130))).toBe('new');
    expect(resumeFrameOf(resumeFrameKey('p1', 100))).toBe('old');
  });
});

describe('resumeFrameService · 排队节奏与缓存', () => {
  it('幂等：排队中与已有结论都不再重排，包括"确认抽不出"', async () => {
    h.extract.mockResolvedValueOnce(['f']).mockResolvedValueOnce(null);

    const targets = [
      { path: 'p1', positionSec: 100 },
      { path: 'p2', positionSec: 200 },
    ];
    requestResumeFrames(targets);
    requestResumeFrames(targets);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(2);

    // p1 有画面、p2 确认抽不出，两种都不该再来一遍
    requestResumeFrames(targets);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(2);
    expect(resumeFrameOf(resumeFrameKey('p2', 200))).toBeNull();
  });

  it('抽不出与还在抽分得开', async () => {
    h.extract.mockResolvedValueOnce(['f']);
    requestResumeFrames([{ path: 'p1', positionSec: 100 }]);
    // 原生还没回：这条是"正在排队"
    expect(resumeFrameOf(resumeFrameKey('p1', 100))).toBeNull();

    await settle();
    expect(resumeFrameOf(resumeFrameKey('p1', 100))).toBe('f');

    h.extract.mockResolvedValueOnce([]);
    requestResumeFrames([{ path: 'p2', positionSec: 100 }]);
    await settle();
    expect(resumeFrameOf(resumeFrameKey('p2', 100))).toBeNull();
  });

  it('原生抛错只留空，不留下"正在抽"的假状态', async () => {
    h.extract.mockRejectedValueOnce(new Error('E_DECODE'));

    requestResumeFrames([{ path: 'p1', positionSec: 100 }]);
    await settle();

    expect(resumeFrameOf(resumeFrameKey('p1', 100))).toBeNull();
    const key = resumeFrameKey('p1', 100);
    expect(key).toBe('p1@100');
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('单轮最多 8 帧，低端机 4 帧', async () => {
    h.extract.mockResolvedValue(['f']);
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `p${i}`, positionSec: 100 + i * 60 }));

    requestResumeFrames(many);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(8);

    h.lowEnd.value = true;
    __resetResumeFrameState();
    h.extract.mockClear();
    requestResumeFrames(many);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(4);
  });

  it('串行：上一帧没回，下一帧不会并发进来', async () => {
    let releaseFirst: () => void = () => undefined;
    let secondStarted = false;
    h.extract
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            releaseFirst = () => resolve(['a']);
          }),
      )
      .mockImplementationOnce(() => {
        secondStarted = true;
        return Promise.resolve(['b']);
      });

    requestResumeFrames([
      { path: 'p1', positionSec: 100 },
      { path: 'p2', positionSec: 100 },
    ]);
    await settle();
    expect(secondStarted).toBe(false);

    releaseFirst();
    await settle();

    expect(secondStarted).toBe(true);
    // 两帧之间各让一次渲染
    expect(h.raf.count).toBeGreaterThanOrEqual(2);
  });

  it('满 16 帧后挤出最久未用的，摸过的往后挪', async () => {
    h.extract.mockResolvedValue(['f']);
    const many = Array.from({ length: 16 }, (_, i) => ({ path: `p${i}`, positionSec: 100 + i * 60 }));

    requestResumeFrames(many);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(8);
    // 剩下的补满 16
    requestResumeFrames(many);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(16);

    const firstKey = resumeFrameKey('p0', 100);
    const secondKey = resumeFrameKey('p1', 160);
    // 摸一下第 0 帧：该被挤出去的变成第 1 帧
    expect(resumeFrameOf(firstKey)).toBe('f');
    requestResumeFrames([{ path: 'p16', positionSec: 100 }]);
    await settle();

    expect(resumeFrameOf(resumeFrameKey('p16', 100))).toBe('f');
    expect(resumeFrameOf(secondKey)).toBeNull();
    expect(resumeFrameOf(firstKey)).toBe('f');
  });

  it('缓存写入能被 computed 感知，读取本身不会自激循环', async () => {
    h.extract.mockResolvedValue(['data:one']);
    const key = resumeFrameKey('p1', 100);
    const view = computed(() => resumeFrameOf(key));
    const renders: (string | null)[] = [];
    const stop = watchEffect(() => renders.push(view.value));

    requestResumeFrames([{ path: 'p1', positionSec: 100 }]);
    await settle();
    await nextTick();
    stop();

    expect(view.value).toBe('data:one');
    expect(renders.length).toBeLessThanOrEqual(2);
  });

  it('空键读取不炸', () => {
    expect(resumeFrameOf('')).toBeNull();
    expect(resumeFrameOf(null)).toBeNull();
    expect(resumeFrameKey('p', Number.NaN)).toBe('p@0');
  });
});
