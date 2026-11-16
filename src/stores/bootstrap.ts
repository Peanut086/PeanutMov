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
import type { Router } from 'vue-router';

import type { ComplianceGateLike } from '@/router';
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { settingsService } from '@/services/settingsService';
import { bindSessionRestore } from '@/services/sessionRestoreService';
import { seedService } from '@/services/seedService';
import { downloadService } from '@/services/downloadService';
import { runOfflineRemuxMigration } from '@/services/offlineRemuxMigration';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import { appEvents } from '@/services/events';
import { lineHealthService } from '@/services/lineHealthService';
import { libraryService } from '@/services/libraryService';
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

/** 批次1：线路健康记忆初始化（加载持久化数据）；失败只记日志，不阻塞启动 */
export async function initLineHealth(): Promise<void> {
  try {
    await lineHealthService.init();
  } catch (e) {
    logger.error('线路健康记忆初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }
}

/**
 * G3：冷启动会话恢复接线。
 *
 * 必须在 `app.use(router)` 之前 await 完成——首帧导航要被一次性 beforeEach 改写，
 * 安装后再 replace 会先挂载首页再跳播放页，看得见一次闪跳。
 * 失败只记日志，退回"每次启动都从首页开始"的原行为。
 */
export async function initSessionRestore(router: Router): Promise<void> {
  try {
    await bindSessionRestore(router);
  } catch (e) {
    logger.error('会话恢复接线失败（不阻塞启动）', toAppError(e, 'E_DB'));
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
 * REV-24：僵尸任务检测在 bootstrap 之前执行，把 app 重启后残留的 "downloading"
 * 任务标记为 failed（进程已死，任务必然是僵尸）。
 *
 * 幂等；失败只记日志，不阻塞启动。
 */
export async function initDownloads(): Promise<void> {
  try {
    // P0-3：先清洗「地址指向本地文件」的存量坏任务，再跑僵尸检测——
    // 顺序颠倒会让它们被 autoResume 重新入队，回到"进度 0 的重试循环"。
    await downloadService.repairLocalArtifactTasks();
    await downloadService.checkZombieTasks();
    await downloadService.checkCorruptedHlsTasks();
    await downloadService.bootstrap();
    // P0-1：存量 .ts 离线文件的后台转封装（内部延迟 + 等队列空闲，不阻塞启动）
    void runOfflineRemuxMigration();
  } catch (e) {
    logger.error('下载队列初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }
}

/** 恢复演示源（重新启用并补齐条目，不重复插入）；供源管理页「恢复演示源」使用 */
export function restoreDemoSource(): Promise<Source> {
  return seedService.restoreDemo();
}

/**
 * OPT-10：缓存清扫（弹幕 / EPG 的过期条目 + 超出 LRU 上限的最旧条目）。
 *
 * 每次启动一次、fire-and-forget：读时过期只覆盖"还会被读到"的键，换过关键词的弹幕匹配
 * 与看过一次的频道节目单没人再读，就永久留在盘上（单条弹幕缓存可达数 MB）。
 * 失败只记日志——纯缓存，清不动也不影响功能。
 */
export async function initCacheSweep(): Promise<void> {
  try {
    const swept = await cacheRepo.sweep();
    if (swept.danmaku > 0 || swept.epg > 0) {
      logger.debug('缓存清扫完成', { danmaku: swept.danmaku, epg: swept.epg });
    }
  } catch (e) {
    logger.warn('缓存清扫失败（不阻塞启动）', toAppError(e, 'E_DB').message);
  }
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

/**
 * F7 / FR-51：启动后批量预热爬虫源（fire-and-forget，不阻塞启动）。
 *
 * 既有的 `prewarm` 全部挂在真实请求路径上，所以「装完 / 重启后的第一次搜索」必然把
 * jar 下载 + dex + 防护初始化算进单源搜索超时——真机实测启动后 30 秒即搜有 12 个源
 * 因此被记成「搜索超时」，等后台体检加载完再搜同一关键词则超时数为 0。
 * 这里补上主动起跑点；扫描内部并发 ≤4，且一旦有搜索在途立即让路。
 */
export function initSpiderWarmup(): void {
  void libraryService.warmupSources();
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
