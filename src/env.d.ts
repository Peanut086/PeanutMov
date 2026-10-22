/// <reference types="vite/client" />

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

/** 构建时由 vite.config.ts 的 define 注入（AC-94） */
declare const __APP_VERSION__: string;
/** 构建时间（ISO 字符串），由 vite define 注入；用于「关于」页展示真实构建日期（REV-19） */
declare const __BUILD_TIME__: string;

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
