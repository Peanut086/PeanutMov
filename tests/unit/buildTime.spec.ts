import { describe, expect, it } from 'vitest';

import { BUILD_TIME } from '@/shared/constants';
import { formatDateStamp } from '@/shared/time';

/**
 * REV-19：构建日期必须来自真实构建时间，不能硬编码
 *
 * 生产构建由 `vite.config.ts` 的 `define: { __BUILD_TIME__ }` 注入 ISO 字符串，
 * `constants.ts` 解析成毫秒时间戳；未注入时为 `null`（AboutView 不展示）。
 * vitest 由 `vitest.config.ts` 注入固定值 `2026-01-01T00:00:00.000Z`。
 */
describe('BUILD_TIME（REV-19）', () => {
  it('解析为合法时间戳（非 null）', () => {
    expect(BUILD_TIME).not.toBeNull();
    expect(Number.isFinite(BUILD_TIME)).toBe(true);
    expect(BUILD_TIME as number).toBeGreaterThan(0);
  });

  it('与 vitest 注入的固定值一致', () => {
    expect(BUILD_TIME).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('经 formatDateStamp 渲染为 YYYY-MM-DD', () => {
    const text = formatDateStamp(BUILD_TIME as number);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(text).toBe('2026-01-01');
  });
});
