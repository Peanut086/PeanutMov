import { describe, expect, it } from 'vitest';

import {
  CATCHUP_TOKENS,
  baseOfChannelUrl,
  catchupDaysOf,
  clampCatchupDays,
  renderCatchupUrl,
  unknownTokensOf,
  validateCatchupTemplate,
} from '@/shared/catchupTemplate';
import { CATCHUP_MAX_DAYS } from '@/shared/constants';

/**
 * EXT-06 / FR-68 / AC-161：回看地址模板渲染
 * - 12 个白名单 token（9 组语义），不做表达式求值；
 * - `{channel}` / `{channelId}` 走 encodeURIComponent，其余只允许 `[0-9\-.:/]`；
 * - 渲染结果必须能被 `new URL()` 解析且为 http(s)。
 */

const START = new Date(2026, 10, 6, 20, 0, 0).getTime();
const END = new Date(2026, 10, 6, 21, 30, 0).getTime();

const CHANNEL = {
  name: 'CCTV-1 综合',
  tvgId: 'cctv1.hd',
  url: 'https://cdn.example.com/live/cctv1.m3u8',
};

describe('CATCHUP_TOKENS 白名单', () => {
  it('恰为 12 个占位符', () => {
    expect(CATCHUP_TOKENS).toHaveLength(12);
    expect([...CATCHUP_TOKENS]).toEqual([
      'base',
      'channel',
      'tvgId',
      'channelId',
      'date',
      'dateDash',
      'start',
      'end',
      'utc',
      'utcend',
      'startSec',
      'durationSec',
    ]);
  });
});

describe('baseOfChannelUrl', () => {
  it('取频道 URL 的目录部分（去掉文件名与尾部斜杠）', () => {
    expect(baseOfChannelUrl('https://cdn.example.com/live/a.m3u8')).toBe(
      'https://cdn.example.com/live',
    );
    expect(baseOfChannelUrl('https://cdn.example.com/a/b/play.m3u8?token=1')).toBe(
      'https://cdn.example.com/a/b',
    );
    expect(baseOfChannelUrl('https://cdn.example.com/')).toBe('https://cdn.example.com');
    // 非法 URL 返回空串（上层会因渲染结果非法而报 E_INVALID_INPUT）
    expect(baseOfChannelUrl('not a url')).toBe('');
  });
});

describe('renderCatchupUrl（12 token 渲染）', () => {
  it('一次性渲染全部 token，取值口径正确', () => {
    const template =
      '{base}/{channelId}/{dateDash}/{start}/{end}.m3u8' +
      '?date={date}&utc={utc}&utcend={utcend}&sec={startSec}&dur={durationSec}' +
      '&tvg={tvgId}&ch={channel}';
    const { url, tokens } = renderCatchupUrl(template, {
      channel: { ...CHANNEL, tvgId: 'cctv1.hd' },
      programme: { startAt: START, endAt: END },
    });

    expect(tokens).toMatchObject({
      base: 'https://cdn.example.com/live',
      channel: 'CCTV-1 综合',
      tvgId: 'cctv1.hd',
      channelId: 'cctv1.hd',
      date: '20261106',
      dateDash: '2026-11-06',
      start: '20261106200000',
      end: '20261106213000',
      startSec: '0',
      durationSec: '5400',
    });
    expect(tokens.utc).toMatch(/^\d{14}$/);
    expect(tokens.utcend).toMatch(/^\d{14}$/);
    expect(url).toContain('2026-11-06');
    expect(new URL(url).protocol).toBe('https:');
  });

  it('{startSec} 为相对节目起点的偏移秒（P1-03）', () => {
    const template = '{base}/{channelId}?begin={startSec}';

    const fromStart = renderCatchupUrl(template, {
      channel: { ...CHANNEL, tvgId: 'cctv1' },
      programme: { startAt: START, endAt: END },
    });
    expect(fromStart.tokens.startSec).toBe('0');
    expect(fromStart.url).toBe('https://cdn.example.com/live/cctv1?begin=0');

    const mid = renderCatchupUrl(template, {
      channel: { ...CHANNEL, tvgId: 'cctv1' },
      programme: { startAt: START, endAt: END },
      positionAt: START + 10 * 60 * 1000,
    });
    expect(mid.tokens.startSec).toBe('600');
    expect(mid.url).toBe('https://cdn.example.com/live/cctv1?begin=600');

    // 位置早于节目起点 / 非法值 → 回落为 0，不出现负偏移
    const beforeStart = renderCatchupUrl(template, {
      channel: { ...CHANNEL, tvgId: 'cctv1' },
      programme: { startAt: START, endAt: END },
      positionAt: START - 60 * 1000,
    });
    expect(beforeStart.tokens.startSec).toBe('0');

    const invalid = renderCatchupUrl(template, {
      channel: { ...CHANNEL, tvgId: 'cctv1' },
      programme: { startAt: START, endAt: END },
      positionAt: Number.NaN,
    });
    expect(invalid.tokens.startSec).toBe('0');
  });

  it('AC-163 四类样本：查询参数式 / 路径式 / 秒偏移式 / catchup-source，均无残留占位符', () => {
    const ctx = { channel: { ...CHANNEL, tvgId: 'cctv1' }, programme: { startAt: START, endAt: END } };

    const query = renderCatchupUrl('{base}/{channelId}.m3u8?start={start}&end={end}', ctx);
    expect(query.url).toBe(
      'https://cdn.example.com/live/cctv1.m3u8?start=20261106200000&end=20261106213000',
    );

    const path = renderCatchupUrl('{base}/timeshift/{channelId}/{dateDash}/{start}/index.m3u8', ctx);
    expect(path.url).toBe(
      'https://cdn.example.com/live/timeshift/cctv1/2026-11-06/20261106200000/index.m3u8',
    );

    const offset = renderCatchupUrl('{base}/stream/{channelId}?begin={startSec}&dur={durationSec}', ctx);
    expect(offset.url).toBe('https://cdn.example.com/live/stream/cctv1?begin=0&dur=5400');

    const catchupSource = renderCatchupUrl('{base}/catchup/{tvgId}/{utc}-{utcend}.m3u8', ctx);
    expect(catchupSource.url).toMatch(
      /^https:\/\/cdn\.example\.com\/live\/catchup\/cctv1\/\d{14}-\d{14}\.m3u8$/,
    );

    for (const rendered of [query, path, offset, catchupSource]) {
      expect(rendered.url.includes('{')).toBe(false);
      expect(() => new URL(rendered.url)).not.toThrow();
    }
  });

  it('中文频道名与空格经 encodeURIComponent（不破坏 URL 结构）', () => {
    const { url, tokens } = renderCatchupUrl(
      'https://hls.example.com/{channel}/index.m3u8',
      {
        channel: { name: 'CCTV 5+ 体育', tvgId: null, url: 'https://hls.example.com/live/a.m3u8' },
        programme: { startAt: START, endAt: END },
      },
    );
    expect(tokens.channel).toBe('CCTV 5+ 体育');
    expect(url).toBe(`https://hls.example.com/${encodeURIComponent('CCTV 5+ 体育')}/index.m3u8`);
    expect(new URL(url).pathname).not.toContain(' ');
  });

  it('无 tvg-id 时 channelId 回落到归一化频道名', () => {
    const { tokens } = renderCatchupUrl('https://hls.example.com/{channelId}', {
      channel: { name: 'CCTV-1 综合', tvgId: null, url: 'https://hls.example.com/a.m3u8' },
      programme: { startAt: START, endAt: END },
    });
    expect(tokens.channelId).toBe('cctv1');
  });

  it('四种常见方言模板都能渲染（路径 / 查询串 / 时间戳 / utc）', () => {
    const dialects = [
      'https://a.example.com/timeshift/{channel}/{date}/{start}/index.m3u8',
      'https://a.example.com/playback?channel={channelId}&starttime={start}&endtime={end}',
      'https://a.example.com/{channelId}/{dateDash}?playseek={start}-{end}',
      'https://a.example.com/pl/{channel}/utc/{utc}/{utcend}/d/{durationSec}.m3u8',
    ];
    for (const template of dialects) {
      const { url } = renderCatchupUrl(template, {
        channel: CHANNEL,
        programme: { startAt: START, endAt: END },
      });
      expect(() => new URL(url)).not.toThrow();
      expect(url.includes('{')).toBe(false);
    }
  });

  it('未知占位符报 E_INVALID_INPUT', () => {
    expect(() =>
      renderCatchupUrl('https://a.example.com/{channel}/{unknown}', {
        channel: CHANNEL,
        programme: { startAt: START, endAt: END },
      }),
    ).toThrowError(/未知占位符/);
  });

  it('空模板报 E_INVALID_INPUT', () => {
    expect(() =>
      renderCatchupUrl('   ', { channel: CHANNEL, programme: { startAt: START, endAt: END } }),
    ).toThrowError(/模板为空/);
  });

  it('渲染结果不是 http(s) 时报 E_INVALID_INPUT（防拼错协议）', () => {
    expect(() =>
      renderCatchupUrl('ftp://a.example.com/{date}', {
        channel: CHANNEL,
        programme: { startAt: START, endAt: END },
      }),
    ).toThrowError(/无法解析|http/);
  });

  it('异常数据（tvg-id 含非法字符）不会拼出脏地址', () => {
    expect(() =>
      renderCatchupUrl('https://a.example.com/{tvgId}/index.m3u8', {
        channel: { name: 'X', tvgId: 'a b?c', url: 'https://a.example.com/x.m3u8' },
        programme: { startAt: START, endAt: END },
      }),
    ).toThrowError(/非法字符/);
  });

  it('节目时长为 0 / 倒挂时不为负（异常数据兜底）', () => {
    const { tokens } = renderCatchupUrl('https://a.example.com/{durationSec}', {
      channel: CHANNEL,
      programme: { startAt: END, endAt: START },
    });
    expect(tokens.durationSec).toBe('0');
  });
});

describe('unknownTokensOf / validateCatchupTemplate', () => {
  it('列出不在白名单的占位符（去重、保持出现顺序）', () => {
    expect(unknownTokensOf('{foo}/{bar}/{foo}')).toEqual(['foo', 'bar']);
    expect(unknownTokensOf('{channel}/{date}')).toEqual([]);
    expect(unknownTokensOf('')).toEqual([]);
  });

  it('合法模板返回 null；非法返回可直接展示的文案', () => {
    expect(validateCatchupTemplate('https://a.example.com/{channel}/{date}')).toBeNull();
    expect(validateCatchupTemplate('')).toBe('回看模板不能为空');
    expect(validateCatchupTemplate('/relative/{date}')).toContain('http(s)');
    expect(validateCatchupTemplate('https://a.example.com/{nope}')).toContain('{nope}');
  });
});

describe('clampCatchupDays / catchupDaysOf（Q-17 缺省 1、上限 7）', () => {
  it('缺省与非数值回落 1 天', () => {
    expect(clampCatchupDays(undefined)).toBe(1);
    expect(clampCatchupDays(null)).toBe(1);
    expect(clampCatchupDays(Number.NaN)).toBe(1);
    expect(clampCatchupDays(0)).toBe(1);
    expect(clampCatchupDays(-3)).toBe(1);
  });

  it('上限 7 天，取整', () => {
    expect(CATCHUP_MAX_DAYS).toBe(7);
    expect(clampCatchupDays(3)).toBe(3);
    expect(clampCatchupDays(7)).toBe(7);
    expect(clampCatchupDays(99)).toBe(7);
    expect(clampCatchupDays(3.9)).toBe(3);
  });

  it('catchupDaysOf 解析 m3u 属性值，非法返回 null', () => {
    expect(catchupDaysOf('3')).toBe(3);
    expect(catchupDaysOf(' 7 ')).toBe(7);
    expect(catchupDaysOf('30')).toBe(7);
    expect(catchupDaysOf('0')).toBeNull();
    expect(catchupDaysOf('abc')).toBeNull();
    expect(catchupDaysOf('')).toBeNull();
    expect(catchupDaysOf(null)).toBeNull();
  });
});
