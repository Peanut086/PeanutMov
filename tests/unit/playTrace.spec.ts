/**
 * 播放决策链诊断包单测（OPT-26 / P2-⑬）
 *
 * 盯的是三件容易做错的事：
 * - 窗口归并口径：兜底换线/重解析必须续写同一条链，换集才开新窗口（否则「为什么播不了」
 *   的前半段被后一次 `resolveAndLoad` 抹掉）；
 * - 日志捞取口径：W/E 全收、决策链 info 行按前缀白名单收，窗口外一行都不要；
 * - 交出去的形态：地址只留 host，且分享不可用时要退到剪贴板而不是报错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buffer = vi.hoisted(() => ({ entries: [] as Array<{ id: string; level: string; tag: string; message: string; ts: number }> }));

vi.mock('@/shared/logBus', () => ({
  getBuffer: () => buffer.entries.map((e) => ({ ...e })) as never,
}));

vi.mock('@/shared/platform', () => ({
  isNative: vi.fn(() => true),
}));

const share = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined));
vi.mock('@capacitor/share', () => ({ Share: { share: (input: unknown) => share(input) } }));

import { isNative } from '@/shared/platform';

import {
  collectTraceLogLines,
  formatPlayTraceText,
  playTraceService,
  sharePlayTraceText,
} from '@/services/playTraceService';

const TARGET = {
  mediaId: 'src~item-1',
  title: '士兵突击',
  episodeNumber: 10,
  episodeId: 'ep-10',
  lineId: 'l0',
  lineName: '半日App',
};

function entry(level: string, tag: string, message: string, ts: number) {
  return { id: `${ts}`, level, tag, message, ts };
}

beforeEach(() => {
  playTraceService.__reset();
  buffer.entries = [];
  share.mockClear();
  vi.mocked(isNative).mockReturnValue(true);
});

describe('决策链窗口', () => {
  it('换线/重解析续写同一条链，换集才清空并开新窗口', () => {
    expect(playTraceService.beginAttempt(TARGET)).toBe(true);
    playTraceService.note('resolve', '回源取址成功', { elapsedMs: 1200 });

    // 兜底换了线路：同条目同集号 = 同一次决策
    expect(playTraceService.beginAttempt({ ...TARGET, lineId: 'l1', lineName: 'X途' })).toBe(false);
    playTraceService.note('failover', '换线尝试 → X途');
    expect(playTraceService.eventsOf().map((e) => e.text)).toEqual(['回源取址成功', '换线尝试 → X途']);
    // 线路读数按最新一次为准（漂移的 id 不能停在旧线路上）
    expect(playTraceService.targetOf()).toMatchObject({ lineId: 'l1', lineName: 'X途' });

    expect(playTraceService.beginAttempt({ ...TARGET, episodeId: 'ep-11', episodeNumber: 11 })).toBe(true);
    expect(playTraceService.eventsOf()).toEqual([]);
  });

  it('没有起播过就不记事件（探测与后台动作不能凭空造出一条链）', () => {
    playTraceService.note('resolve', '不该存在的事件');
    expect(playTraceService.eventsOf()).toEqual([]);
    expect(playTraceService.windowStartedAt()).toBe(0);
  });

  it('事件上限 120 条：留最近的一段，早先的按插入顺序淘汰', () => {
    playTraceService.beginAttempt(TARGET);
    for (let i = 0; i < 130; i += 1) playTraceService.note('resolve', `第 ${i} 条`);
    const events = playTraceService.eventsOf();
    expect(events).toHaveLength(120);
    expect(events[0]!.text).toBe('第 10 条');
    expect(events[119]!.text).toBe('第 129 条');
  });

  it('超长字段值截断：诊断包是给人读的，不能变成日志转储', () => {
    playTraceService.beginAttempt(TARGET);
    playTraceService.note('error', '引擎报错：E_NETWORK', { detail: 'x'.repeat(400) });
    const fields = playTraceService.eventsOf()[0]!.fields!;
    expect(String(fields.detail).length).toBeLessThanOrEqual(170);
    expect(String(fields.detail)).toContain('已截断');
  });

  it('buildReport 给出窗口跨度，readings 缺省时按窗口时间现捞日志', () => {
    playTraceService.beginAttempt(TARGET);
    const start = playTraceService.windowStartedAt();
    buffer.entries = [entry('W', 'player', '在线流停滞，交由播放页重新取址', start)];
    const report = playTraceService.buildReport({ now: start + 5_000 });
    expect(report.windowMs).toBe(5_000);
    expect(report.logLines).toHaveLength(1);
    expect(report.logLines[0]).toContain('在线流停滞');
  });
});

describe('日志捞取', () => {
  it('W/E 全收，info 只收决策链前缀，窗口外一行不留', () => {
    playTraceService.beginAttempt(TARGET);
    const start = playTraceService.windowStartedAt();
    buffer.entries = [
      entry('W', 'player', '引擎回退：原生 → hls', start + 10),
      entry('E', 'app', '爬虫构件抛错', start + 20),
      entry('I', 'library', '兜底链：换线候选', start + 30),
      entry('I', 'library', '播放地址超出学到的可用寿命，重新解析', start + 40),
      entry('I', 'danmaku', '弹幕源耗时', start + 50),
      entry('I', 'ui', '与本次无关的一行', start + 60),
      entry('D', 'ui', 'debug 一律不收', start + 70),
      entry('W', 'player', '窗口开始之前的事', start - 10),
    ];
    const lines = collectTraceLogLines(start);
    expect(lines.map((l) => l.split('] ')[1])).toEqual([
      '引擎回退：原生 → hls',
      '爬虫构件抛错',
      '兜底链：换线候选',
      '播放地址超出学到的可用寿命，重新解析',
      '弹幕源耗时',
    ]);
  });

  it('没有窗口起点时不捞（避免把整段缓冲当成一次起播）', () => {
    buffer.entries = [entry('W', 'player', '停滞', Date.now())];
    expect(collectTraceLogLines(0)).toEqual([]);
  });

  it('条数上限生效，消息里的 token 再脱敏一次', () => {
    buffer.entries = Array.from({ length: 200 }, (_unused, i) =>
      entry('W', 'player', `第 ${i} 条`, Date.now() + i),
    );
    expect(collectTraceLogLines(Date.now() - 1, 30)).toHaveLength(30);
    buffer.entries = [entry('W', 'spider', '取址 https://cdn.example.com/1.m3u8?sign=abcdef123456', Date.now())];
    expect(collectTraceLogLines(Date.now() - 1)[0]).toContain('sign=***');
  });
});

describe('文本形态', () => {
  it('目标、读数、链路、日志四段齐全，链路带窗口内偏移', () => {
    playTraceService.beginAttempt(TARGET);
    const start = playTraceService.windowStartedAt();
    playTraceService.note('attempt', '用户点播本集', { line: '半日App' });
    playTraceService.note('resolve', '回源失败：E_SOURCE_BUSY', { busyKind: 'queue' });
    const text = formatPlayTraceText(
      playTraceService.buildReport({
        readings: { 引擎: 'hls', 位置: '12s / 2400s', 该host的地址寿命: null },
        logLines: ['2026-11-23 14:00:00.000 W [player] 引擎回退'],
        now: start + 250,
      }),
    );
    expect(text).toContain('播放诊断（决策链）v1');
    expect(text).toContain('士兵突击｜第 10 集｜线路「半日App」');
    expect(text).toContain('位置: 12s / 2400s');
    expect(text).toContain('该host的地址寿命: N/A');
    expect(text).toContain('attempt｜用户点播本集');
    // 链路每行都带「距窗口起点多少毫秒」：同一次起播里的事件按这个轴对齐
    expect(text).toMatch(/\+0ms\s+attempt｜用户点播本集/);
    expect(text).toContain('line=半日App');
    expect(text).toContain('resolve｜回源失败：E_SOURCE_BUSY');
    expect(text).toContain('busyKind=queue');
    expect(text).toContain('引擎回退');
    expect(text).toContain('host 与路径保留原样');
  });

  it('还没起播过时给出明确空态，而不是空白页', () => {
    const text = formatPlayTraceText(playTraceService.buildReport({ now: Date.now() }));
    expect(text).toContain('本次会话还没有起播过');
    expect(text).toContain('（没有记录到决策事件）');
    expect(text).toContain('（无 W/E 或决策链 info 行）');
  });
});

describe('交出去', () => {
  it('原生走分享面板', async () => {
    expect(await sharePlayTraceText('文本')).toBe('shared');
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ text: '文本' }));
  });

  it('分享不可用退到剪贴板（用户取消分享面板不是故障）', async () => {
    share.mockRejectedValueOnce(new Error('User cancelled the action.'));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    expect(await sharePlayTraceText('文本')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('文本');
  });

  it('非原生环境直接复制；两条都不成才报失败', async () => {
    vi.mocked(isNative).mockReturnValue(false);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    expect(await sharePlayTraceText('文本')).toBe('copied');
    expect(share).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    expect(await sharePlayTraceText('文本')).toBe('failed');
  });
});
