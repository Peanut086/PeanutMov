import { describe, expect, it } from 'vitest';

import { episodeCountFromRemarks } from '@/sources/base/normalize';
import { toItemFromVod } from '@/sources/site/tvboxNormalize';
import type { MediaItem, Source } from '@/types';

/**
 * `vod_remarks` 里的集数识别
 *
 * 备注是自由文本：年份（1998）、清晰度（1080P/4K）、帧率（60帧）
 * 都不能被当成集数，否则首页会显示「全 1998 集」。
 */
describe('episodeCountFromRemarks', () => {
  it.each([
    ['全30集', 30],
    ['更新至24集', 24],
    ['全30集（更新至24集）', 30],
    ['第12集', 12],
    ['1-30集', 30],
    ['30集全', 30],
    ['48话', 48],
    ['12期', 12],
    ['更新至24', 24],
    ['已完结共36集', 36],
  ])('%s → %i', (remarks, expected) => {
    expect(episodeCountFromRemarks(remarks)).toBe(expected);
  });

  it.each([
    '1998',
    '1080P',
    '2160P',
    '4K',
    '60帧',
    'HD中字',
    '已完结',
    '更新中',
    '正片',
    '',
    '   ',
  ])('%s → null', (remarks) => {
    expect(episodeCountFromRemarks(remarks)).toBeNull();
  });

  it('非字符串 / 年份数字 → null', () => {
    expect(episodeCountFromRemarks(null)).toBeNull();
    expect(episodeCountFromRemarks(undefined)).toBeNull();
    expect(episodeCountFromRemarks(1998)).toBeNull();
    expect(episodeCountFromRemarks(24)).toBe(24);
  });
});

describe('toItemFromVod：备注不再污染 episodeCount', () => {
  const source: Source = {
    id: 'src-site',
    key: 'src-site',
    name: '站点源',
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://site.example.com/api.php/provide/vod/',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const makeItem = (input: Record<string, unknown>): MediaItem =>
    ({
      id: 'media-1',
      titleLower: '',
      isDemo: false,
      cachedAt: 0,
      updatedAt: 0,
      ...input,
    }) as unknown as MediaItem;

  it('备注为年份 → episodeCount 为 null', () => {
    const item = toItemFromVod(source, { vod_id: 1, vod_name: '尖峰时刻', vod_remarks: '1998' }, makeItem);
    expect(item.episodeCount).toBeNull();
  });

  it('备注为清晰度 → episodeCount 为 null', () => {
    const item = toItemFromVod(source, { vod_id: 2, vod_name: '尖峰时刻2', vod_remarks: '1080P' }, makeItem);
    expect(item.episodeCount).toBeNull();
  });

  it('备注为集数 → 正常解析', () => {
    const item = toItemFromVod(source, { vod_id: 3, vod_name: '嫁金钗', vod_remarks: '全30集' }, makeItem);
    expect(item.episodeCount).toBe(30);
  });
});
