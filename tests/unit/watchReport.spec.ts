/**
 * 观影报告聚合（D2）
 *
 * 重点盯三件事：
 * 1. 时长估算口径（完播归零、剧集前 N-1 集、异常集号不许放大）；
 * 2. 月份窗口与连续天数（跨年、断档、最近一次不在今天/昨天）；
 * 3. 题材多归属的分母，以及元数据缺失时的诚实归类。
 */
import { describe, expect, it } from 'vitest';

import {
  REPORT_MONTH_WINDOW,
  almostFinished,
  buildWatchReport,
  estimatedWatchSeconds,
  filterTitles,
  formatReportText,
  type ReportMeta,
} from '@/shared/watchReport';
import type { HistoryRecord } from '@/types';

const NOW = new Date(2026, 10, 12, 10, 0, 0).getTime();
const DAY = 86_400_000;

function rec(mediaId: string, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: `s1:${mediaId}`,
    sourceId: 's1',
    mediaId,
    episodeId: null,
    episodeNumber: null,
    title: `片 ${mediaId}`,
    posterUrl: null,
    positionSec: 0,
    durationSec: 3600,
    progress: 0,
    finished: false,
    totalEpisodes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function metaOf(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return { type: 'movie', genres: [], area: null, ...overrides };
}

function build(records: HistoryRecord[], meta = new Map<string, ReportMeta>(), names = new Map<string, string>()) {
  return buildWatchReport({ records, meta, sourceNames: names, now: NOW });
}

describe('estimatedWatchSeconds', () => {
  it('电影未完播按 positionSec，完播按整片时长（完播时 positionSec 已被归零）', () => {
    expect(estimatedWatchSeconds(rec('a', { positionSec: 900, progress: 0.25 }))).toBe(900);
    expect(estimatedWatchSeconds(rec('b', { positionSec: 0, progress: 1, finished: true }))).toBe(3600);
  });

  it('剧集第 N 集：前 N-1 集按看完算，当前集按进度算', () => {
    expect(
      estimatedWatchSeconds(rec('a', { episodeNumber: 5, durationSec: 1800, positionSec: 600 })),
    ).toBe(4 * 1800 + 600);
    expect(
      estimatedWatchSeconds(
        rec('b', { episodeNumber: 5, durationSec: 1800, positionSec: 0, finished: true }),
      ),
    ).toBe(5 * 1800);
  });

  it('第 1 集不做乘法，等同于单片', () => {
    expect(estimatedWatchSeconds(rec('a', { episodeNumber: 1, durationSec: 1800, positionSec: 300 }))).toBe(300);
  });

  it('日期型集号（20240101）不参与乘法，否则估出几千小时', () => {
    expect(
      estimatedWatchSeconds(rec('a', { episodeNumber: 20_240_101, durationSec: 1800, positionSec: 300 })),
    ).toBe(300);
  });

  it('集号超过总集数时按总集数封顶', () => {
    expect(
      estimatedWatchSeconds(
        rec('a', { episodeNumber: 30, totalEpisodes: 12, durationSec: 1800, positionSec: 0 }),
      ),
    ).toBe(11 * 1800);
  });

  it('时长非法或为 0 时返回 0；positionSec 超过时长被钳制', () => {
    expect(estimatedWatchSeconds(rec('a', { durationSec: 0, positionSec: 100 }))).toBe(0);
    expect(estimatedWatchSeconds(rec('b', { durationSec: Number.NaN, positionSec: 100 }))).toBe(0);
    expect(estimatedWatchSeconds(rec('c', { durationSec: 600, positionSec: 9999 }))).toBe(600);
  });
});

describe('buildWatchReport 汇总', () => {
  it('空输入返回全 0，但月份窗口仍补齐 6 个空桶', () => {
    const report = build([]);
    expect(report.totalRecords).toBe(0);
    expect(report.completionRate).toBe(0);
    expect(report.estimatedSeconds).toBe(0);
    expect(report.spanDays).toBe(0);
    expect(report.currentStreakDays).toBe(0);
    expect(report.topTitle).toBeNull();
    expect(report.months).toHaveLength(REPORT_MONTH_WINDOW);
    expect(report.months.every((m) => m.count === 0)).toBe(true);
  });

  it('完播率 = 完播条数 / 总条数', () => {
    const report = build([
      rec('a', { finished: true, progress: 1 }),
      rec('b', { finished: true, progress: 1 }),
      rec('c', { positionSec: 600, progress: 0.16 }),
    ]);
    expect(report.totalRecords).toBe(3);
    expect(report.finishedCount).toBe(2);
    expect(report.completionRate).toBeCloseTo(2 / 3, 5);
    expect(report.estimatedSeconds).toBe(3600 + 3600 + 600);
  });

  it('投入最多的一部取估算时长最大者', () => {
    const report = build([
      rec('short', { durationSec: 1800, positionSec: 1800, finished: true }),
      rec('long', { durationSec: 1800, episodeNumber: 6, finished: true }),
    ]);
    expect(report.topTitle?.mediaId).toBe('long');
    expect(report.topTitle?.seconds).toBe(6 * 1800);
  });

  it('跨度用 createdAt（首次观看），不是最后一次观看', () => {
    const report = build([
      rec('a', { createdAt: NOW - 9 * DAY, updatedAt: NOW }),
      rec('b', { createdAt: NOW - 2 * DAY, updatedAt: NOW - DAY }),
    ]);
    expect(report.spanDays).toBe(10);
  });
});

describe('活跃日与连续天数', () => {
  it('连续三天 + 一个断档日：活跃 4 天，最长与当前连胜都是 3', () => {
    const report = build([
      rec('a', { updatedAt: NOW }),
      rec('b', { updatedAt: NOW - DAY }),
      rec('c', { updatedAt: NOW - 2 * DAY }),
      rec('d', { updatedAt: NOW - 5 * DAY }),
    ]);
    expect(report.activeDays).toBe(4);
    expect(report.bestStreakDays).toBe(3);
    expect(report.currentStreakDays).toBe(3);
  });

  it('同一天多条只算一个活跃日', () => {
    const report = build([
      rec('a', { updatedAt: NOW }),
      rec('b', { updatedAt: NOW - 3600_000 }),
    ]);
    expect(report.activeDays).toBe(1);
    expect(report.bestStreakDays).toBe(1);
  });

  it('最近一次在昨天仍算连胜，前天则连胜归零但保留最长记录', () => {
    const yesterday = build([rec('a', { updatedAt: NOW - DAY }), rec('b', { updatedAt: NOW - 2 * DAY })]);
    expect(yesterday.currentStreakDays).toBe(2);

    const stale = build([rec('a', { updatedAt: NOW - 3 * DAY }), rec('b', { updatedAt: NOW - 4 * DAY })]);
    expect(stale.currentStreakDays).toBe(0);
    expect(stale.bestStreakDays).toBe(2);
  });
});

describe('月度窗口', () => {
  it('补齐最近 6 个月、由旧到新，窗口外的记录不进图但计入总数', () => {
    const report = build([
      rec('nov', { updatedAt: new Date(2026, 10, 1).getTime() }),
      rec('sep', { updatedAt: new Date(2026, 8, 15).getTime() }),
      rec('old', { updatedAt: new Date(2026, 0, 5).getTime() }),
    ]);
    expect(report.months.map((m) => m.key)).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(report.months[0]?.label).toBe('2026/6');
    expect(report.months[5]?.label).toBe('11月');
    expect(report.months[3]?.count).toBe(1);
    expect(report.months[5]?.count).toBe(1);
    expect(report.totalRecords).toBe(3);
  });

  it('跨年时 1 月柱带年份，避免两个「1月」歧义', () => {
    const report = buildWatchReport({
      records: [],
      meta: new Map(),
      sourceNames: new Map(),
      now: new Date(2027, 1, 10).getTime(),
    });
    expect(report.months.map((m) => m.label)).toEqual(['2026/9', '10月', '11月', '12月', '2027/1', '2月']);
  });
});

describe('分组榜单', () => {
  it('片源超过 5 项时合并为「其它源」', () => {
    const records = Array.from({ length: 7 }, (_, i) => rec(`m${i}`, { sourceId: `s${i}` }));
    const names = new Map(Array.from({ length: 7 }, (_, i) => [`s${i}`, `源${i}`]));
    const report = build(records, new Map(), names);
    expect(report.sources).toHaveLength(6);
    expect(report.sources[5]?.key).toBe('__rest');
    expect(report.sources[5]?.label).toBe('其它源');
    expect(report.sources[5]?.count).toBe(2);
    expect(report.sources.reduce((sum, s) => sum + s.count, 0)).toBe(7);
  });

  it('多个已删除的源合并成一行，不出现重复标签', () => {
    const records = [
      rec('a', { sourceId: 'gone-1' }),
      rec('b', { sourceId: 'gone-2' }),
      rec('c', { sourceId: 'alive' }),
    ];
    const report = build(records, new Map(), new Map([['alive', '在世源']]));
    expect(report.sources).toHaveLength(2);
    const removed = report.sources.filter((s) => s.label === '已移除的源');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.key).toBe('__removed');
    expect(removed[0]?.count).toBe(2);
  });

  it('时长口径有独立分母：secondsShare 按秒算，不和部数占比混用', () => {
    const report = build(
      [
        rec('a', { finished: true, durationSec: 3600 }),
        rec('b', { durationSec: 1800, positionSec: 900 }),
      ],
      new Map([
        ['a', metaOf({ genres: ['动作'] })],
        ['b', metaOf({ genres: ['科幻'] })],
      ]),
    );
    const action = report.taste.genre.find((s) => s.key === '动作');
    const scifi = report.taste.genre.find((s) => s.key === '科幻');
    expect(action?.share).toBe(0.5);
    expect(scifi?.share).toBe(0.5);
    expect(action?.secondsShare).toBe(0.8);
    expect(scifi?.secondsShare).toBe(0.2);
  });

  it('题材多归属：分母是「有题材的条数」，动作占比 100%', () => {
    const report = build(
      [rec('a'), rec('b')],
      new Map([
        ['a', metaOf({ genres: ['动作', '科幻'] })],
        ['b', metaOf({ genres: ['动作'] })],
      ]),
    );
    const action = report.taste.genre.find((s) => s.key === '动作');
    const scifi = report.taste.genre.find((s) => s.key === '科幻');
    expect(action?.count).toBe(2);
    expect(action?.share).toBe(1);
    expect(scifi?.count).toBe(1);
    expect(scifi?.share).toBe(0.5);
  });

  it('同一条记录里重复的题材只计一次', () => {
    const report = build([rec('a')], new Map([['a', metaOf({ genres: ['动作', '动作'] })]]));
    expect(report.taste.genre.find((s) => s.key === '动作')?.count).toBe(1);
  });

  it('元数据缺失计入 unknownMetaCount，类型退回历史快照', () => {
    const report = build(
      [rec('a'), rec('b', { mediaSnapshot: { sourceItemId: 'b', type: 'anime', year: null, episodeCount: 12, originalTitle: null } })],
      new Map([['a', metaOf({ type: 'series', area: '内地' })]]),
    );
    expect(report.unknownMetaCount).toBe(1);
    expect(report.taste.type.find((s) => s.key === 'anime')?.count).toBe(1);
    expect(report.taste.type.find((s) => s.key === 'series')?.count).toBe(1);
    expect(report.taste.genre.find((s) => s.key === '__unknown')?.count).toBe(2);
    expect(report.taste.area.find((s) => s.key === '内地')?.count).toBe(1);
    expect(report.taste.area.find((s) => s.key === '__unknown')?.count).toBe(1);
  });

  it('快照也没有类型时归入「未识别」，不凭空造类别', () => {
    const report = build([rec('a')]);
    expect(report.taste.type[0]?.key).toBe('__unknown');
    expect(report.taste.type[0]?.label).toBe('未识别');
  });
});

describe('片单筛选', () => {
  const records = [
    rec('done', { finished: true, progress: 1, updatedAt: NOW }),
    rec('half', { positionSec: 1800, progress: 0.5, updatedAt: NOW }),
    rec('old', { positionSec: 600, progress: 0.16, updatedAt: new Date(2026, 8, 15).getTime() }),
  ];

  it('按月份 + 完播状态组合筛选', () => {
    expect(filterTitles(records, 'all', null)).toHaveLength(3);
    expect(filterTitles(records, 'all', '2026-11')).toHaveLength(2);
    expect(filterTitles(records, 'finished', '2026-11').map((r) => r.mediaId)).toEqual(['done']);
    expect(filterTitles(records, 'watching', null).map((r) => r.mediaId)).toEqual(['half', 'old']);
    expect(filterTitles(records, 'finished', '2026-09').map((r) => r.mediaId)).toEqual([]);
  });

  it('差一点就看完：只取 60%~95% 且未完播，按进度倒序', () => {
    const list = almostFinished([
      rec('low', { progress: 0.4 }),
      rec('p70', { progress: 0.7 }),
      rec('p90', { progress: 0.9 }),
      rec('done', { progress: 1, finished: true }),
    ]);
    expect(list.map((r) => r.mediaId)).toEqual(['p90', 'p70']);
  });
});

describe('分享文案', () => {
  it('带上估算免责说明，且列出偏好题材', () => {
    const report = build([rec('a', { finished: true, progress: 1 })], new Map([['a', metaOf({ genres: ['悬疑'] })]]));
    const text = formatReportText(report, () => '电影');
    expect(text).toContain('PeanutMov 观影报告');
    expect(text).toContain('悬疑');
    expect(text).toContain('非精确统计');
  });
});