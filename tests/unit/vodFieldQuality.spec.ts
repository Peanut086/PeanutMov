import { describe, expect, it } from 'vitest';

import {
  inferMediaType,
  inferTypeFromShape,
  normalizeDurationSec,
  normalizeTags,
  yearFromTitle,
} from '@/sources/base/normalize';
import { toItemFromVod } from '@/sources/site/tvboxNormalize';
import type { MediaItem, Source } from '@/types';

/**
 * 采集站字段质量（P2-7）
 *
 * 真机实测设备缓存 947 条：`vod_year` 空 736 条、`type` 落到 `other` 861 条
 * （其中 779 条根本没有 `type_name`）、标签里混着繁体计量单位与 ISO 时间戳。
 * 这里钉住「补得上来的」与「绝不瞎猜的」两侧边界。
 */

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

describe('yearFromTitle：只认位置受限的年份', () => {
  it.each([
    ['庆余年(2019)', 2019],
    ['庆余年（2019）', 2019],
    ['1993年07月26日上映', 1993],
    ['漂白 2025', 2025],
    ['绝命毒师 第二季 2013', 2013],
  ])('%s → %i', (title, expected) => {
    expect(yearFromTitle(title)).toBe(expected);
  });

  it.each([
    // 片名里的数字不是发行年：放开会把《2001太空漫游》拆成 1968/2001 两组
    '2001太空漫游',
    '101次求婚',
    // 汉字直接接年份：设备缓存没有这类样本，放开只有风险没有实测收益
    '流浪地球2019',
    '消失的1937',
    '',
  ])('%s → null（宁缺毋滥）', (title) => {
    expect(yearFromTitle(title)).toBeNull();
  });

  it('非字符串 → null', () => {
    expect(yearFromTitle(null)).toBeNull();
    expect(yearFromTitle(undefined)).toBeNull();
    expect(yearFromTitle(2019 as unknown as string)).toBeNull();
  });
});

describe('inferTypeFromShape：分类字段缺失时用备注形态兜底', () => {
  it.each(['已完结', '更新至HD', '13集全', '第8集', '连载中'])('%s → series', (remarks) => {
    expect(inferTypeFromShape(remarks, null)).toBe('series');
  });

  it('episodeCount 已推出来即连载（备注可以很脏）', () => {
    expect(inferTypeFromShape('HD中字', 24)).toBe('series');
  });

  it('推不出就交回 null，不伪造类型', () => {
    expect(inferTypeFromShape('正片', null)).toBeNull();
    expect(inferTypeFromShape(null, null)).toBeNull();
    expect(inferTypeFromShape('HD', 1)).toBeNull();
  });
});

describe('inferMediaType：截断/地域写法与季号', () => {
  it.each(['电视', '国产剧', '日韩剧', '短剧', '美剧'])('%s → series', (typeName) => {
    expect(inferMediaType(typeName)).toBe('series');
  });

  it('片名里的季号也算连载形态（实测 779 条根本没有 type_name）', () => {
    expect(inferMediaType('', '绝命毒师 第二季')).toBe('series');
    expect(inferMediaType('', '庆余年 第3季')).toBe('series');
  });

  it('「剧情」「喜剧」是类型不是连载形态，不放开裸「剧」字', () => {
    expect(inferMediaType('剧情')).not.toBe('series');
    expect(inferMediaType('喜剧')).not.toBe('series');
  });

  it('单集写法「第5集」不当连载（可能是分集标题）', () => {
    expect(inferMediaType('', '某某 第5集')).not.toBe('series');
  });
});

describe('normalizeTags：切自由文本但不切语义', () => {
  it('繁体计量单位归一', () => {
    expect(normalizeTags('3分鐘')).toEqual(['3分钟']);
    expect(normalizeTags('1.5小時')).toEqual(['1.5小时']);
    expect(normalizeTags('90秒鐘')).toEqual(['90秒']);
  });

  it('日期当标签的直接丢掉', () => {
    expect(normalizeTags('2019-04-01')).toEqual([]);
    expect(normalizeTags('2019-04-01T12:00:00')).toEqual([]);
    // 分隔符把日期切碎后：合法年份留下，「04」「01」这种碎片丢弃
    expect(normalizeTags('2019/04/01')).toEqual(['2019']);
  });

  it('整句备注不是标签（按显示宽度切，不按字符数）', () => {
    const sentence = '本片讲述了一个发生在民国年间的离奇案件，真相扑朔迷离耐人寻味';
    expect(normalizeTags(sentence)).toEqual([]);
    // 逗号切开后两段仍是句子片段
    expect(normalizeTags('更新至24集, 蓝光原盘, HD中字')).toEqual(['更新至24集', '蓝光原盘', 'HD中字']);
  });

  it('去重且保留正常标签', () => {
    expect(normalizeTags('纪录片, 纪录片 / HD中字 / 4K')).toEqual(['纪录片', 'HD中字', '4K']);
  });

  it('非字符串 → 空数组', () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe('normalizeDurationSec：繁体单位', () => {
  it.each([
    ['3分鐘', 180],
    ['45分钟', 2700],
    ['1.5小時', 5400],
    ['2小时', 7200],
  ])('%s → %i 秒', (value, expected) => {
    expect(normalizeDurationSec(value)).toBe(expected);
  });
});

describe('toItemFromVod：派生字段落到条目上', () => {
  it('无 type_name、备注「已完结」→ series + 标签清洗', () => {
    const item = toItemFromVod(
      source,
      { vod_id: 11, vod_name: '猎罪图鉴', vod_remarks: '已完结' },
      makeItem,
    );
    expect(item.type).toBe('series');
    expect(item.tags).toEqual(['已完结']);
  });

  it('备注给出集数 → episodeCount 与 type 同时受益', () => {
    const item = toItemFromVod(source, { vod_id: 12, vod_name: '嫁金钗', vod_remarks: '全30集' }, makeItem);
    expect(item.episodeCount).toBe(30);
    expect(item.type).toBe('series');
  });

  it('vod_year 缺失时从片名补，但片名数字不当年份', () => {
    expect(toItemFromVod(source, { vod_id: 13, vod_name: '庆余年(2019)' }, makeItem).year).toBe(2019);
    expect(toItemFromVod(source, { vod_id: 14, vod_name: '2001太空漫游' }, makeItem).year).toBeNull();
  });

  it('片名年份优先于错标 vod_year，片名无可信年份时才用 vod_year', () => {
    const item = toItemFromVod(
      source,
      { vod_id: 15, vod_name: '流浪地球(2019)', vod_year: '2023' },
      makeItem,
    );
    expect(item.year).toBe(2019);
    expect(toItemFromVod(source, { vod_id: 20, vod_name: '流浪地球', vod_year: '2019' }, makeItem).year).toBe(2019);
  });

  it('电影备注「正片」不会被误判成连载', () => {
    const item = toItemFromVod(
      source,
      { vod_id: 16, vod_name: '飞虎精英之人间有情', vod_remarks: '正片', type_name: '电影' },
      makeItem,
    );
    expect(item.type).toBe('movie');
  });

  it('标签最多留 3 个（卡片只有一行）', () => {
    const item = toItemFromVod(
      source,
      { vod_id: 17, vod_name: '某片', vod_remarks: 'HD, 中字, 粤语, 蓝光, 完整版' },
      makeItem,
    );
    expect(item.tags).toHaveLength(3);
  });

  it('vod_actor 拆成主演数组（演员搜索的数据源）', () => {
    const item = toItemFromVod(
      source,
      { vod_id: 18, vod_name: '飞驰人生', vod_actor: '沈腾, 尹正， 黄景瑜' },
      makeItem,
    );
    expect(item.actors).toEqual(['沈腾', '尹正', '黄景瑜']);
  });

  it('没有 vod_actor 时不编主演', () => {
    const item = toItemFromVod(source, { vod_id: 19, vod_name: '某纪录片' }, makeItem);
    expect(item.actors).toEqual([]);
  });
});
