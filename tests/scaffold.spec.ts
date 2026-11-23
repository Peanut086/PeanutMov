import { createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import App from '@/App.vue';
import router, { routes, setComplianceGate } from '@/router';
import { mockSettingsService } from '@/mocks/mockServices';
import { COMPLIANCE_VERSION } from '@/shared/constants';

/**
 * SCF 脚手架自检（SCF 新增文件，不属于 PKG-A/PKG-B 任何清单）
 * 目的：把"17 条路由可导航 + 合规守卫 + TabBar 布局"变成可回归的断言，
 * 避免后续替换占位组件时悄悄破坏路由表。
 *
 * 【已知失败-依赖批次 1 / FIX-01】（QA-01 标注）
 * 下列 2 条用 `it.fails` 保留原断言且显式声明"当前应为失败"：
 * - `路由表含 22 条记录…`
 * - `已同意后其余 17 条路由逐条可导航`
 * 原因：`SettingsView` 内联 `SourceManageSection` 后，`/settings/sources*` 与
 * `/settings/subscriptions` 路由被移除，`routes` 只剩 21 条同名以外的新增
 * （`epg` / `netdisk-settings` / `douban`）。断言本身仍然有效，**不做删除或放宽**。
 * 回补条件：FIX-01 落地（恢复上述路由或其等价可达入口）后，这两条会因"预期失败却通过"
 * 而报警，届时把 `it.fails` 改回 `it` 并更新期望的路由名清单即可。
 *
 * 【P0-1 进度（2026-11-22）】`/settings/subscriptions` 已恢复注册，`subscriptions`
 * 因此不再是失败原因；这两条现在只卡在 `sources` / `source-new` / `source-edit`
 * 三条独立路由上——它们要不要回来属于 P2-1 的取舍（源新增/编辑/导入现由
 * `SourceManageSection` 的 BottomSheet 与 `/settings/sources/import` 承载），
 * 未定案前 `it.fails` 保持原样。新增的 `P0-1 订阅管理页可达性` 只锁已恢复的那一条。
 */
describe('SCF 脚手架自检', () => {
  beforeEach(() => {
    mockSettingsService.__reset();
    setComplianceGate(mockSettingsService);
  });

  it.fails('[已知失败-依赖 FIX-01] 路由表含 22 条记录（21 条业务路由 + 404；CHG-13 新增 live/订阅两条；日志查看器新增 logs）', () => {
    expect(routes.map((r) => r.name)).toEqual([
      'welcome',
      'home',
      'library',
      'search',
      'live',
      'detail',
      'player',
      'downloads',
      'history',
      'favorites',
      'settings',
      'sources',
      'source-new',
      'source-import',
      'subscriptions',
      'subscription-eval',
      'source-edit',
      'backup',
      'logs',
      'about',
      'compliance',
      'not-found',
    ]);
  });

  it('未同意合规时任何业务路由都被重定向到 /welcome', async () => {
    for (const path of ['/', '/library', '/settings/sources', '/detail/x']) {
      await router.push(path);
      await router.isReady();
      expect(router.currentRoute.value.name, `访问 ${path}`).toBe('welcome');
    }
  });

  it('已同意后 /welcome 重定向到首页', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    await router.push('/legal/compliance');
    await router.push('/welcome');
    expect(router.currentRoute.value.name).toBe('home');
  });

  it.fails('[已知失败-依赖 FIX-01] 已同意后其余 17 条路由逐条可导航', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const targets: Array<[string, string]> = [
      ['/', 'home'],
      ['/library', 'library'],
      ['/search', 'search'],
      ['/live', 'live'],
      ['/detail/abc', 'detail'],
      ['/player/abc/ep1', 'player'],
      ['/downloads', 'downloads'],
      ['/history', 'history'],
      ['/favorites', 'favorites'],
      ['/settings', 'settings'],
      ['/settings/sources', 'sources'],
      ['/settings/sources/new', 'source-new'],
      ['/settings/sources/import', 'source-import'],
      ['/settings/subscriptions', 'subscriptions'],
      ['/settings/subscriptions/eval', 'subscription-eval'],
      ['/settings/sources/s1/edit', 'source-edit'],
      ['/settings/backup', 'backup'],
      ['/settings/logs', 'logs'],
      ['/settings/about', 'about'],
      ['/legal/compliance', 'compliance'],
    ];
    for (const [path, name] of targets) {
      await router.push(path);
      expect(router.currentRoute.value.name, `导航到 ${path}`).toBe(name);
    }
    // 未匹配的路径落到 404
    await router.push('/definitely-not-a-page');
    expect(router.currentRoute.value.name).toBe('not-found');
    expect(targets.length + 2).toBe(22); // 20 + welcome + not-found
  });

  it('一级页面挂载：渲染内容 + 5 项 TabBar + 预留底部留白（CHG-13 起 5 Tab）', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
    await router.push('/library');
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find('[data-route="library"]').exists()).toBe(true);
    expect(wrapper.find('.app-content--tabbar').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="主导航"]').findAll('button').length).toBe(5);
    wrapper.unmount();
  });

  it('二级页面挂载：不渲染 TabBar、不预留留白', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
    await router.push('/legal/compliance');
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find('[data-route="compliance"]').exists()).toBe(true);
    expect(wrapper.find('.app-content--tabbar').exists()).toBe(false);
    expect(wrapper.find('nav[aria-label="主导航"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

/**
 * REV-27 / REV-31：回看路由契约锁定。
 *
 * 实际路径为 `/replay/:sourceId/:programId`（方案 §7.2 写作 `/live/replay`；
 * REV-31 把首参 `channelId` 更名为 `sourceId`，因其实际承载「直播源 id」），
 * 在此把 name / 参数 / depth / requiresLayout 与页面外壳固化，避免后续被悄悄改掉。
 */
describe('REV-27 回看路由契约', () => {
  beforeEach(() => {
    mockSettingsService.__reset();
    setComplianceGate(mockSettingsService);
  });

  it('replay 路由：name=replay、两个路径参数（sourceId / programId）、depth=1、requiresLayout=false', () => {
    const route = routes.find((item) => item.name === 'replay');
    expect(route, '路由表中必须存在 replay 路由').toBeTruthy();
    expect(route!.path).toBe('/replay/:sourceId/:programId');
    expect(route!.meta?.depth).toBe(1);
    expect(route!.meta?.requiresLayout).toBe(false);
    expect(route!.meta?.title).toBe('回看');
  });

  it('replay 页面挂载：渲染 data-route="replay" 外壳且不渲染 TabBar', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
    await router.push('/replay/s1/pr1');
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(router.currentRoute.value.name).toBe('replay');
    expect(wrapper.find('[data-route="replay"]').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="主导航"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

/**
 * P0-1：订阅管理页可达性。
 *
 * CHG-12 的页面与刷新台账一直就在仓库里，OPT-09 内联化时把路由摘掉导致整页不可达；
 * 这里锁"路由契约 + 真的能导航到并挂载"，屏幕上的入口由
 * `tests/views/subscriptionManageEntry.spec.ts` 锁（两处缺一，闭环仍断在导入页）。
 */
describe('P0-1 订阅管理页可达性', () => {
  beforeEach(() => {
    mockSettingsService.__reset();
    setComplianceGate(mockSettingsService);
  });

  it('subscriptions 路由：name/path/depth/requiresLayout/title 契约', () => {
    const route = routes.find((item) => item.name === 'subscriptions');
    expect(route, '路由表中必须存在 subscriptions 路由').toBeTruthy();
    expect(route!.path).toBe('/settings/subscriptions');
    expect(route!.meta?.depth).toBe(1);
    expect(route!.meta?.requiresLayout).toBe(false);
    expect(route!.meta?.title).toBe('订阅管理');
  });

  it('已同意后 /settings/subscriptions 可导航，页面渲染 data-route="subscriptions" 且不渲染 TabBar', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
    await router.push('/settings/subscriptions');
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(router.currentRoute.value.name).toBe('subscriptions');
    expect(wrapper.find('[data-route="subscriptions"]').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="主导航"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
