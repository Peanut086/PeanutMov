/**
 * P1-2：订阅管理页的「名字」口径
 *
 * 订阅页以前只有来源标识（整条 URL 或文件名），读不出"哪一份订阅"。现在标题用订阅名称，
 * 名称缺失时退回短标签（主机名 / 文件名末段）；副行只在"比标题多信息"时出现——
 * 删与刷的判定依据不能丢，同域名挂两份订阅时全靠它区分（真机上 qist.wyfc.qzz.io 就撞了两次）。
 *
 * 这里不 mock 服务层：链路 UI → `summarize()` → `subscriptions` 表全部是真的，
 * 断言过的显示口径与后台自动刷新读的是同一份数据。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import SubscriptionListView from '@/views/SubscriptionListView.vue';
import SourceManageSection from '@/components/source/SourceManageSection.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { subscriptionRepo } from '@/db/repositories/subscriptionRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { KV_KEY_IMPORT_RECORDS } from '@/shared/constants';
import type { Source } from '@/types';

import { resetAll } from '../unit/helpers';

const URL_A = 'https://sub.example.com/a.json';

function makeSource(subscriptionId: string): Source {
  const now = Date.now();
  return {
    id: `sub-${subscriptionId}`,
    key: `sub-${subscriptionId}`,
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

async function mountView(): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const wrapper = mount(SubscriptionListView);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return wrapper;
}

/** 第一行的标题与次级地址行 */
function firstRow(wrapper: VueWrapper): { title: string; url: string | null } {
  return {
    title: wrapper.get('.subs-row__id').text(),
    url: wrapper.find('.subs-row__url').exists() ? wrapper.get('.subs-row__url').text() : null,
  };
}

beforeEach(async () => {
  await resetAll();
});

describe('订阅行的显示名', () => {
  it('有名称：标题用名称，完整地址仍在次级一行', async () => {
    await sourceRepo.save(makeSource(URL_A));
    await subscriptionRepo.upsertKeyed({ key: URL_A, url: URL_A, fileName: null, name: '我的片库' });

    const row = firstRow(await mountView());
    expect(row.title).toBe('我的片库');
    expect(row.url).toBe(URL_A);
  });

  it('没有名称：标题退回主机名，完整地址降到次级一行', async () => {
    await sourceRepo.save(makeSource(URL_A));

    const row = firstRow(await mountView());
    expect(row.title).toBe('sub.example.com');
    expect(row.url).toBe(URL_A);
    // 补建出来的实体不带名称（没有可依据的信息），显示口径才会继续走短标签
    expect((await subscriptionRepo.findByKey(URL_A))?.name).toBeNull();
  });

  it('同域名挂两份订阅：标题可以撞名，副行必须把两者分开', async () => {
    await sourceRepo.save(makeSource('https://qist.wyfc.qzz.io/fty.json'));
    await sourceRepo.save(makeSource('https://qist.wyfc.qzz.io/xiaosa/api.json'));

    const wrapper = await mountView();
    const titles = wrapper.findAll('.subs-row__id').map((node) => node.text());
    const urls = wrapper.findAll('.subs-row__url').map((node) => node.text());
    expect(titles).toEqual(['qist.wyfc.qzz.io', 'qist.wyfc.qzz.io']);
    expect(new Set(urls).size).toBe(2);
    expect(urls).toContain('https://qist.wyfc.qzz.io/fty.json');
    expect(urls).toContain('https://qist.wyfc.qzz.io/xiaosa/api.json');
  });

  it('老库升级后：名称只存在于导入记录里，进页面即补建实体并显示名称', async () => {
    await sourceRepo.save(makeSource(URL_A));
    await kvRepo.set(KV_KEY_IMPORT_RECORDS, [
      { url: URL_A, name: '去年导入的订阅', importedAt: Date.now(), success: 1 },
    ]);

    const row = firstRow(await mountView());
    expect(row.title).toBe('去年导入的订阅');
    expect(row.url).toBe(URL_A);
    expect((await subscriptionRepo.findByKey(URL_A))?.name).toBe('去年导入的订阅');
  });

  it('文件导入的订阅：标题用文件名末段，路径比末段多信息时仍给整条标识', async () => {
    await sourceRepo.save(makeSource('/sdcard/TVBox/my-sub.json'));

    const row = firstRow(await mountView());
    expect(row.title).toBe('my-sub.json');
    expect(row.url).toBe('/sdcard/TVBox/my-sub.json');
  });

  it('标识本身就等于标题：不重复渲染一行同样的字', async () => {
    await sourceRepo.save(makeSource('my-sub.json'));

    const row = firstRow(await mountView());
    expect(row.title).toBe('my-sub.json');
    expect(row.url).toBeNull();
  });
});

/** 源管理区的订阅摘要与订阅页共用同一份名字，两处不能各叫各的 */
describe('源管理区摘要行同名口径', () => {
  async function mountSection(): Promise<VueWrapper> {
    setActivePinia(createPinia());
    const wrapper = mount(SourceManageSection);
    await useSourceStore().load();
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
  }

  it('有名称显示名称，完整地址留在 title 里；没名称退回主机名', async () => {
    await sourceRepo.save(makeSource(URL_A));
    await subscriptionRepo.upsertKeyed({ key: URL_A, url: URL_A, fileName: null, name: '我的片库' });

    const named = mountSection();
    const label = (await named).get('.source-manage__summary-id');
    expect(label.text()).toBe('我的片库');
    expect(label.attributes('title')).toBe(URL_A);

    // 同一份数据在订阅管理页也叫这个名字
    expect(firstRow(await mountView()).title).toBe('我的片库');

    await subscriptionRepo.removeByKey(URL_A);
    const bare = await mountSection();
    expect(bare.get('.source-manage__summary-id').text()).toBe('sub.example.com');
  });
});
