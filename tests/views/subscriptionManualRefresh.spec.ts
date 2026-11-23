/**
 * P0-3：订阅管理页「立即刷新」的语义与口径
 *
 * 钉住四件事，缺一条用户就会把"没刷"读成"刷过了"：
 * 1. 手动刷新不受 24h TTL 与失败退避约束——即使台账里刚记了 2 次失败，点下去照样发请求；
 * 2. 手动与自动共用 `refreshTracked`，所以刷成功即清零退避、台账时间推进，界面下一行就是新记录；
 * 3. 直播源没同步上不算全绿：走 info，并把缺口写进文案与台账 note；
 * 4. 文件名形态的订阅（`subscriptionId` 非 URL）不可刷新，按钮直接禁用。
 *
 * 这里只 mock 到 `importService` 一层：链路 UI → `refreshTracked` → 台账落盘全部是真的，
 * 所以断言过的口径与后台自动刷新看到的是同一份数据。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  url: 'https://sub.example.com/a.json',
  refreshSubscription: vi.fn(),
  listImportRecords: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/services/importService', () => ({
  importService: { refreshSubscription: mocks.refreshSubscription },
  listImportRecords: mocks.listImportRecords,
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => mocks.toast }));

import SubscriptionListView from '@/views/SubscriptionListView.vue';
import { kvRepo } from '@/db/repositories/kvRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import type { Source } from '@/types';

import { resetAll } from '../unit/helpers';

const URL_A = mocks.url;
const HOUR = 3_600_000;

type RefreshCounts = {
  updated: number;
  newCount: number;
  jarDead: number;
  livesSynced: number;
  livesFailed: number;
};

function makeSource(subscriptionId: string): Source {
  const now = Date.now();
  return {
    id: 'sub-source',
    key: 'sub-source',
    name: '订阅源',
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: 'https://sub.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    autoDisabledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function mountView(subscriptionId = URL_A): Promise<VueWrapper> {
  await sourceRepo.save(makeSource(subscriptionId));
  mocks.listImportRecords.mockResolvedValue([
    { url: subscriptionId, name: null, importedAt: Date.now(), success: 1 },
  ]);
  setActivePinia(createPinia());
  const wrapper = mount(SubscriptionListView);
  await settle();
  return wrapper;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function rowButton(wrapper: VueWrapper) {
  return wrapper.get('.subs-row__actions button');
}

async function readOutcome(): Promise<Record<string, unknown> | null> {
  return kvRepo.get<Record<string, unknown>>('subscription-refresh-outcomes');
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
});

describe('手动刷新语义（P0-3）', () => {
  it('按钮文案是「立即刷新」，TTL 与退避都拦不住它', async () => {
    const now = Date.now();
    // 刚在 24h 内刷过 + 连续 2 次失败退避中：自动链路这两个条件都会跳过
    await kvRepo.set('subscription-refresh-state', { [URL_A]: now - 60_000 });
    await kvRepo.set('subscription-refresh-outcomes', {
      [URL_A]: {
        attemptedAt: now - 60_000,
        succeededAt: now - 24 * HOUR,
        failReason: '订阅地址打不开（HTTP 500）',
        note: null,
        failCount: 2,
      },
    });
    mocks.refreshSubscription.mockResolvedValue({
      updated: 3,
      newCount: 0,
      jarDead: 0,
      livesSynced: 0,
      livesFailed: 0,
    } satisfies RefreshCounts);
    const wrapper = await mountView();
    expect(rowButton(wrapper).text().replace(/\s+/g, ' ').trim()).toBe('立即刷新');
    expect(rowButton(wrapper).attributes('title')).toContain('不受 24h 与退避限制');

    await rowButton(wrapper).trigger('click');
    await settle();

    expect(mocks.refreshSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSubscription).toHaveBeenCalledWith(URL_A);
    // 成功即清零退避：台账改写成"刚刚成功"，24h 计时同步前移
    const outcome = (await readOutcome())?.[URL_A] as Record<string, unknown>;
    expect(outcome.failCount).toBe(0);
    expect(outcome.failReason).toBeNull();
    expect(Number(outcome.succeededAt)).toBeGreaterThan(now - 5_000);
    const state = (await kvRepo.get<Record<string, number>>('subscription-refresh-state'))![URL_A]!;
    expect(state).toBeGreaterThan(now - 5_000);
    // 界面下一行读到的就是新台账，且提示用短名而不是整条 URL
    expect(wrapper.get('.subs-row__outcome').text()).toContain('刷新成功');
    expect(mocks.toast.success).toHaveBeenCalledWith('「sub.example.com」已刷新：覆盖 3 个源');
  });

  it('直播源没同步上：用 info 说成绩，缺口同时留在文案与台账 note 里', async () => {
    mocks.refreshSubscription.mockResolvedValue({
      updated: 1,
      newCount: 0,
      jarDead: 0,
      livesSynced: 4,
      livesFailed: 2,
    } satisfies RefreshCounts);
    const wrapper = await mountView();
    await rowButton(wrapper).trigger('click');
    await settle();

    expect(mocks.toast.info).toHaveBeenCalledWith('「sub.example.com」已刷新：覆盖 1 个源，2 个直播源同步失败');
    expect(mocks.toast.success).not.toHaveBeenCalled();
    const outcome = (await readOutcome())?.[URL_A] as { note: string | null };
    expect(outcome.note).toBe('2 个直播源同步失败');
    expect(wrapper.get('.subs-row__outcome').classes()).toContain('subs-row__outcome--warn');
  });

  it('刷新失败：error 提示带原因，台账记成失败档且保留上次成功时间', async () => {
    const now = Date.now();
    await kvRepo.set('subscription-refresh-outcomes', {
      [URL_A]: {
        attemptedAt: now - 2 * HOUR,
        succeededAt: now - 3 * 24 * HOUR,
        failReason: null,
        note: null,
        failCount: 0,
      },
    });
    mocks.refreshSubscription.mockRejectedValue(new Error('订阅地址打不开（HTTP 404）'));
    const wrapper = await mountView();
    await rowButton(wrapper).trigger('click');
    await settle();

    expect(mocks.toast.error).toHaveBeenCalledWith('「sub.example.com」刷新失败：订阅地址打不开（HTTP 404）');
    const outcome = (await readOutcome())?.[URL_A] as Record<string, unknown>;
    expect(outcome.failCount).toBe(1);
    expect(outcome.failReason).toBe('订阅地址打不开（HTTP 404）');
    // 一次抖动不把有效订阅读成坏了：上次成功时间仍然留着
    expect(Number(outcome.succeededAt)).toBe(now - 3 * 24 * HOUR);
    expect(wrapper.get('.subs-row__outcome').classes()).toContain('subs-row__outcome--bad');
    expect(wrapper.get('.subs-row__outcome').text()).toContain('刷新失败：订阅地址打不开（HTTP 404）');
  });

  it('文件名导入的订阅不可刷新：按钮禁用，也不发请求', async () => {
    const wrapper = await mountView('我的订阅.json');
    const button = rowButton(wrapper);
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('title')).toContain('文件导入的订阅不可刷新');
    await button.trigger('click');
    await settle();
    expect(mocks.refreshSubscription).not.toHaveBeenCalled();
  });
});
