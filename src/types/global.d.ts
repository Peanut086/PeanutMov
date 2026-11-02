/**
 * Vite 构建时注入的全局变量声明
 * 这些变量在运行时由 vite.config.ts 的 define 选项注入
 */
declare global {
  const __APP_VERSION__: string;
  const __BUILD_TIME__: string;
}

export {};
