/**
 * 返回键兜底与侧滑共用的「能否回退」判据（Q1 方案 A）
 *
 * 两条口径：没有来时页不可回退；一级 Tab 页之间（平级切换）不可回退。
 * 但二级页 push 到一级 Tab（详情页跳「源设置」）必须放行——否则那条返回会直接关掉 App。
 * 这一条同时喂返回键兜底和侧滑开关，两者分歧会表现为"能拖出位移却回不去"，所以单独钉住。
 *
 * 分两层：上面那份桩只锁判据逻辑（喂 `state.back` 的各种形状），下面那层跑真实的
 * hash history，锁它依赖的前提——`state.back` 是可 resolve 的路径、且 replace 会保留它。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRouter, createWebHashHistory, type Router } from 'vue-router';

import { canGoBack } from '@/composables/useBackButton';

/** 带 `meta.requiresLayout` 的那 5 个一级路由 */
const TAB_ROOTS = new Set(['/', '/library', '/live', '/downloads', '/settings']);

function metaOf(path: string): Record<string, unknown> {
  return { requiresLayout: TAB_ROOTS.has(path.split('?')[0]) };
}

function routerLike(currentPath: string, back: unknown): Router {
  return {
    currentRoute: { value: { meta: metaOf(currentPath) } },
    options: { history: { state: { back } } },
    resolve: (path: string) => ({ meta: metaOf(path) }),
  } as unknown as Router;
}

function makeRealRouter(): Router {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' }, meta: { requiresLayout: true } },
      { path: '/library', name: 'library', component: { template: '<div />' }, meta: { requiresLayout: true } },
      { path: '/downloads', name: 'downloads', component: { template: '<div />' }, meta: { requiresLayout: true } },
      { path: '/settings', name: 'settings', component: { template: '<div />' }, meta: { requiresLayout: true } },
      {
        path: '/detail/:mediaId',
        name: 'detail',
        component: { template: '<div />' },
        meta: { requiresLayout: false },
      },
    ],
  });
}

describe('canGoBack', () => {
  it('无来时页时不可回退（冷启动与切 Tab 之后都是这种形态）', () => {
    expect(canGoBack(routerLike('/downloads', ''))).toBe(false);
    expect(canGoBack(routerLike('/detail/m1', ''))).toBe(false);
    expect(canGoBack(routerLike('/detail/m1', null))).toBe(false);
    expect(canGoBack(routerLike('/detail/m1', undefined))).toBe(false);
  });

  it('二级页有来时页时可回退', () => {
    expect(canGoBack(routerLike('/detail/m1', '/'))).toBe(true);
    expect(canGoBack(routerLike('/detail/m1', '/search?q=x'))).toBe(true);
  });

  it('一级 Tab 页之间不回退：平级 Tab 不是来时页', () => {
    // 首页「去媒体库」那类 push 路径留在历史里时也必须判假，否则返回键会翻出别的 Tab
    expect(canGoBack(routerLike('/downloads', '/'))).toBe(false);
    expect(canGoBack(routerLike('/library', '/settings'))).toBe(false);
  });

  /** 这条是"一级 Tab 一律算栈底"那种简化判据的反例：会把正常返回变成杀进程 */
  it('二级页 push 到一级 Tab 时仍可回退（详情页 → 源设置 → 返回 = 回详情页）', () => {
    expect(canGoBack(routerLike('/settings', '/detail/m1'))).toBe(true);
  });
});

/**
 * 同一套 hash history 下的实测链（`src/router` 用的就是 `createWebHashHistory`）。
 *
 * 上面那份桩只锁判据本身的逻辑；这里锁它依赖的前提：`state.back` 是能被 `router.resolve()`
 * 读懂的路径，且 `replace` 会原样保留它——「切 Tab 用 replace 就不留历史」全靠这条成立。
 */
describe('canGoBack（hash history 实链）', () => {
  beforeEach(() => {
    // 每个用例都从"进程刚起来"的形态开始：history.state 置空，由 router 重新初始化 back=null
    window.history.replaceState(null, '', '/#/');
  });

  it('冷启动 → 切 Tab → 进详情 → 跳设置，逐级判定都符合预期', async () => {
    const router = makeRealRouter();
    await router.replace('/');
    expect(canGoBack(router)).toBe(false); // 栈底：返回即退出

    await router.replace('/downloads');
    expect(canGoBack(router)).toBe(false); // 切 Tab 不留历史，仍是栈底

    await router.push('/detail/m1');
    expect(canGoBack(router)).toBe(true); // 详情 → 回下载 Tab

    await router.push('/settings');
    expect(canGoBack(router)).toBe(true); // 设置 → 回详情，而不是关掉 App
  });

  it('Tab 被 push 落在非栈底位置时也不回退（深链、首页「去媒体库」那类入口）', async () => {
    const router = makeRealRouter();
    await router.replace('/');
    await router.push('/downloads');
    expect(canGoBack(router)).toBe(false);
  });
});
