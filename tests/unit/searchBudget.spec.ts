/**
 * OPT-04：可配置的搜索超时预算
 *
 * 覆盖：
 * - `resolveSearchTimeoutMs`：档位倍率、上下限钳制、非法入参回落（任何输入都返回可用毫秒数）
 * - `settings`：默认档位 = standard（既有行为不变）、非法档位回落 standard
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsService } from '@/services/settingsService';
import { kvRepo } from '@/db/repositories/kvRepo';
import {
  KV_KEY_SETTINGS,
  SEARCH_GLOBAL_DEADLINE_MS,
  TIMEOUT_SEARCH_MS,
  TIMEOUT_SEARCH_SITE_MS,
  TIMEOUT_SEARCH_SPIDER_MS,
} from '@/shared/constants';
import {
  SEARCH_BUDGET_DEFAULT,
  SEARCH_BUDGET_LABELS,
  SEARCH_BUDGET_MAX_MS,
  SEARCH_BUDGET_MIN_MS,
  SEARCH_BUDGET_PRESETS,
  SEARCH_BUDGET_SCALE,
  isSearchBudgetPreset,
  resolveGlobalDeadlineMs,
  resolveSearchTimeoutMs,
  SEARCH_GLOBAL_DEADLINE_MIN_MS,
} from '@/shared/searchBudget';
import { resetAll } from './helpers';

describe('isSearchBudgetPreset', () => {
  it('三档合法值', () => {
    for (const preset of SEARCH_BUDGET_PRESETS) expect(isSearchBudgetPreset(preset)).toBe(true);
  });

  it('非法值（含 undefined / 数字 / 大小写错误）一律 false', () => {
    for (const value of [undefined, null, '', 'Standard', 'slow', 1, {}, []]) {
      expect(isSearchBudgetPreset(value)).toBe(false);
    }
  });
});

describe('resolveSearchTimeoutMs（OPT-04 预算可配置）', () => {
  it('standard 倍率 1：站点/爬虫/其它与既有硬编码逐字等价（向后兼容）', () => {
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SITE_MS, 'standard')).toBe(TIMEOUT_SEARCH_SITE_MS);
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, 'standard')).toBe(TIMEOUT_SEARCH_SPIDER_MS);
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_MS, 'standard')).toBe(TIMEOUT_SEARCH_MS);
    // 不传档位 = 不给用户设置过，行为必须与旧版一致
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS)).toBe(TIMEOUT_SEARCH_SPIDER_MS);
  });

  it('fast 收紧、patient 放宽（倍率来自 SEARCH_BUDGET_SCALE）', () => {
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, 'fast')).toBe(
      Math.round(TIMEOUT_SEARCH_SPIDER_MS * SEARCH_BUDGET_SCALE.fast),
    );
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, 'patient')).toBe(
      Math.round(TIMEOUT_SEARCH_SPIDER_MS * SEARCH_BUDGET_SCALE.patient),
    );
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, 'fast')).toBeLessThan(TIMEOUT_SEARCH_SPIDER_MS);
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, 'patient')).toBeGreaterThan(TIMEOUT_SEARCH_MS);
  });

  it('下限 3s：快速档也不会把站点源压到模板请求都跑不完', () => {
    expect(resolveSearchTimeoutMs(1000, 'fast')).toBe(SEARCH_BUDGET_MIN_MS);
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_MS, 'fast')).toBe(SEARCH_BUDGET_MIN_MS);
  });

  it('上限 30s：耐心档不会让长尾源拖住整轮聚合', () => {
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, 'patient')).toBe(SEARCH_BUDGET_MAX_MS);
    expect(resolveSearchTimeoutMs(60000, 'patient')).toBe(SEARCH_BUDGET_MAX_MS);
  });

  it('非法入参回落：base 非正/非数 → 默认 5s；未知档位 → 倍率 1；均不抛错', () => {
    for (const base of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveSearchTimeoutMs(base, 'standard')).toBe(TIMEOUT_SEARCH_MS);
    }
    expect(resolveSearchTimeoutMs(TIMEOUT_SEARCH_SITE_MS, 'bogus' as never)).toBe(TIMEOUT_SEARCH_SITE_MS);
  });

  it('返回整数毫秒（setTimeout 不接受小数）', () => {
    for (const preset of SEARCH_BUDGET_PRESETS) {
      const ms = resolveSearchTimeoutMs(7777, preset);
      expect(Number.isInteger(ms)).toBe(true);
    }
  });

  it('三档文案齐全且互不相同（设置页直接消费）', () => {
    const labels = SEARCH_BUDGET_PRESETS.map((preset) => SEARCH_BUDGET_LABELS[preset]);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('settings.searchBudget（OPT-04 持久化）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  afterEach(() => {
    settingsService.__resetCache();
  });

  it('默认设置带 standard 档（首装行为与旧版一致）', async () => {
    const settings = await settingsService.get();
    expect(settings.searchBudget).toBe(SEARCH_BUDGET_DEFAULT);
    expect(SEARCH_BUDGET_DEFAULT).toBe('standard');
  });

  it('update 可落盘档位，重启后读回', async () => {
    await settingsService.update({ searchBudget: 'patient' });
    settingsService.__resetCache();
    const settings = await settingsService.get();
    expect(settings.searchBudget).toBe('patient');
  });

  it('库里被手改成非法档位时回落 standard（不让搜索卡在非法预算上）', async () => {
    const base = await settingsService.get();
    await kvRepo.set(KV_KEY_SETTINGS, { ...base, searchBudget: 'ultra' });
    settingsService.__resetCache();
    const settings = await settingsService.get();
    expect(settings.searchBudget).toBe('standard');
  });

  it('旧版本设置（没有 searchBudget 字段）补齐为 standard', async () => {
    const base = await settingsService.get();
    const legacy = { ...base } as Record<string, unknown>;
    delete legacy.searchBudget;
    await kvRepo.set(KV_KEY_SETTINGS, legacy);
    settingsService.__resetCache();
    const settings = await settingsService.get();
    expect(settings.searchBudget).toBe('standard');
  });
});

describe('resolveGlobalDeadlineMs（OPT-03：全局截止随档位缩放）', () => {
  it('standard 与既有 28s 逐字等价', () => {
    expect(resolveGlobalDeadlineMs('standard')).toBe(SEARCH_GLOBAL_DEADLINE_MS);
    expect(resolveGlobalDeadlineMs()).toBe(SEARCH_GLOBAL_DEADLINE_MS);
  });

  it('快速收紧 / 耐心放宽，按同一倍率', () => {
    expect(resolveGlobalDeadlineMs('fast')).toBe(Math.round(SEARCH_GLOBAL_DEADLINE_MS * SEARCH_BUDGET_SCALE.fast));
    expect(resolveGlobalDeadlineMs('patient')).toBe(
      Math.round(SEARCH_GLOBAL_DEADLINE_MS * SEARCH_BUDGET_SCALE.patient),
    );
  });

  it('非法档位回落缺省，任何输入都返回可用毫秒数', () => {
    for (const bad of [undefined, '', 'STANDARD', 42, null] as never[]) {
      expect(resolveGlobalDeadlineMs(bad)).toBe(SEARCH_GLOBAL_DEADLINE_MS);
    }
  });

  it('下限保护：不让全局截止低于一轮模板请求的收口时间', () => {
    expect(resolveGlobalDeadlineMs('fast')).toBeGreaterThan(SEARCH_GLOBAL_DEADLINE_MIN_MS);
  });
});
