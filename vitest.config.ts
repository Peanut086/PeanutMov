import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __BUILD_TIME__: JSON.stringify('2026-01-01T00:00:00.000Z'),
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'android'],
    clearMocks: true,
    // 数据层用例的 beforeEach 会 closeDb/deleteDatabase（fake-indexeddb）；
    // 26 个文件并行时偶发超过默认 10s。仅放宽钩子超时，不改任何断言语义。
    hookTimeout: 30000,
    // 路由导航用例（17 条懒加载路由逐个 push）在 31 个文件并发时实测 >5s，
    // 单跑 2.2s 通过 → 属并发资源竞争，非逻辑缺陷。仅放宽单测超时。
    testTimeout: 20000,
    // 脚手架阶段两包尚未提交测试用例，允许 0 用例通过；PKG-A/B 补齐后该配置可移除
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: ['src/**/*.d.ts', 'src/main.ts', 'src/mocks/**'],
    },
  },
});
