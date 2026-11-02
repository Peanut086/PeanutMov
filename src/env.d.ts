/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 的 define 注入（AC-94） */
declare const __APP_VERSION__: any;
/** 构建时间（ISO 字符串），由 vite define 注入；用于「关于」页展示真实构建日期（REV-19） */
declare const __BUILD_TIME__: any;

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_DEMO_BASE?: string;
  readonly VITE_USE_MOCK?: string;
  readonly VITE_DEBUG_LOG?: string;
  readonly VITE_API_BASE?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

// v1.8: 添加 spider plugin 接口
/** SpiderPlugin 原生插件接口 */
interface SpiderPlugin {
  /** 设置详细日志开关 */
  setDebugLog(args: { enabled: boolean }): Promise<{ enabled: boolean }>;
  
  /** 获取当前详细日志状态 */
  getDebugLogStatus(): Promise<{ enabled: boolean }>;
  
  /** 清理过期日志 */
  cleanLogs(): Promise<{ cleanedCount: number }>;
  
  /** 加载爬虫源 */
  load(args: { jarUrl: string; api: string; initExt?: string; userAgent?: string }): Promise<{ handle: string }>;
  
  /** 调用爬虫方法 */
  invoke(args: { handle: string; method: string; args?: any[]; arrayArgs?: object }): Promise<{ json: string; logs: string[] }>;
  
  /** 代理请求 */
  proxy(args: { handle: string; url: string }): Promise<{ url: string | null; headers: Record<string, string> }>;
  
  /** 卸载爬虫源 */
  unload(args: { handle: string }): Promise<{ released: boolean }>;
  
  /** 检查支持性 */
  isSupported(): Promise<{ supported: boolean }>;
}

declare global {
  interface Navigator {
    spider: SpiderPlugin;
  }
}

export {};
