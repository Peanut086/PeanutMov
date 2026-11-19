/**
 * 订阅管理页的刷新台账行（P2-1）
 *
 * 文案口径由 `describeRefreshOutcome` 单测覆盖，这里只验证界面确实把那一条渲染出来：
 * 有记录就有一行、语气色跟着走、没有记录就不凭空显示，重启前后同一份数据显示一致。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  url: 'https://sub.example.com/a.json',
  listImportRecords: vi.fn(),
  refreshSubscription: vi.fn(),
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/services/importService', () => ({
  importService: { refreshSubscription: mocks.refreshSubscription },
  listImportRecords: mocks.listImportRecords,
}));

import SubscriptionListView from '@/views/SubscriptionListView.vue';
import { kvRepo } from '@/db/repositories/kvRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import type { SubscriptionRefreshOutcome } from '@/services/subscriptionLifecycleService';
import type { Source } from '@/types';

import { resetAll } from '../unit/helpers';

const URL_A = mocks.url;
const MINUTE = 60_000;

function makeSource(): Source {
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
    subscriptionId: URL_A,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    autoDisabledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function seed(outcome: SubscriptionRefreshOutcome | null): Promise<void> {
  await sourceRepo.save(makeSource());
  mocks.listImportRecords.mockResolvedValue([
    { url: URL_A, name: null, importedAt: Date.now(), success: 1 },
  ]);
  if (outcome) await kvRepo.set('subscription-refresh-outcomes', { [URL_A]: outcome });
}

async function mountView(): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const wrapper = mount(SubscriptionListView);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return wrapper;
}

function outcomeRow(wrapper: VueWrapper) {
  return wrapper.get('.subs-row__outcome');
}

function outcomeText(wrapper: VueWrapper): string {
  return outcomeRow(wrapper).text().replace(/\s+/g, ' ');
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
});

describe('订阅行台账', () => {
  it('成功记录渲染成一行，并带成功语气', async () => {
    const now = Date.now();
    await seed({
      attemptedAt: now - 10 * MINUTE,
      succeededAt: now - 10 * MINUTE,
      failReason: null,
      note: null,
      failCount: 0,
    });
    const wrapper = await mountView();
    expect(outcomeText(wrapper)).toBe('10 分钟前刷新成功');
    expect(outcomeRow(wrapper).classes()).toContain('subs-row__outcome--ok');
  });

  it('失败记录把原因与退避显示出来，并带失败语气', async () => {
    const now = Date.now();
    await seed({
      attemptedAt: now - 10 * MINUTE,
      succeededAt: null,
      failReason: '订阅地址打不开（HTTP 404）',
      note: null,
      failCount: 1,
    });
    const wrapper = await mountView();
    expect(outcomeText(wrapper)).toContain('刷新失败：订阅地址打不开（HTTP 404）');
    expect(outcomeRow(wrapper).classes()).toContain('subs-row__outcome--bad');
  });

  it('旧版本升级后没有台账记录：不显示台账行', async () => {
    await seed(null);
    const wrapper = await mountView();
    expect(wrapper.find('.subs-row__outcome').exists()).toBe(false);
  });

  it('重启前后一致：同一份数据再挂一次界面，显示同一句', async () => {
    const now = Date.now();
    await seed({
      attemptedAt: now - 15 * MINUTE,
      succeededAt: now - 15 * MINUTE,
      failReason: null,
      note: '2 个直播源同步失败',
      failCount: 0,
    });
    const first = await mountView();
    const text = outcomeText(first);
    first.unmount();
    const second = await mountView();
    expect(outcomeText(second)).toBe(text);
    expect(outcomeRow(second).classes()).toContain('subs-row__outcome--warn');
  });
});
