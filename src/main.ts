import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from '@/App.vue';
import router, { setComplianceGate } from '@/router';
import { mockSettingsService } from '@/mocks/mockServices';
import { logger } from '@/shared/logger';
import { toAppError } from '@/shared/errors';

import '@/styles/global.css';
import '@/styles/player.css';

/**
 * 应用入口（SCF）。
 *
 * 启动顺序：
 * 1. 注册合规门禁实现（当前为 mock；集成时替换为真实 `settingsService`）
 * 2. 挂载 Pinia
 * 3. 挂载 router
 * 4. `seedService.ensureDemo()` 启动钩子 —— 数据包就绪后在此接入；
 *    SCF 阶段用 mock 的 settings 初始化，保证守卫能读到设置。
 */
async function bootstrap(): Promise<void> {
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);

  // 合规门禁：首日使用契约 mock（技术方案 8.1 / FR-45）
  setComplianceGate(mockSettingsService);

  try {
    await mockSettingsService.get();
  } catch (e) {
    logger.error('设置初始化失败（不阻塞启动）', toAppError(e, 'E_DB'));
  }

  app.use(router);
  await router.isReady();
  app.mount('#app');
}

void bootstrap();
