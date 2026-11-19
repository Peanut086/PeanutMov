/**
 * 订阅刷新台账单测（P2-1）
 *
 * 覆盖四条口径：
 * - 成功 / 超时 / HTML 伪响应 / 部分同步失败四种输入各留一条正确记录；
 * - 失败不抹掉上一次成功时间，连续失败按 `backoffMsFor` 退避；
 * - TTL 与退避跳过既不算成功也不算失败（`deferred`）；
 * - 记录只在 kv 里，界面读的就是后台写的那一份（重启后显示一致）。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { SUBSCRIPTION_REFRESH_TTL_MS } from '@/shared/constants';
import { importService, listImportRecords, type ImportRecord } from '@/services/importService';
import {
  backoffMsFor,
  describeRefreshOutcome,
  listRefreshOutcomes,
  refreshSummaryText,
  refreshTracked,
  subscriptionLifecycleService,
} from '@/services/subscriptionLifecycleService';
import type { SubscriptionRefreshOutcome } from '@/services/subscriptionLifecycleService';

import { resetAll } from '../unit/helpers';

vi.mock('@/services/importService', () => ({
  importService: { refreshSubscription: vi.fn() },
  listImportRecords: vi.fn(),
}));

const URL_A = 'https://sub.example.com/a.json';
const MINUTE = 60_000;
const FULL_OK = { updated: 5, newCount: 0, jarDead: 0, livesSynced: 2, livesFailed: 0 };

function mockSubscriptions(urls: string[]): void {
  const records: ImportRecord[] = urls.map((url) => ({
    url,
    name: null,
    importedAt: Date.now(),
    success: 1,
  }));
  (listImportRecords as Mock).mockResolvedValue(records);
}

async function ledger(url: string = URL_A): Promise<SubscriptionRefreshOutcome | undefined> {
  return (await listRefreshOutcomes())[url];
}

/** 把台账记录往前推，模拟「隔了一段时间再看这一轮该不该刷」 */
async function ageOutcome(minutes: number, url: string = URL_A): Promise<void> {
  const all = await listRefreshOutcomes();
  const record = all[url];
  if (!record) throw new Error('测试前置：台账里没有这条记录');
  await kvRepo.set('subscription-refresh-outcomes', {
    ...all,
    [url]: { ...record, attemptedAt: record.attemptedAt - minutes * MINUTE },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
  mockSubscriptions([URL_A]);
  (importService.refreshSubscription as Mock).mockResolvedValue(FULL_OK);
});

describe('backoffMsFor', () => {
  it('成功过一次后不再退避，连续失败按 30min/2h/8h 递进，封顶回到 24h', () => {
    expect(backoffMsFor(0)).toBe(0);
    expect(backoffMsFor(1)).toBe(30 * MINUTE);
    expect(backoffMsFor(2)).toBe(2 * 60 * MINUTE);
    expect(backoffMsFor(3)).toBe(8 * 60 * MINUTE);
    expect(backoffMsFor(4)).toBe(SUBSCRIPTION_REFRESH_TTL_MS);
    expect(backoffMsFor(9)).toBe(SUBSCRIPTION_REFRESH_TTL_MS);
  });
});

describe('refreshTracked', () => {
  it('刷新成功：尝试与成功时间同时前进，缺口为空', async () => {
    const result = await refreshTracked(URL_A);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.outcome).toMatchObject({ failReason: null, note: null, failCount: 0 });
    expect(result.outcome.succeededAt).toBe(result.outcome.attemptedAt);
    expect(await ledger()).toEqual(result.outcome);
  });

  it('刷新成功后同步推进 24h 刷新时间（自动链路因此不会重复拉取）', async () => {
    await refreshTracked(URL_A);
    const state = await kvRepo.get<Record<string, number>>('subscription-refresh-state');
    expect(state?.[URL_A]).toBe((await ledger())?.succeededAt);
  });

  it('超时失败：记下原因，连续计数前进，但保留上一次成功时间', async () => {
    const ok = await refreshTracked(URL_A);
    (importService.refreshSubscription as Mock).mockRejectedValueOnce(
      new Error('订阅请求超时（15s）：https://sub.example.com/a.json'),
    );
    const failed = await refreshTracked(URL_A);

    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain('超时');
    expect(failed.outcome.failCount).toBe(1);
    expect(failed.outcome.succeededAt).toBe(ok.outcome.succeededAt);
    expect(failed.counts).toBeNull();
  });

  it('HTML 伪响应也按失败记账，原因原样留一行给用户看', async () => {
    (importService.refreshSubscription as Mock).mockRejectedValueOnce(
      new Error('订阅内容不是 JSON（返回 HTML 页面），可能被网关拦截'),
    );
    const failed = await refreshTracked(URL_A);
    expect(failed.outcome).toMatchObject({
      failCount: 1,
      succeededAt: null,
      note: null,
    });
    expect(failed.outcome.failReason).toContain('HTML 页面');
  });

  it('失败原因过长时截断，不把整段响应体塞进台账', async () => {
    (importService.refreshSubscription as Mock).mockRejectedValueOnce(new Error('E '.repeat(200)));
    const failed = await refreshTracked(URL_A);
    expect((failed.outcome.failReason ?? '').length).toBeLessThanOrEqual(200);
  });

  it('部分同步失败算刷成功，但缺口写进 note（不伪装成全绿）', async () => {
    (importService.refreshSubscription as Mock).mockResolvedValueOnce({
      updated: 3,
      newCount: 2,
      jarDead: 1,
      livesSynced: 4,
      livesFailed: 2,
    });
    const result = await refreshTracked(URL_A);
    expect(result.ok).toBe(true);
    expect(result.outcome.failCount).toBe(0);
    expect(result.outcome.note).toBe('新增 2 条未导入，1 个 jar 已失效未覆盖，2 个直播源同步失败');
  });

  it('连续失败后一次成功即清零，并把失败原因抹掉', async () => {
    (importService.refreshSubscription as Mock).mockRejectedValueOnce(new Error('订阅地址打不开'));
    await refreshTracked(URL_A);
    const recovered = await refreshTracked(URL_A);
    expect(recovered.outcome).toMatchObject({ failCount: 0, failReason: null });
  });
});

describe('maybeAutoRefresh 的发起判定', () => {
  it('24h 内成功过的订阅本轮不发起，计入 deferred 而不是失败', async () => {
    await refreshTracked(URL_A);
    (importService.refreshSubscription as Mock).mockClear();
    const result = await subscriptionLifecycleService.maybeAutoRefresh();
    expect(result).toEqual({ refreshed: 0, failed: 0, deferred: 1 });
    expect(importService.refreshSubscription).not.toHaveBeenCalled();
  });

  it('失败退避期内不重投；到点后自动重试并清零计数', async () => {
    (importService.refreshSubscription as Mock).mockRejectedValue(new Error('订阅地址打不开'));
    expect((await subscriptionLifecycleService.maybeAutoRefresh()).failed).toBe(1);
    expect((await subscriptionLifecycleService.maybeAutoRefresh()).deferred).toBe(1);
    expect(importService.refreshSubscription).toHaveBeenCalledTimes(1);

    // 31 分钟后退避到期（首次失败退 30 分钟）
    await ageOutcome(31);
    expect((await subscriptionLifecycleService.maybeAutoRefresh()).failed).toBe(1);
    expect(importService.refreshSubscription).toHaveBeenCalledTimes(2);
    expect((await ledger())?.failCount).toBe(2);

    (importService.refreshSubscription as Mock).mockResolvedValue(FULL_OK);
    await ageOutcome(3 * 60 + 1); // 第二次失败退 2 小时
    expect((await subscriptionLifecycleService.maybeAutoRefresh()).refreshed).toBe(1);
    expect((await ledger())).toMatchObject({ failCount: 0, failReason: null });
  });

  it('手动刷新（force）无视 TTL 与退避，立即重试单条', async () => {
    (importService.refreshSubscription as Mock).mockRejectedValue(new Error('订阅地址打不开'));
    await subscriptionLifecycleService.maybeAutoRefresh();
    const result = await subscriptionLifecycleService.maybeAutoRefresh(undefined, { force: true });
    expect(result).toEqual({ refreshed: 0, failed: 1, deferred: 0 });
    expect(importService.refreshSubscription).toHaveBeenCalledTimes(2);
  });

  it('没有导入记录时三档全零（不是失败）', async () => {
    (listImportRecords as Mock).mockResolvedValue([]);
    expect(await subscriptionLifecycleService.maybeAutoRefresh()).toEqual({
      refreshed: 0,
      failed: 0,
      deferred: 0,
    });
  });
});

describe('describeRefreshOutcome', () => {
  const HOUR = 60 * MINUTE;

  it('完全成功只说一句成功', () => {
    const now = Date.now();
    expect(
      describeRefreshOutcome(
        { attemptedAt: now - 10 * MINUTE, succeededAt: now - 10 * MINUTE, failReason: null, note: null, failCount: 0 },
        now,
      ),
    ).toEqual({ text: '10 分钟前刷新成功', tone: 'ok' });
  });

  it('超时失败：保留上次成功时间，并给出退避剩余', () => {
    const now = Date.now();
    const { text, tone } = describeRefreshOutcome(
      {
        attemptedAt: now - 10 * MINUTE,
        succeededAt: now - 72 * HOUR,
        failReason: '订阅请求超时（15s）',
        note: null,
        failCount: 2,
      },
      now,
    );
    expect(tone).toBe('bad');
    expect(text).toContain('10 分钟前刷新失败：订阅请求超时（15s）');
    expect(text).toContain('上次成功 3 天前');
    expect(text).toContain('连续 2 次失败，约 2 小时后自动重试');
  });

  it('HTML 伪响应从未成功过：不谎称成功，也不留空', () => {
    const now = Date.now();
    const { text } = describeRefreshOutcome(
      {
        attemptedAt: now - 20 * MINUTE,
        succeededAt: null,
        failReason: '订阅内容不是 JSON（返回 HTML 页面）',
        note: null,
        failCount: 1,
      },
      now,
    );
    expect(text).toBe('20 分钟前刷新失败：订阅内容不是 JSON（返回 HTML 页面）（连续 1 次失败，约 10 分钟后自动重试）');
  });

  it('退避到期后不再报剩余时间（此刻已经该重试了）', () => {
    const now = Date.now();
    expect(
      describeRefreshOutcome(
        {
          attemptedAt: now - 40 * MINUTE,
          succeededAt: null,
          failReason: '订阅地址打不开',
          note: null,
          failCount: 1,
        },
        now,
      ).text,
    ).toBe('40 分钟前刷新失败：订阅地址打不开');
  });

  it('部分同步失败：算成功但把缺口跟着说出来', () => {
    const now = Date.now();
    expect(
      describeRefreshOutcome(
        {
          attemptedAt: now - 5 * MINUTE,
          succeededAt: now - 5 * MINUTE,
          failReason: null,
          note: '新增 3 条未导入，1 个 jar 已失效未覆盖',
          failCount: 0,
        },
        now,
      ),
    ).toEqual({ text: '5 分钟前刷新成功，新增 3 条未导入，1 个 jar 已失效未覆盖', tone: 'warn' });
  });

  it('同一份记录重复推导结果一致（重启后显示不变）', () => {
    const now = Date.now();
    const outcome: SubscriptionRefreshOutcome = {
      attemptedAt: now - 3 * HOUR,
      succeededAt: now - 26 * HOUR,
      failReason: '订阅地址打不开',
      note: null,
      failCount: 1,
    };
    expect(describeRefreshOutcome(outcome, now)).toEqual(describeRefreshOutcome(outcome, now));
  });
});

describe('refreshSummaryText', () => {
  it('把 deferred 说清楚，跳过不被读成失败或成功', () => {
    expect(refreshSummaryText({ refreshed: 0, failed: 0, deferred: 3 })).toEqual({
      tone: 'info',
      text: '已跳过 3 个订阅（24h 内刷过或失败退避中）',
    });
    expect(refreshSummaryText({ refreshed: 0, failed: 0, deferred: 0 })).toEqual({
      tone: 'info',
      text: '没有可刷新的订阅（只支持 URL 导入的订阅）',
    });
    expect(refreshSummaryText({ refreshed: 2, failed: 0, deferred: 1 }).text).toBe(
      '已刷新 2 个订阅，1 个在 24h 或退避中未发起',
    );
    expect(refreshSummaryText({ refreshed: 1, failed: 2, deferred: 0 })).toEqual({
      tone: 'error',
      text: '刷新完成：成功 1，失败 2（原因见对应订阅行，可单条立即重试）',
    });
  });
});

describe('台账读取', () => {
  it('旧版本升级后没有台账键：读成空表，不影响已有刷新时间', async () => {
    await kvRepo.set('subscription-refresh-state', { [URL_A]: Date.now() });
    expect(await listRefreshOutcomes()).toEqual({});
    expect(await subscriptionLifecycleService.summarize()).toEqual([]);
  });
});
