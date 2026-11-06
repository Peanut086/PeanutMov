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
    meta: { requiresLayout: false, depth: 0, title: '欢迎' },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { requiresLayout: true, tab: 'home', depth: 0, title: '首页' },
  },
  {
    path: '/library',
    name: 'library',
    component: () => import('@/views/LibraryView.vue'),
    meta: { requiresLayout: true, tab: 'library', depth: 0, title: '媒体库' },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '搜索' },
  },
  {
    path: '/live',
    name: 'live',
    component: () => import('@/views/LiveView.vue'),
    meta: { requiresLayout: true, tab: 'live', depth: 0, title: '直播' },
  },
  {
    path: '/live/epg',
    name: 'epg',
    component: () => import('@/views/EpgView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '节目单' },
  },
  {
    // EXT-06/FR-68：回看播放（sourceId = 直播源 id，programId = 节目键 `${startAt}:${title}`）
    // REV-31：参数名与实义对齐（原 channelId 实际承载「直播源 id」）
    path: '/replay/:sourceId/:programId',
    name: 'replay',
    component: () => import('@/views/ReplayPlayerView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '回看' },
  },
  {
    path: '/detail/:mediaId',
    name: 'detail',
    component: () => import('@/views/DetailView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '详情' },
  },
  {
    path: '/player/:mediaId/:episodeId?',
    name: 'player',
    component: () => import('@/views/PlayerView.vue'),
    meta: { requiresLayout: false, immersive: true, depth: 2, title: '播放' },
  },
  {
    path: '/downloads',
    name: 'downloads',
    component: () => import('@/views/DownloadsView.vue'),
    meta: { requiresLayout: true, tab: 'downloads', depth: 0, title: '下载' },
  },
  {
    path: '/history',
    name: 'history',
    component: () => import('@/views/HistoryView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '观看历史' },
  },
  {
    path: '/favorites',
    name: 'favorites',
    component: () => import('@/views/FavoritesView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '收藏' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { requiresLayout: true, tab: 'settings', depth: 0, title: '我的' },
  },
  {
    path: '/settings/sources/import',
    name: 'source-import',
    component: () => import('@/views/ImportSubscriptionView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '导入订阅' },
  },
  {
    path: '/settings/subscriptions/eval',
    name: 'subscription-eval',
    component: () => import('@/views/EvalSubscriptionView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '批量订阅评测' },
  },
  {
    path: '/settings/netdisk',
    name: 'netdisk-settings',
    component: () => import('@/views/NetdiskSettingsView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '网盘账号' },
  },
  {
    path: '/douban',
    name: 'douban',
    component: () => import('@/views/DoubanView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '豆瓣榜单' },
  },
  {
    path: '/settings/backup',
    name: 'backup',
    component: () => import('@/views/BackupView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '数据备份' },
  },
  {
    path: '/settings/logs',
    name: 'logs',
    component: () => import('@/views/LogsView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '运行日志' },
  },
  {
    // EXT-01：源健康治理中心（设置页进入，二级页）
    path: '/health-center',
    name: 'health-center',
    component: () => import('@/views/HealthCenterView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '源健康中心' },
  },
  {
    // EXT-08：导入诊断（jar 预取 + 失败分类 + 报告导出，二级页）
    path: '/import-diagnostic',
    name: 'import-diagnostic',
    component: () => import('@/views/ImportDiagnosticView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '导入诊断' },
  },
  {
    path: '/settings/about',
    name: 'about',
    component: () => import('@/views/AboutView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '关于' },
  },
  {
    path: '/legal/compliance',
    name: 'compliance',
    component: () => import('@/views/ComplianceView.vue'),
    meta: { requiresLayout: false, depth: 1, title: '合规声明' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresLayout: false, depth: 0, title: '页面不存在' },
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
