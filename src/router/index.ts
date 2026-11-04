import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

import { AppError, toAppError } from '@/shared/errors';
import { COMPLIANCE_VERSION } from '@/shared/constants';
import { logger } from '@/shared/logger';

/**
 * 合规门禁依赖注入点。
 *
 * router 只依赖 `get()` 与 `isComplianceAccepted()` 两个方法（API-10 的子集）。
 * 实现由 `main.ts` 注入真实 `settingsService`；router 本身不直接引用任何实现。
 */
export interface ComplianceGateLike {
  get(): Promise<{ complianceVersion: number; complianceAcceptedAt: number | null }>;
  isComplianceAccepted(version: number): Promise<boolean>;
}

let complianceGate: ComplianceGateLike | null = null;

/** 注册/替换合规门禁实现（main.ts 调用） */
export function setComplianceGate(gate: ComplianceGateLike): void {
  complianceGate = gate;
}

/**
 * 判定当前是否已接受最新合规声明。
 * 门禁未注册时视为"未同意"，把用户导向 `/welcome`（首启最安全的行为）；
 * 读取失败时不阻塞导航（避免设置读库异常导致 App 不可用，FR-45 的正常路径优先）。
 */
async function isComplianceSatisfied(): Promise<boolean> {
  if (!complianceGate) {
    logger.warn('合规门禁未注册，按未同意处理');
    return false;
  }
  try {
    const settings = await complianceGate.get();
    if (settings.complianceAcceptedAt === null) return false;
    if (settings.complianceVersion < COMPLIANCE_VERSION) return false;
    return await complianceGate.isComplianceAccepted(COMPLIANCE_VERSION);
  } catch (e) {
    const err = toAppError(e, 'E_DB');
    logger.error('读取合规状态失败，放行导航', err);
    return true;
  }
}

/** 首启合规可自由访问的路由（避免重定向循环） */
const COMPLIANCE_FREE_ROUTES = new Set<string>(['welcome', 'compliance']);

const routes: RouteRecordRaw[] = [
  {
    path: '/welcome',
    name: 'welcome',
    component: () => import('@/views/WelcomeView.vue'),
    meta: { requiresLayout: false, title: '欢迎' },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { requiresLayout: true, tab: 'home', title: '首页' },
  },
  {
    path: '/library',
    name: 'library',
    component: () => import('@/views/LibraryView.vue'),
    meta: { requiresLayout: true, tab: 'library', title: '媒体库' },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
    meta: { requiresLayout: false, title: '搜索' },
  },
  {
    path: '/live',
    name: 'live',
    component: () => import('@/views/LiveView.vue'),
    meta: { requiresLayout: true, tab: 'live', title: '直播' },
  },
  {
    path: '/detail/:mediaId',
    name: 'detail',
    component: () => import('@/views/DetailView.vue'),
    meta: { requiresLayout: false, title: '详情' },
  },
  {
    path: '/player/:mediaId/:episodeId?',
    name: 'player',
    component: () => import('@/views/PlayerView.vue'),
    meta: { requiresLayout: false, immersive: true, title: '播放' },
  },
  {
    path: '/downloads',
    name: 'downloads',
    component: () => import('@/views/DownloadsView.vue'),
    meta: { requiresLayout: true, tab: 'downloads', title: '下载' },
  },
  {
    path: '/history',
    name: 'history',
    component: () => import('@/views/HistoryView.vue'),
    meta: { requiresLayout: false, title: '观看历史' },
  },
  {
    path: '/favorites',
    name: 'favorites',
    component: () => import('@/views/FavoritesView.vue'),
    meta: { requiresLayout: false, title: '收藏' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { requiresLayout: true, tab: 'me', title: '我的' },
  },
  {
    path: '/settings/sources',
    name: 'sources',
    component: () => import('@/views/SourceListView.vue'),
    meta: { requiresLayout: false, title: '源管理' },
  },
  {
    path: '/settings/sources/new',
    name: 'source-new',
    component: () => import('@/views/SourceFormView.vue'),
    meta: { requiresLayout: false, title: '新增源' },
  },
  {
    path: '/settings/sources/import',
    name: 'source-import',
    component: () => import('@/views/ImportSubscriptionView.vue'),
    meta: { requiresLayout: false, title: '导入订阅' },
  },
  {
    path: '/settings/subscriptions',
    name: 'subscriptions',
    component: () => import('@/views/SubscriptionListView.vue'),
    meta: { requiresLayout: false, title: '订阅管理' },
  },
  {
    path: '/settings/subscriptions/eval',
    name: 'subscription-eval',
    component: () => import('@/views/EvalSubscriptionView.vue'),
    meta: { requiresLayout: false, title: '批量订阅评测' },
  },
  {
    path: '/settings/sources/:id/edit',
    name: 'source-edit',
    component: () => import('@/views/SourceFormView.vue'),
    meta: { requiresLayout: false, title: '编辑源' },
  },
  {
    path: '/settings/netdisk',
    name: 'netdisk-settings',
    component: () => import('@/views/NetdiskSettingsView.vue'),
    meta: { requiresLayout: false, title: '网盘账号' },
  },
  {
    path: '/settings/backup',
    name: 'backup',
    component: () => import('@/views/BackupView.vue'),
    meta: { requiresLayout: false, title: '数据备份' },
  },
  {
    path: '/settings/logs',
    name: 'logs',
    component: () => import('@/views/LogsView.vue'),
    meta: { requiresLayout: false, title: '运行日志' },
  },
  {
    path: '/settings/about',
    name: 'about',
    component: () => import('@/views/AboutView.vue'),
    meta: { requiresLayout: false, title: '关于' },
  },
  {
    path: '/legal/compliance',
    name: 'compliance',
    component: () => import('@/views/ComplianceView.vue'),
    meta: { requiresLayout: false, title: '合规声明' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresLayout: false, title: '页面不存在' },
  },
];

const router = createRouter({
  // Capacitor 下 file:///本地服务用 hash 模式更稳（技术方案 2 章）
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    if (to.name === from.name && to.path === from.path) return undefined;
    return { top: 0 };
  },
});

/**
 * 首启合规守卫（技术方案 8.1）：
 * 1. 未同意或声明版本落后，且目标不是 welcome/compliance → `/welcome`
 * 2. 已同意当前版本却访问 `/welcome` → `/`
 */
router.beforeEach(async (to) => {
  const routeName = typeof to.name === 'string' ? to.name : '';
  const satisfied = await isComplianceSatisfied();

  if (!satisfied && !COMPLIANCE_FREE_ROUTES.has(routeName)) {
    return { name: 'welcome', replace: true };
  }
  if (satisfied && routeName === 'welcome') {
    return { name: 'home', replace: true };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  const appName = import.meta.env.VITE_APP_NAME ?? 'PeanutMov';
  if (typeof document !== 'undefined') {
    document.title = title ? `${title} · ${appName}` : appName;
  }
});

router.onError((error) => {
  const err = new AppError('E_UNKNOWN', '页面加载失败，请返回重试', { cause: error });
  logger.error('路由加载失败', err);
});

export { routes };
export default router;
