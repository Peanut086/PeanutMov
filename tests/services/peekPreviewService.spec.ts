import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 原位放映的取帧服务（G-B02）
 *
 * 这一层只有一个职责：**能不能就地放一小段，不能的话原因是什么**。
 * 锁住四条口径：
 * 1. 只认相对 `Directory.Data` 的本地成品（与进度条胶片 A-03 同源），blob 容器没有文件可开；
 * 2. 放哪一集由历史决定，历史不认源（跨源的脏记录不能替用户选集），没历史才退最小集号；
 * 3. 时长只认「这条历史记录说的正是这一集」，否则宁可现场探一次——拿别的集的时长铺帧会铺歪；
 * 4. 五种降级各走各的文案，绝不把「这台机器压根没抽帧桥」说成「这一集抽不出画面」。
 *
 * `finalFilePathOf` 与两个 repo 都被替身接管：本用例关心的是编排与判定，不是落盘路径推导。
 */

const h = vi.hoisted(() => ({
  tool: { value: true },
  listByMedia: vi.fn(),
  getByMedia: vi.fn(),
  extractSeekFrames: vi.fn(),
  verifyRemuxedMedia: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/db/repositories/downloadRepo', () => ({ downloadRepo: { listByMedia: h.listByMedia } }));
vi.mock('@/db/repositories/historyRepo', () => ({ historyRepo: { getByMedia: h.getByMedia } }));

vi.mock('@/services/downloadService', () => ({
  finalFilePathOf: (task: { filePath: string | null; mediaId: string; episodeId: string }) =>
    task.filePath ?? `downloads/${task.mediaId}/${task.episodeId}.mp4`,
}));

vi.mock('@/native/mediaToolPlugin', () => ({
  isMediaToolAvailable: () => h.tool.value,
  extractSeekFrames: h.extractSeekFrames,
  verifyRemuxedMedia: h.verifyRemuxedMedia,
}));

import type { DownloadTask, HistoryRecord, MediaItem } from '@/types';
import {
  peekFallbackNote,
  resolvePeekPreview,
  __resetPeekCache,
  type PeekFallback,
} from '@/services/peekPreviewService';

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'mock:m1~a',
    sourceId: 'mock',
    sourceItemId: 'm1',
    title: '影片一',
    originalTitle: null,
    type: 'series',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: 'https://example.test/p.jpg',
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: 3,
    titleLower: '影片一',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    sourceId: 'mock',
    mediaId: 'mock:m1~a',
    episodeId: 'e1',
    episodeNumber: 1,
    lineId: 'line-a',
    title: '影片一',
    episodeTitle: null,
    posterUrl: null,
    url: 'https://example.test/1.ts',
    headers: {},
    format: 'hls',
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
    filePath: 'downloads/mock:m1~a/e1.mp4',
    blobKey: null,
    ...overrides,
  } as DownloadTask;
}

function makeHistory(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'mock:mock:m1~a',
    sourceId: 'mock',
    mediaId: 'mock:m1~a',
    episodeId: 'e1',
    episodeNumber: 1,
    title: '影片一',
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 六帧的桩数据：够用，又能区分「全成」与「部分失败」 */
function frameList(count = 6): (string | null)[] {
  return Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,F${i}`);
}

const cores = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');

beforeEach(() => {
  h.tool.value = true;
  h.listByMedia.mockReset().mockResolvedValue([makeTask()]);
  h.getByMedia.mockReset().mockResolvedValue(null);
  h.extractSeekFrames.mockReset().mockResolvedValue(frameList());
  h.verifyRemuxedMedia.mockReset().mockResolvedValue({ ok: true, durationUs: 500_000_000 });
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 8 });
  __resetPeekCache();
});

afterEach(() => {
  if (cores) Object.defineProperty(navigator, 'hardwareConcurrency', cores);
});

describe('resolvePeekPreview · 能不能就地放', () => {
  it('抽帧桥不可用（Web / 旧 APK）时直接降级，一次数据库都不碰', async () => {
    h.tool.value = false;

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-tool' });
    expect(h.listByMedia).not.toHaveBeenCalled();
    expect(h.getByMedia).not.toHaveBeenCalled();
  });

  it('没有已完成下载 = 在线源，只给海报', async () => {
    h.listByMedia.mockResolvedValue([makeTask({ status: 'downloading', id: 'task-2' })]);

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-download' });
    expect(h.extractSeekFrames).not.toHaveBeenCalled();
  });

  it('两个仓库都抛错时按「没下载过」处理，不把异常扔给交互', async () => {
    h.listByMedia.mockRejectedValue(new Error('db closed'));
    h.getByMedia.mockRejectedValue(new Error('db closed'));

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-download' });
  });

  it('blob 容器没有可随机读的文件，按 no-file 降级', async () => {
    h.listByMedia.mockResolvedValue([makeTask({ sink: 'idb-blob', filePath: null, blobKey: 'blob:1' })]);

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-file' });
  });

  it('拼不出成品路径时同样按 no-file（老任务字段残缺）', async () => {
    h.listByMedia.mockResolvedValue([makeTask({ filePath: '' })]);

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-file' });
  });
});

describe('resolvePeekPreview · 放哪一集', () => {
  it('历史那一集优先，且集号写回给界面说明', async () => {
    h.listByMedia.mockResolvedValue([
      makeTask({ episodeId: 'e1', episodeNumber: 1 }),
      makeTask({ episodeId: 'e2', episodeNumber: 2, filePath: 'downloads/m/e2.mp4' }),
      makeTask({ episodeId: 'e3', episodeNumber: 3, filePath: 'downloads/m/e3.mp4' }),
    ]);
    h.getByMedia.mockResolvedValue(makeHistory({ episodeId: 'e2', episodeNumber: 2 }));

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.episodeId).toBe('e2');
    expect(result.clip?.episodeLabel).toBe('第 2 集');
    expect(result.clip?.lineId).toBe('line-a');
  });

  it('没有历史时取最小集号，而不是数组里的第一条', async () => {
    h.listByMedia.mockResolvedValue([
      makeTask({ episodeId: 'e3', episodeNumber: 3, filePath: 'downloads/m/e3.mp4' }),
      makeTask({ episodeId: 'e1', episodeNumber: 1, filePath: 'downloads/m/e1.mp4' }),
      makeTask({ episodeId: 'e2', episodeNumber: 2, filePath: 'downloads/m/e2.mp4' }),
    ]);

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.episodeId).toBe('e1');
    expect(result.clip?.episodeLabel).toBe('第 1 集');
  });

  it('跨源的脏历史不能替用户选集', async () => {
    h.listByMedia.mockResolvedValue([
      makeTask({ episodeId: 'e1', episodeNumber: 1, filePath: 'downloads/m/e1.mp4' }),
      makeTask({ episodeId: 'e2', episodeNumber: 2, filePath: 'downloads/m/e2.mp4' }),
    ]);
    h.getByMedia.mockResolvedValue(makeHistory({ sourceId: 'other', episodeId: 'e2', episodeNumber: 2 }));

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.episodeId).toBe('e1');
  });

  it('单集影片（无集号）用集标题说明，不硬凑「第 N 集」', async () => {
    h.listByMedia.mockResolvedValue([makeTask({ episodeNumber: null, episodeTitle: '剧场版' })]);

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.episodeLabel).toBe('剧场版');
  });

  it('既没集号也没标题时用「已下载内容」，不留空白', async () => {
    h.listByMedia.mockResolvedValue([makeTask({ episodeNumber: null, episodeTitle: null })]);

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.episodeLabel).toBe('已下载内容');
  });
});

describe('resolvePeekPreview · 时长从哪来', () => {
  it('历史说的正是这一集时直接用它的时长，不再解码探一次', async () => {
    h.getByMedia.mockResolvedValue(makeHistory({ episodeId: 'e1', durationSec: 600 }));

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.durationSec).toBe(600);
    expect(h.verifyRemuxedMedia).not.toHaveBeenCalled();
  });

  it('历史那集没在下载列表里：时长不通用，改走现场探测', async () => {
    h.listByMedia.mockResolvedValue([
      makeTask({ episodeId: 'e1', episodeNumber: 1, filePath: 'downloads/m/e1.mp4' }),
      makeTask({ episodeId: 'e2', episodeNumber: 2, filePath: 'downloads/m/e2.mp4' }),
    ]);
    // 看到第 9 集去了（跨季 / 那集没下载）：既对不上集 id 也对不上集号，挑出来的还是第 1 集
    h.getByMedia.mockResolvedValue(makeHistory({ episodeId: 'e9', episodeNumber: 9, durationSec: 600 }));
    h.verifyRemuxedMedia.mockResolvedValue({ ok: false, durationUs: 90_000_000 });

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.episodeLabel).toBe('第 1 集');
    expect(result.clip?.durationSec).toBe(90);
    expect(h.verifyRemuxedMedia).toHaveBeenCalledWith('downloads/m/e1.mp4');
  });

  it('铺帧落在各自时间格里，不贴首尾边界', async () => {
    h.getByMedia.mockResolvedValue(makeHistory({ episodeId: 'e1', durationSec: 600 }));

    await resolvePeekPreview(makeItem());
    const times = h.extractSeekFrames.mock.calls[0]?.[1] as number[];
    expect(times).toHaveLength(12);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[times.length - 1]).toBeLessThan(600_000);
    expect(times[0]).toBeCloseTo(25_000, 0);
  });

  it('探测读不到时长就按 no-duration，不用假时长铺帧', async () => {
    h.verifyRemuxedMedia.mockResolvedValue(null);

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-duration' });
    expect(h.extractSeekFrames).not.toHaveBeenCalled();
  });

  it('探测抛异常同样按 no-duration（旧 APK 桥接返回畸形值）', async () => {
    h.verifyRemuxedMedia.mockRejectedValue(new Error('boom'));

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-duration' });
  });
});

describe('resolvePeekPreview · 抽帧结果与缓存', () => {
  it('部分帧取不到时只留成功的，别让放映台放到空帧', async () => {
    h.extractSeekFrames.mockResolvedValue(['A', null, 'B', null, '', 'C']);

    const result = await resolvePeekPreview(makeItem());
    expect(result.clip?.frames).toEqual(['A', 'B', 'C']);
    expect(result.fallback).toBeNull();
  });

  it('全取不到 = no-frames（文件坏掉/编码不支持的诚实说法）', async () => {
    h.extractSeekFrames.mockResolvedValue([null, null]);

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-frames' });
  });

  it('桥接整体返回 null 同样按 no-frames', async () => {
    h.extractSeekFrames.mockResolvedValue(null);

    await expect(resolvePeekPreview(makeItem())).resolves.toEqual({ clip: null, fallback: 'no-frames' });
  });

  it('同一集成品第二次长按不再解码取帧', async () => {
    await resolvePeekPreview(makeItem());
    const first = await resolvePeekPreview(makeItem());

    expect(first.clip?.frames).toHaveLength(6);
    expect(h.extractSeekFrames).toHaveBeenCalledTimes(1);
  });

  it('换一集就是另一份成品，不该命中上一集的缓存', async () => {
    h.listByMedia.mockResolvedValue([
      makeTask({ episodeId: 'e1', episodeNumber: 1, filePath: 'downloads/m/e1.mp4' }),
      makeTask({ episodeId: 'e2', episodeNumber: 2, filePath: 'downloads/m/e2.mp4' }),
    ]);
    await resolvePeekPreview(makeItem());
    h.getByMedia.mockResolvedValue(makeHistory({ episodeId: 'e2', episodeNumber: 2 }));
    await resolvePeekPreview(makeItem());

    expect(h.extractSeekFrames).toHaveBeenCalledTimes(2);
    expect(h.extractSeekFrames.mock.calls[1]?.[0]).toBe('downloads/m/e2.mp4');
  });

  it('低端机减半：6 帧、长边 224', async () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 });

    const result = await resolvePeekPreview(makeItem());
    expect(h.extractSeekFrames.mock.calls[0]?.[1]).toHaveLength(6);
    expect(h.extractSeekFrames.mock.calls[0]?.[2]).toBe(224);
    expect(result.clip?.frames).toHaveLength(6);
  });

  it('高档是 12 帧、长边 320', async () => {
    await resolvePeekPreview(makeItem());
    expect(h.extractSeekFrames.mock.calls[0]?.[2]).toBe(320);
  });
});

describe('peekFallbackNote', () => {
  const ALL: PeekFallback[] = ['no-tool', 'no-download', 'no-file', 'no-duration', 'no-frames'];

  it('五种原因五种说法，但都收在同一个口径上', () => {
    const notes = ALL.map(peekFallbackNote);
    expect(new Set(notes).size).toBe(ALL.length);
    for (const note of notes) expect(note.endsWith('仅海报预览')).toBe(true);
  });

  it('没下载过说的是「在线源」，不是「本机不支持」', () => {
    expect(peekFallbackNote('no-download')).toBe('在线源 · 仅海报预览');
    expect(peekFallbackNote('no-tool')).toContain('本机暂不支持抽帧');
  });
});
