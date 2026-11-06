import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  hmOf,
  localDateKey,
  localYmd,
  localYmdHms,
  parseXmltvTime,
  secOfLocalDay,
  shiftDateKey,
  startOfLocalDay,
  utcYmdHms,
} from '@/shared/epgTime';

/**
 * EXT-06 / FR-67 / AC-159：EPG 时间口径
 * - 带偏移（`+0800`）→ 绝对时间；不带偏移 → 按设备本地时区解释；
 * - 日期归属一律按设备本地时区（不因服务端时区不同而错日）。
 */

describe('parseXmltvTime（XMLTV / diyp 时间解析）', () => {
  it('带 +0800 偏移换算为绝对时间', () => {
    expect(parseXmltvTime('20261025200000 +0800')).toBe(Date.UTC(2026, 9, 25, 12, 0, 0));
    expect(parseXmltvTime('20261025200000+0800')).toBe(Date.UTC(2026, 9, 25, 12, 0, 0));
    expect(parseXmltvTime('20261025200000 -0530')).toBe(Date.UTC(2026, 9, 26, 1, 30, 0));
  });

  it('不带偏移按设备本地时区解释', () => {
    const parsed = parseXmltvTime('20261025200000');
    expect(parsed).toBe(new Date(2026, 9, 25, 20, 0, 0).getTime());
    // 两种写法指向同一瞬时（一个是绝对偏移，一个是本地解释）时差恒定
    expect(parsed).not.toBeNull();
  });

  it('支持 diyp 的 `2026-10-25 20:00:00` 与 `T` 分隔、缺秒', () => {
    expect(parseXmltvTime('2026-10-25 20:00:00')).toBe(new Date(2026, 9, 25, 20, 0, 0).getTime());
    expect(parseXmltvTime('2026-10-25T20:00')).toBe(new Date(2026, 9, 25, 20, 0, 0).getTime());
    expect(parseXmltvTime('2026-10-25 20:00:59 +0800')).toBe(Date.UTC(2026, 9, 25, 12, 0, 59));
  });

  it('缺秒的紧凑时间按 0 秒处理', () => {
    expect(parseXmltvTime('202610252000')).toBe(new Date(2026, 9, 25, 20, 0, 0).getTime());
  });

  it('无法解析返回 null（异常数据不抛错）', () => {
    expect(parseXmltvTime('')).toBeNull();
    expect(parseXmltvTime(null)).toBeNull();
    expect(parseXmltvTime(undefined)).toBeNull();
    expect(parseXmltvTime('20:00')).toBeNull();
    expect(parseXmltvTime('not-a-time')).toBeNull();
  });
});

describe('本地日期键与格式化', () => {
  const at = new Date(2026, 10, 6, 9, 5, 7);

  it('localDateKey / localYmd / localYmdHms 按设备本地时区', () => {
    expect(localDateKey(at)).toBe('2026-11-06');
    expect(localYmd(at)).toBe('20261106');
    expect(localYmdHms(at)).toBe('20261106090507');
    expect(hmOf(at)).toBe('09:05');
    expect(secOfLocalDay(at)).toBe(9 * 3600 + 5 * 60 + 7);
  });

  it('utcYmdHms 与本地格式口径不同（回看 {utc} 用）', () => {
    expect(utcYmdHms(at)).toBe(
      `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}${String(
        at.getUTCDate(),
      ).padStart(2, '0')}${String(at.getUTCHours()).padStart(2, '0')}${String(
        at.getUTCMinutes(),
      ).padStart(2, '0')}${String(at.getUTCSeconds()).padStart(2, '0')}`,
    );
    expect(utcYmdHms(at)).toHaveLength(14);
  });

  it('localDateKey 月末/年末进位正确（跨天归属）', () => {
    expect(localDateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
    expect(localDateKey(new Date(2027, 0, 1, 0, 0, 0))).toBe('2027-01-01');
  });
});

describe('日边界换算', () => {
  it('startOfLocalDay 归零到当天 0 点', () => {
    const at = new Date(2026, 10, 6, 23, 30, 15);
    expect(startOfLocalDay(at)).toBe(new Date(2026, 10, 6, 0, 0, 0).getTime());
  });

  it('addLocalDays 支持跨月', () => {
    expect(addLocalDays(new Date(2026, 10, 6, 22, 0, 0), 1)).toBe(
      new Date(2026, 10, 7, 0, 0, 0).getTime(),
    );
    expect(addLocalDays(new Date(2026, 10, 30, 12, 0, 0), 2)).toBe(
      new Date(2026, 11, 2, 0, 0, 0).getTime(),
    );
    expect(addLocalDays(new Date(2026, 10, 3, 12, 0, 0), -3)).toBe(
      new Date(2026, 9, 31, 0, 0, 0).getTime(),
    );
  });

  it('shiftDateKey 前后移动并保持 yyyy-MM-dd；非法输入原样返回', () => {
    expect(shiftDateKey('2026-11-06', -1)).toBe('2026-11-05');
    expect(shiftDateKey('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDateKey('bad', 1)).toBe('bad');
  });
});
