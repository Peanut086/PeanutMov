/**
 * P0-1：设置页源管理区 → 订阅管理入口 + 摘要行刷新台账
 *
 * 路由能被 `router.push` 到达由 `tests/scaffold.spec.ts` 锁定；这里锁的是"用户在屏幕上点得到"：
 * 1. 订阅健康摘要的面板头有「管理」，点它 push 的是 `{ name: 'subscriptions' }`；
 * 2. 每条摘要下面把刷新台账渲染成一行，语气档位（ok / warn / bad）跟着 `describeRefreshOutcome` 走；
 * 3. 「刷新」按钮文案写明 24h 跳过语义——跳过不是失败，不能说反也不能不说；刷完台账要重读。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => mocks.toast }));

import SourceManageSection from '@/components/source/SourceManageSection.vue';
import { kvRepo } from '@/db/repositories/kvRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { useSourceStore } from '@/stores/sourceStore';
import type { SubscriptionRefreshOutcome } from '@/services/subscriptionLifecycleService';
import type { Source } from '@/types';

import { resetAll } from '../unit/helpers';

const URL_A = 'https://sub.example.com/a.json';
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

function failedOutcome(now: number): SubscriptionRefreshOutcome {
  return {
    attemptedAt: now,
    succeededAt: null,
    failReason: '订阅地址打不开（HTTP 500）',
    note: null,
    failCount: 1,
  };
}

async function seed(outcome: SubscriptionRefreshOutcome | null): Promise<void> {
  await sourceRepo.save(makeSource());
  if (outcome) await kvRepo.set('subscription-refresh-outcomes', { [URL_A]: outcome });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountSection(): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const wrapper = mount(SourceManageSection);
  await useSourceStore().load();
  await settle();
  return wrapper;
}

function noteLine(wrapper: VueWrapper) {
  return wrapper.get('.source-manage__summary-note');
}

function refreshButton(wrapper: VueWrapper) {
  const found = wrapper
    .findAll('button')
    .filter((node) => node.text().replace(/\s+/g, '').startsWith('刷新（跳过'));
  expect(found.length, '面板头必须有且只有一个「刷新」按钮').toBe(1);
  return found[0]!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
});

describe('订阅管理入口（P0-1）', () => {
  it('摘要面板头有「管理」，点击后跳转订阅管理页', async () => {
    await seed(null);
    const wrapper = await mountSection();
    const link = wrapper
      .findAll('.source-manage__panel-link')
      .find((node) => node.text().replace(/\s+/g, '') === '管理');
    expect(link, '源管理区必须有进入订阅管理页的入口').toBeTruthy();
    await link!.trigger('click');
    expect(mocks.push).toHaveBeenCalledWith({ name: 'subscriptions' });
  });

  it('刷新按钮文案写明「跳过 24h 内已刷」，并把单条重试指向管理页', async () => {
    await seed(null);
    const wrapper = await mountSection();
    const button = refreshButton(wrapper);
    expect(button.text().replace(/\s+/g, ' ').trim()).toBe('刷新（跳过 24h 内已刷）');
    expect(button.attributes('title')).toContain('单条刷新');
  });

  it('全部刷新只跳过时算 info，不算成功也不算失败', async () => {
    await seed(null);
    const wrapper = await mountSection();
    const spy = vi
      .spyOn(useSourceStore(), 'refreshAllSubscriptions')
      .mockResolvedValue({ refreshed: 0, failed: 0, deferred: 2 });
    await refreshButton(wrapper).trigger('click');
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mocks.toast.info).toHaveBeenCalledWith('已跳过 2 个订阅（24h 内刷过或失败退避中）');
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('刷新后重读台账：本轮失败的原因立刻显示在摘要行上', async () => {
    await seed(null);
    const wrapper = await mountSection();
    expect(wrapper.find('.source-manage__summary-note').exists()).toBe(false);
    vi.spyOn(useSourceStore(), 'refreshAllSubscriptions').mockImplementation(async () => {
      await kvRepo.set('subscription-refresh-outcomes', { [URL_A]: failedOutcome(Date.now()) });
      return { refreshed: 0, failed: 1, deferred: 0 };
    });
    await refreshButton(wrapper).trigger('click');
    await settle();
    expect(noteLine(wrapper).text()).toContain('刷新失败：订阅地址打不开（HTTP 500）');
    expect(noteLine(wrapper).classes()).toContain('source-manage__summary-note--bad');
    expect(mocks.toast.error).toHaveBeenCalled();
  });
});

describe('摘要行刷新台账（P0-1）', () => {
  it('成功台账渲染成一行，并带成功语气', async () => {
    const now = Date.now();
    await seed({
      attemptedAt: now - 10 * MINUTE,
      succeededAt: now - 10 * MINUTE,
      failReason: null,
      note: null,
      failCount: 0,
    });
    const wrapper = await mountSection();
    expect(noteLine(wrapper).text().replace(/\s+/g, ' ')).toBe('10 分钟前刷新成功');
    expect(noteLine(wrapper).classes()).toContain('source-manage__summary-note--ok');
  });

  it('部分成功（note）走警告语气', async () => {
    const now = Date.now();
    await seed({
      attemptedAt: now - 5 * MINUTE,
      succeededAt: now - 5 * MINUTE,
      failReason: null,
      note: '2 个直播源同步失败',
      failCount: 0,
    });
    const wrapper = await mountSection();
    expect(noteLine(wrapper).text()).toContain('刷新成功，2 个直播源同步失败');
    expect(noteLine(wrapper).classes()).toContain('source-manage__summary-note--warn');
  });

  it('失败台账把原因与退避一起显示，并带失败语气', async () => {
    const now = Date.now();
    await seed({
      attemptedAt: now - 10 * MINUTE,
      succeededAt: null,
      failReason: '订阅地址打不开（HTTP 404）',
      note: null,
      failCount: 1,
    });
    const wrapper = await mountSection();
    expect(noteLine(wrapper).text()).toContain('刷新失败：订阅地址打不开（HTTP 404）');
    expect(noteLine(wrapper).classes()).toContain('source-manage__summary-note--bad');
  });

  it('旧版本升级后没有台账记录：不凭空显示台账行，但入口仍在', async () => {
    await seed(null);
    const wrapper = await mountSection();
    expect(wrapper.find('.source-manage__summary-note').exists()).toBe(false);
    expect(wrapper.find('.source-manage__panel-link').exists()).toBe(true);
  });
});
