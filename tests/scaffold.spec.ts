import { createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import App from '@/App.vue';
import router, { routes, setComplianceGate } from '@/router';
import { mockSettingsService } from '@/mocks/mockServices';
import { COMPLIANCE_VERSION } from '@/shared/constants';

/**
 * 脚手架自检（SCF 新增文件，不属于 PKG-A/PKG-B 任何清单）
 * 目的：把"17 条路由可导航 + 合规守卫 + TabBar 布局"变成可回归的断言，
 * 避免后续替换占位组件时悄悄破坏路由表。
 */
describe('SCF 脚手架自检', () => {
  beforeEach(() => {
    mockSettingsService.__reset();
    setComplianceGate(mockSettingsService);
  });

  it('路由表含 18 条记录（17 条业务路由 + 404）', () => {
    expect(routes.map((r) => r.name)).toEqual([
      'welcome',
      'home',
      'library',
      'search',
      'detail',
      'player',
      'downloads',
      'history',
      'favorites',
      'settings',
      'sources',
      'source-new',
      'source-import',
      'source-edit',
      'backup',
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

  it('已同意后其余 16 条路由逐条可导航', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const targets: Array<[string, string]> = [
      ['/', 'home'],
      ['/library', 'library'],
      ['/search', 'search'],
      ['/detail/abc', 'detail'],
      ['/player/abc/ep1', 'player'],
      ['/downloads', 'downloads'],
      ['/history', 'history'],
      ['/favorites', 'favorites'],
      ['/settings', 'settings'],
      ['/settings/sources', 'sources'],
      ['/settings/sources/new', 'source-new'],
      ['/settings/sources/import', 'source-import'],
      ['/settings/sources/s1/edit', 'source-edit'],
      ['/settings/backup', 'backup'],
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
    expect(targets.length + 2).toBe(18); // 16 + welcome + not-found
  });

  it('一级页面挂载：渲染内容 + 4 项 TabBar + 预留底部留白', async () => {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
    await router.push('/library');
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find('[data-route="library"]').exists()).toBe(true);
    expect(wrapper.find('.app-content--tabbar').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="主导航"]').findAll('button').length).toBe(4);
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
