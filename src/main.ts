import { installConsoleCapture } from '@/shared/logBus';
import { restoreLogLevel } from '@/native/logs';

// P1：安装 console 捕获（必须在所有业务代码之前，确保 logger.* 和裸 console.* 都被记录）
installConsoleCapture();

import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from '@/App.vue';
import router, { setComplianceGate } from '@/router';
import { bindAppToasts, complianceGate, ensureDemoData, initDoubanRuntime, initDownloads, initSettings, initSubscriptionAutoRefresh } from '@/stores/bootstrap';

import '@/styles/global.css';
import '@/styles/player.css';

/**
 * 应用入口（SCF）。
 *
 * 启动顺序：
 * 1. 注册合规门禁实现（`@/stores/bootstrap` 暴露的 API-10 子集）
 * 2. 挂载 Pinia
 * 3. 演示数据启动钩子 `ensureDemoData()`（幂等；失败不阻塞启动）
 * 4. 挂载 router（守卫需要能读到设置）
 *
 * 分层约束（REV-09）：本文件作为 UI 侧装配层，**不直接 import `@/services/*`**；
 * 取实现与注入的动作集中在 `src/stores/bootstrap.ts`（Store → Service 链路合法）。
 */
async function bootstrap(): Promise<void> {
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);

  // 合规门禁：router 只依赖 get() 与 isComplianceAccepted()（技术方案 8.1 / FR-45）
  setComplianceGate(complianceGate);

  // 数据层事件 → 全局 Toast（服务层 toast 与 local:missing 提示，REV-23）
  bindAppToasts();

  await initSettings();

  // P1：恢复 JS logger 级别（根据原生存储的详细日志开关状态）
  await restoreLogLevel();

  // 演示数据：幂等；失败只记日志，页面仍可进入空态并手动重试
  await ensureDemoData();

  // 下载队列 + 前后台生命周期（AC-72 / REV-22）：切后台暂停、回前台按设置自动恢复
  await initDownloads();

  // 豆瓣源跨源播放：让「仅片单」的豆瓣源能借 CMS 源的播放地址
  initDoubanRuntime();

  // v1.7/CHG-19：订阅自动刷新（24h TTL，fire-and-forget，不阻塞启动）
  initSubscriptionAutoRefresh();

  app.use(router);
  await router.isReady();
  app.mount('#app');
}

void bootstrap();
