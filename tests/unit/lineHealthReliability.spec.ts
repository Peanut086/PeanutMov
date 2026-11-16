import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { lineHealthService, lineKey } from '@/services/lineHealthService';
import type { LineHealthEntry } from '@/services/lineHealthService';

import { resetAll } from './helpers';

/**
 * OPT-16：源级线路可靠度公式
 *
 * 旧实现是 `successCount / (successCount + failStreak)`，而 `failStreak` 在每次成功时被清零
 * ——挂过 5 次终于播通 1 次的线路会得满分，且一辈子不分轻重。现在：
 * 累计 `failCount`（成功不清零）+ 按 `checkedAt` 的 7 天半衰期衰减 + 1:1 伪计数收缩。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 直接铺 kv，再走 init() 读回——避免为了造历史数据去开定时器 */
async function seed(entries: Record<string, Partial<LineHealthEntry>>): Promise<void> {
  lineHealthService.__reset();
  await kvRepo.set('line-health-v1', entries as Record<string, LineHealthEntry>);
  await lineHealthService.init();
}

function fullEntry(overrides: Partial<LineHealthEntry>): Partial<LineHealthEntry> {
  return {
    status: 'ok',
    failStreak: 0,
    failCount: 0,
    successCount: 0,
    lastResolveMs: null,
    lastErrorCode: null,
    checkedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetAll();
  lineHealthService.__reset();
});

describe('线路可靠度（OPT-16）', () => {
  it('无历史数据时保持中性 0.5，新源不被误判', () => {
    expect(lineHealthService.sourceReliability('s-none')).toBe(0.5);
  });

  it('一次成功不再抹掉历史失败：累计 failCount 保留，分数低于中性', () => {
    const key = lineKey('s1', 'item1', '线A');
    lineHealthService.recordFail(key, 'E_PARSE');
    lineHealthService.recordFail(key, 'E_NO_PLAY_URL');
    lineHealthService.recordSuccess(key, 800);

    const entry = lineHealthService.entryOf(key);
    expect(entry?.failStreak).toBe(0);
    expect(entry?.failCount).toBe(2);

    // (1 + 1) / (1 + 2 + 2)
    expect(lineHealthService.sourceReliability('s1')).toBeCloseTo(0.4, 2);
  });

  it('样本很少时向中性收缩，单点噪声不能把源顶到代表位', () => {
    const key = lineKey('s2', 'item1', '线A');
    lineHealthService.recordSuccess(key, 500);
    expect(lineHealthService.sourceReliability('s2')).toBeCloseTo(2 / 3, 2);

    for (let i = 0; i < 30; i += 1) lineHealthService.recordSuccess(key, 500);
    expect(lineHealthService.sourceReliability('s2')).toBeGreaterThan(0.95);
  });

  it('30 天前的同量成功权重明显低于刚发生的（半衰期生效）', async () => {
    await seed({
      [lineKey('sFresh', 'i', '线A')]: fullEntry({ successCount: 10 }),
      [lineKey('sOld', 'i', '线A')]: fullEntry({ successCount: 10, checkedAt: Date.now() - 30 * DAY_MS }),
    });
    const fresh = lineHealthService.sourceReliability('sFresh');
    const old = lineHealthService.sourceReliability('sOld');
    expect(fresh).toBeGreaterThan(0.9);
    expect(old).toBeLessThan(0.7);
    expect(fresh).toBeGreaterThan(old);
  });

  it('存量数据没有 failCount 时按 failStreak 兜底，不当作 0 次失败', async () => {
    const legacy = {
      status: 'fail',
      failStreak: 3,
      successCount: 1,
      lastResolveMs: null,
      lastErrorCode: 'E_PARSE',
      checkedAt: Date.now(),
    } as unknown as LineHealthEntry;
    await seed({ [lineKey('sLegacy', 'i', '线A')]: legacy });
    // (1 + 1) / (1 + 3 + 2)
    expect(lineHealthService.sourceReliability('sLegacy')).toBeCloseTo(1 / 3, 2);
  });

  it('账号/网络类错误不计入线路失败', () => {
    const key = lineKey('s3', 'item1', '线A');
    lineHealthService.recordFail(key, 'E_NETWORK');
    lineHealthService.recordFail(key, 'E_NETDISK_LOGIN_REQUIRED');
    expect(lineHealthService.entryOf(key)).toBeUndefined();
    expect(lineHealthService.sourceReliability('s3')).toBe(0.5);
  });
});
