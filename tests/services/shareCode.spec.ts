/**
 * 观影口令单测（SHARE-CODE）
 *
 * 覆盖：编解码回环（中文/集号/时间点）、缺省字段、越界钳制、
 * 脏输入永不抛错、分享文案可回读、时钟格式。
 * 解码入口面对的是外部剪贴板——不可信输入是主用例，不是边角。
 */
import { describe, expect, it } from 'vitest';

import {
  buildShareText,
  decodeShareCode,
  encodeShareCode,
  formatClock,
  looksLikeShareCode,
} from '@/services/shareCodeService';

function rawCode(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#PeanutMov1.${b64}#`;
}

describe('encodeShareCode / decodeShareCode', () => {
  it('中文片名/集号/时间点回环一致', () => {
    const code = encodeShareCode({ title: '庆余年 第二季', year: 2024, episodeNumber: 5, positionSec: 312 });
    expect(looksLikeShareCode(`朋友发来的一段话：${code} 快去看`)).toBe(true);
    expect(decodeShareCode(code)).toEqual({
      version: 1,
      title: '庆余年 第二季',
      year: 2024,
      episodeNumber: 5,
      positionSec: 312,
    });
  });

  it('电影（无集号、位置 0）解码后对应字段为 null', () => {
    const code = encodeShareCode({ title: '流浪地球2', year: 2023, episodeNumber: null, positionSec: 0 });
    expect(decodeShareCode(code)).toMatchObject({
      title: '流浪地球2',
      year: 2023,
      episodeNumber: null,
      positionSec: null,
    });
  });

  it('越界值逐项作废，合法字段照常解出', () => {
    const decoded = decodeShareCode(rawCode({ t: 'x'.repeat(200), y: 1800, e: 9_999_999, s: 99_999_999, odd: '?' }));
    expect(decoded).not.toBeNull();
    expect(decoded!.title).toHaveLength(120);
    expect(decoded!.year).toBeNull();
    expect(decoded!.episodeNumber).toBeNull();
    expect(decoded!.positionSec).toBeNull();
  });

  it('脏输入永不抛错（剪贴板是不可信源）', () => {
    const junk = [
      '',
      '普通搜索词',
      'PeanutMov1.nonsense',
      '#PeanutMov0.AAAA#',
      '#PeanutMov2.AAAA#',
      '#PeanutMov1.@@@非法base64@@@#',
      '#PeanutMov1.' + btoa('[1,2,3]').replace(/\+/g, '-').replace(/\//g, '_') + '#',
      '#PeanutMov1.' + btoa('{"t":"   "}').replace(/\+/g, '-').replace(/\//g, '_') + '#',
      '#PeanutMov1.' + btoa('not json at all') + '#',
    ];
    for (const text of junk) {
      expect(decodeShareCode(text)).toBeNull();
    }
  });

  it('looksLikeShareCode 只认合法形态，普通片名不误判', () => {
    expect(looksLikeShareCode('流浪地球2')).toBe(false);
    expect(looksLikeShareCode('我在 PeanutMov 看《三体》')).toBe(false);
    expect(looksLikeShareCode(encodeShareCode({ title: '三体', year: null, episodeNumber: null, positionSec: 10 }))).toBe(true);
  });
});

describe('buildShareText / formatClock', () => {
  it('分享文案里内嵌口令可被对方整段回读', () => {
    const text = buildShareText({ title: '流浪地球2', year: 2023, episodeNumber: null, positionSec: 45 });
    expect(text).toContain('《流浪地球2》');
    expect(text).toContain('0:45');
    expect(decodeShareCode(text)?.year).toBe(2023);
  });

  it('集号与时间点都会写进文案', () => {
    const text = buildShareText({ title: '庆余年', year: 2024, episodeNumber: 7, positionSec: 3725 });
    expect(text).toContain('第7集');
    expect(text).toContain('1:02:05');
  });

  it('时钟格式：分秒补零、跨小时补时位', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(45)).toBe('0:45');
    expect(formatClock(3125)).toBe('52:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});
