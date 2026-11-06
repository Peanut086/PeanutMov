/**
 * 启动装配层（REV-09 修复）
 *
 * 《开发任务拆分》2.2 规定 UI 包只允许 import `@/services/{castService,backupService,deviceService}`，
 * 而 `src/main.ts`（SCF 文件）此前直接 import 了 `settingsService` 与 `seedService`，属白名单外引用。
 *
 * 修复方式（未扩白名单）：把"取实现 + 注入"的动作下沉到 Store 层（Store → Service 是合法分层），
 * `main.ts` 只依赖本模块导出的纯函数：
 * - `complianceGate`：注入 router 的合规门禁（API-10 的两个方法子集）；
 * - `initSettings()`：预热设置（失败不阻塞启动）；
 * - `ensureDemoData()`：演示数据幂等种子（失败只记日志）；
 * - `restoreDemoSource()`：设置/源管理页的「恢复演示源」（REV-14 / FR-43 / AC-97）。
 */
import type { ComplianceGateLike } from '@/router';
import { settingsService } from '@/services/settingsService';
import { seedService } from '@/services/seedService';
import { downloadService } from '@/services/downloadService';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import { appEvents } from '@/services/events';
import { configureDoubanRuntime } from '@/sources/douban/doubanRuntime';
import { useUiStore } from '@/stores/uiStore';
import { toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { AppSettings, Source } from '@/types';

/** router 合规门禁实现（只暴露 get / isComplianceAccepted，避免 router 感知 Service） */
export const complianceGate: ComplianceGateLike = {
  get: (): Promise<Pick<AppSettings, 'complianceVersion' | 'complianceAcceptedAt'>> => settingsService.get(),
  isComplianceAccepted: (version: number): Promise<boolean> => settingsService.isComplianceAccepted(version),
};

/** 设置预热：读一次即落内存缓存；失败只记日志（页面各自有错误态） */
export async function initSettings(): Promise<void> {
  try {
    await settingsService.get();
  } catch (e) {
    logger.error('设置初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }
}

/** 演示数据种子：幂等；失败不阻塞启动（FR-43 / AC-95） */
export async function ensureDemoData(): Promise<void> {
  try {
    await seedService.ensureDemo();
  } catch (e) {
    logger.error('演示数据初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }
}

/**
 * 下载队列初始化 + 应用生命周期接线（AC-72 / REV-22）。
 *
 * `downloadService.bootstrap()` 会：
 * 1. 订阅前后台切换：进后台把所有"下载中"转"已暂停"并保留进度；回前台按
 *    `settings.download.autoResume` 自动恢复；
 * 2. 重新入队可恢复任务（离线时跳过，回前台/联网后由生命周期再次触发）。
 *
 * 幂等；失败只记日志，不阻塞启动。
 */
export async function initDownloads(): Promise<void> {
  try {
    await downloadService.bootstrap();
  } catch (e) {
    logger.error('下载队列初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }
}

/** 恢复演示源（重新启用并补齐条目，不重复插入）；供源管理页「恢复演示源」使用 */
export function restoreDemoSource(): Promise<Source> {
  return seedService.restoreDemo();
}

/**
 * 豆瓣源跨源播放装配（幂等）。
 *
 * 豆瓣只有片单，播放地址要向 CMS 源借用；装配后 registry 里的
 * `DoubanAdapter` 才能解析出真实播放地址。幂等，可重复调用。
 */
export function initDoubanRuntime(): void {
  try {
    configureDoubanRuntime();
  } catch (e) {
    logger.error('豆瓣跨源播放装配失败（不阻塞启动）', toAppError(e, 'E_UNKNOWN'));
  }
}

/**
 * FIX-06 / FR-51 / AC-119：订阅自动刷新（启动 + 回前台触发，Q-05=A）。
 *
 * - 启动即触发一次；
 * - 同时接线应用生命周期：仅在「回前台」时补触发（进后台不做任何事）；
 * - 24h TTL 去重、在途合并、离线跳过全部在 `subscriptionLifecycleService.autoRefreshIfDue`
 *   内部完成，**不使用 `setInterval` 等常驻定时器**；
 * - 全部 fire-and-forget（服务层不抛异常），不阻塞启动。
 */
export function initSubscriptionAutoRefresh(): void {
  void subscriptionLifecycleService.autoRefreshIfDue('startup');
  subscriptionLifecycleService.bindAutoRefresh();
}

let unbindToasts: (() => void) | null = null;

/**
 * 数据层事件 → 全局 Toast 桥接。
 *
 * - `toast`：服务层（如下载引擎的"该地址不支持断点续传"）发出的全局轻提示；
 * - `local:missing`：已下载任务但本地文件丢失（AC-78 / REV-23），回退网络源时提示。
 *
 * 幂等；调用前需已 `app.use(pinia)`（`main.ts` 中位于 `initSettings()` 之前的位置即可）。
 */
export function bindAppToasts(): void {
  if (unbindToasts) return;
  const ui = useUiStore();
  const offToast = appEvents.on('toast', ({ text, type }) => {
    ui.toast(text, type);
  });
  const offMissing = appEvents.on('local:missing', ({ text }) => {
    ui.toast(text, 'error');
  });
  unbindToasts = () => {
    offToast();
    offMissing();
    unbindToasts = null;
  };
}
