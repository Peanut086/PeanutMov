import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PlaybackProgressTarget } from '@/services/playbackProgressService';
import { useHistoryStore } from '@/stores/historyStore';
import { historyIdOf } from '@/shared/id';
import type { HistoryRecord } from '@/types';

import { resetAll } from '../unit/helpers';

function target(): PlaybackProgressTarget {
  return {
    sourceId: 'src-a',
    mediaId: 'A:m1',
    title: '绝命毒师 第三季',
    year: 2008,
    episodeNumber: 5,
  };
}

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  const sourceId = overrides.sourceId ?? 'src-b';
  const mediaId = overrides.mediaId ?? 'B:m1';
  return {
    id: historyIdOf(sourceId, mediaId),
    sourceId,
    mediaId,
    episodeId: `${mediaId}:e5`,
    episodeNumber: 5,
    title: '绝命毒师 S03',
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 7,
    createdAt: 1_000,
    updatedAt: 2_000,
    mediaSnapshot: {
      sourceItemId: mediaId,
      type: 'series',
      year: 2008,
      episodeCount: 7,
      originalTitle: null,
    },
    ...overrides,
  };
}

describe('历史 store 跨源续播入口', () => {
  beforeEach(async () => {
    await resetAll();
    setActivePinia(createPinia());
  });

  it('播放写回保留分集标题，供跨源冲突校验使用', async () => {
    const store = useHistoryStore();
    const saved = await store.save({
      sourceId: 'src-b',
      mediaId: 'B:m1',
      episodeId: 'B:m1:e5',
      episodeNumber: 5,
      episodeTitle: '第5集 重逢',
      lineId: 'line-2',
      title: '绝命毒师 S03',
      posterUrl: null,
      positionSec: 120,
      durationSec: 600,
      totalEpisodes: 7,
    });

    expect(saved.episodeTitle).toBe('第5集 重逢');
    expect(saved.lineId).toBe('line-2');
    expect(store.items.find((entry) => entry.id === saved.id)?.lineId).toBe('line-2');
  });

  it('旧调用不传线路时保留已有线路，新记录仍按无线路兼容', async () => {
    const store = useHistoryStore();
    const input = {
      sourceId: 'src-b',
      mediaId: 'B:m1',
      episodeId: 'B:m1:e5',
      episodeNumber: 5,
      title: '绝命毒师 S03',
      posterUrl: null,
      positionSec: 120,
      durationSec: 600,
      totalEpisodes: 7,
    };
    const first = await store.save({ ...input, lineId: 'line-2' });
    const updated = await store.save({ ...input, positionSec: 180 });

    expect(updated.lineId).toBe('line-2');
    expect(store.items.find((entry) => entry.id === first.id)?.lineId).toBe('line-2');

    const legacy = await store.save({ ...input, mediaId: 'B:legacy', episodeId: 'B:legacy:e5' });
    expect(legacy.lineId).toBeNull();
  });

  it('progressOf 仍只按当前源与媒体精确查找', () => {
    const store = useHistoryStore();
    const exact = record({ sourceId: 'src-a', mediaId: 'A:m1' });
    const cross = record();
    store.items = [cross, exact];

    expect(store.progressOf('src-a', 'A:m1')).toEqual(exact);
    expect(store.progressOf('src-a', 'A:missing')).toBeNull();
    expect(store.progressOf('src-b', 'B:m1')).toEqual(cross);
  });

  it('resolveProgress 保留当前源精确记录优先级', async () => {
    const store = useHistoryStore();
    const exact = record({ sourceId: 'src-a', mediaId: 'A:m1', episodeNumber: null });
    const cross = record({ updatedAt: 9_000 });
    store.items = [cross, exact];

    await expect(store.resolveProgress(target())).resolves.toEqual({
      record: exact,
      episodeNumber: null,
    });
  });

  it('resolveProgress 返回跨源来源记录且不改写来源 episodeId', async () => {
    const store = useHistoryStore();
    const candidate = record();
    store.items = [candidate];

    const result = await store.resolveProgress(target());
    expect(result).toEqual({ record: candidate, episodeNumber: 5 });
    expect(result?.record.episodeId).toBe('B:m1:e5');
  });
});
