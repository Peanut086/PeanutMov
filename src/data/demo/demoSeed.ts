/**
 * 演示源种子（FR-43 / AC-95、AC-97、AC-99）
 *
 * - 写入演示源本身、12 条媒体、线路、剧集与 4 个分类；
 * - **幂等**：已存在的 id 用 put 覆盖，不产生重复条目；条数恒定等于片单长度；
 * - 与 `seedService.ensureDemo()` 配合：`main.ts` 启动时调用一次即可。
 */
import { withTx } from '@/db/index';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { DEMO_CATEGORIES, DEMO_ITEMS, demoBackdrop, demoPoster } from '@/data/demo/demoCatalog';
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { categoryIdFor } from '@/sources/base/normalize';
import type { Category, Episode, MediaItem, PlayLine, Source } from '@/types';

/** 演示源固定 ID 与排序（技术方案 4 章：demo 固定为 'demo'，sort 恒为 9999） */
export const DEMO_SOURCE_ID = 'demo';
export const DEMO_SOURCE_SORT = 9999;
export const DEMO_SOURCE_NAME = '内置演示';

export function buildDemoSource(now: number = Date.now()): Source {
  return {
    id: DEMO_SOURCE_ID,
    key: DEMO_SOURCE_ID,
    name: DEMO_SOURCE_NAME,
    type: 'demo',
    enabled: true,
    builtin: true,
    sort: DEMO_SOURCE_SORT,
    baseUrl: '',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'ok',
    healthCheckedAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildDemoCategories(sourceId: string): Category[] {
  return DEMO_CATEGORIES.map((category) => ({
    id: categoryIdFor(sourceId, category.value),
    sourceId,
    name: category.name,
    value: category.value,
    order: category.order,
  }));
}

export function buildDemoMedia(sourceId: string, now: number = Date.now()): MediaItem[] {
  return DEMO_ITEMS.map((seed) => {
    const episodeTotal = seed.lines[0]?.episodes.length ?? 0;
    return {
      id: mediaIdOf(sourceId, seed.itemId),
      sourceId,
      sourceItemId: seed.itemId,
      title: seed.title,
      originalTitle: seed.originalTitle,
      type: seed.type,
      year: seed.year,
      area: seed.area,
      genres: seed.genres,
      tags: seed.tags,
      rating: seed.rating,
      posterUrl: demoPoster(seed.title, seed.hue),
      backdropUrl: demoBackdrop(seed.title, seed.hue),
      description: seed.description,
      durationSec: seed.durationSec,
      episodeCount: seed.type === 'movie' ? null : episodeTotal,
      titleLower: seed.title.toLowerCase(),
      isDemo: true,
      cachedAt: now,
      updatedAt: now,
    };
  });
}

export interface DemoLineAndEpisodes {
  lines: PlayLine[];
  episodes: Episode[];
}

/** 由片单构造某演示源的线路与剧集（ID 规则见 shared/id.ts） */
export function buildDemoLinesAndEpisodes(sourceId: string, now: number = Date.now()): DemoLineAndEpisodes {
  const lines: PlayLine[] = [];
  const episodes: Episode[] = [];
  for (const seed of DEMO_ITEMS) {
    const mediaId = mediaIdOf(sourceId, seed.itemId);
    seed.lines.forEach((lineSeed, index) => {
      const lineId = lineIdOf(mediaId, index);
      lines.push({
        id: lineId,
        mediaId,
        sourceId,
        name: lineSeed.name,
        quality: lineSeed.quality,
        format: lineSeed.format,
        index,
      });
      lineSeed.episodes.forEach((episodeSeed, epIndex) => {
        const number = epIndex + 1;
        episodes.push({
          id: episodeIdOf(mediaId, lineId, number),
          mediaId,
          sourceId,
          lineId,
          number,
          title: episodeSeed.title,
          durationSec: episodeSeed.durationSec,
          subtitles: [],
          updatedAt: now,
        });
      });
    });
  }
  return { lines, episodes };
}

/**
 * 写入演示数据（幂等）。
 * `enabled` 缺省保持调用方传入的值；`restore` 为 true 时强制启用。
 */
export async function seedDemoData(opts?: { sourceId?: string; restore?: boolean }): Promise<Source> {
  const sourceId = opts?.sourceId ?? DEMO_SOURCE_ID;
  const now = Date.now();
  const existing = await sourceRepo.get(sourceId);
  const base = existing ?? buildDemoSource(now);
  const source: Source = {
    ...base,
    enabled: opts?.restore === true ? true : base.enabled,
    sort: DEMO_SOURCE_SORT,
    builtin: true,
    updatedAt: now,
    health: opts?.restore === true || !existing ? 'ok' : base.health,
    healthCheckedAt: opts?.restore === true || !existing ? now : base.healthCheckedAt,
    lastErrorCode: null,
  };

  const categories = buildDemoCategories(sourceId);
  const media = buildDemoMedia(sourceId, now);
  const { lines, episodes } = buildDemoLinesAndEpisodes(sourceId, now);

  await withTx(
    ['sources', 'categories', 'media', 'lines', 'episodes'],
    'readwrite',
    async (tx) => {
      await tx.objectStore('sources').put(source);
      await categoryRepo.replaceForSource(sourceId, categories, tx);
      const mediaStore = tx.objectStore('media');
      for (const item of media) await mediaStore.put(item);
      await lineRepo.saveMany(lines, tx);
      await episodeRepo.saveMany(episodes, tx);
    },
  );

  return source;
}

/** 演示数据是否已完整写入（条数等于片单长度且分类齐全） */
export async function isDemoSeeded(sourceId: string = DEMO_SOURCE_ID): Promise<boolean> {
  const [media, categories] = await Promise.all([
    mediaRepo.countBySource(sourceId),
    categoryRepo.listBySource(sourceId),
  ]);
  return media >= DEMO_ITEMS.length && categories.length >= DEMO_CATEGORIES.length;
}
