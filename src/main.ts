import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from '@/App.vue';
import router, { setComplianceGate } from '@/router';
import { settingsService } from '@/services/settingsService';
import { seedService } from '@/services/seedService';
import { logger } from '@/shared/logger';
import { toAppError } from '@/shared/errors';

import '@/styles/global.css';
import '@/styles/player.css';

/**
 * 应用入口（SCF）。
 *
 * 启动顺序：
 * 1. 注册合规门禁实现（`settingsService`，API-10 的子集）
 * 2. 挂载 Pinia
 * 3. 演示数据启动钩子 `seedService.ensureDemo()`（幂等；失败不阻塞启动）
 * 4. 挂载 router（守卫需要能读到设置）
 */
async function bootstrap(): Promise<void> {
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);

  // 合规门禁：router 只依赖 get() 与 isComplianceAccepted()（技术方案 8.1 / FR-45）
  setComplianceGate({
    get: () => settingsService.get(),
    isComplianceAccepted: (version: number) => settingsService.isComplianceAccepted(version),
  });

  try {
    await settingsService.get();
  } catch (e) {
    logger.error('设置初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }

  // 演示数据：幂等；失败只记日志，页面仍可进入空态并手动重试
  try {
    await seedService.ensureDemo();
  } catch (e) {
    logger.error('演示数据初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }

  app.use(router);
  await router.isReady();
  app.mount('#app');
}

void bootstrap();
