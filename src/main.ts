import { installConsoleCapture } from '@/shared/logBus';
import { restoreLogLevel } from '@/native/logs';

// P1：安装 console 捕获（必须在所有业务代码之前，确保 logger.* 和裸 console.* 都被记录）
installConsoleCapture();

import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from '@/App.vue';
import router, { setComplianceGate } from '@/router';
import { bindAppToasts, complianceGate, ensureDemoData, initDoubanRuntime, initDownloads, initLineHealth, initSettings, initSpiderWarmup, initSubscriptionAutoRefresh } from '@/stores/bootstrap';

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

  // 批次1 + 演示数据：两者互不依赖（分别读写 kv 的独立键与 sources/media/lines/episodes），
  // 并行省掉一次 IDB 冷启动往返。仍在挂载前完成——HomeView 不订阅 `sources:changed`，
  // 种子数据晚于首屏就会一直停在空态。
  await Promise.all([initLineHealth(), ensureDemoData()]);

  // P1：恢复 JS logger 级别（根据原生存储的详细日志开关状态）
  // 只影响后续日志 verbosity，内部已静默兜错，没必要让它挡首屏。
  void restoreLogLevel();

  // 下载队列 + 前后台生命周期（AC-72 / REV-22）：切后台暂停、回前台按设置自动恢复。
  // 内部的四个启动自检（存量坏任务清洗 / 僵尸检测 / HLS 完整性 / 重新入队）要扫全表并
  // 逐个 stat() 本地文件，是首屏最长的一段等待，因此不 await：任务列表页自己有 `load()`，
  // 自检过程又持续抛 `download` 事件，晚到的纠正一样会反映到 UI。
  // 注意 initDownloads 内部仍保持「清洗 → 僵尸 → 完整性 → bootstrap」原序，顺序颠倒会让
  // 坏任务被 autoResume 重新入队（见 downloadService.repairLocalArtifactTasks 注释）。
  void initDownloads();

  // 豆瓣源跨源播放：让「仅片单」的豆瓣源能借 CMS 源的播放地址
  initDoubanRuntime();

  // v1.7/CHG-19：订阅自动刷新（24h TTL，fire-and-forget，不阻塞启动）
  initSubscriptionAutoRefresh();

  // F7：延迟一段时间后批量预热爬虫源，让「装完/重启后第一次搜索」不必现场加载 jar
  // （内部并发 ≤4，搜索一在途就自动让路）
  initSpiderWarmup();

  app.use(router);
  await router.isReady();
  app.mount('#app');
}

void bootstrap();
