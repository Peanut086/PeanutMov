/**
 * drpy 规则插件 `Drpy` 的 JS 代理（CHG-16）
 *
 * Android 端由 `DrpyPlugin.java` + `DrpyRuntime.java`（QuickJS）+ `assets/drpy_host.js`
 * 实现：下载规则文件 → 每条规则一个独立 QuickJS 实例 →
 * `invoke` 按编排方法（home/category/detail/search/play）返回 TVBox JSON。
 *
 * 前端 SpiderAdapter 对 `ext.kind === 'js'` 的源路由到这里，
 * 返回结构与 jar 爬虫（`SpiderPlugin`）完全一致，解析口径不重复实现。
 */
import { registerPlugin } from '@capacitor/core';

import { logger } from '@/shared/logger';

/** drpy 编排方法名（对应 drpy_host.js 的 __drpyCall 分支） */
export type DrpyMethod = 'home' | 'category' | 'detail' | 'search' | 'play';

export interface DrpyLoadOptions {
  /** 规则文件地址（前端先试 initExt 再试 baseUrl，含镜像变体逐个尝试） */
  ruleUrl?: string;
  /** 直接给规则源码（ruleUrl 与 ruleText 二选一） */
  ruleText?: string;
  /** 传给规则的 ext（TVBox 约定，通常为订阅条目的 ext 原文） */
  initExt?: string | null;
}

export interface DrpyInvokeOptions {
  /** 加载时返回的实例句柄 */
  handle: string;
  method: DrpyMethod;
  /** 单个 JSON 字符串参数（各方法的字段见 SpiderAdapter 的 drpy 路由） */
  arg?: string;
}

export interface DrpyInvokeResult {
  json: string | null;
  /** 规则执行期日志（req/dom 失败等，供排查） */
  logs?: string[];
}

export interface DrpyPlugin {
  load(options: DrpyLoadOptions): Promise<{ handle: string }>;
  invoke(options: DrpyInvokeOptions): Promise<DrpyInvokeResult>;
  unload(options: { handle: string }): Promise<{ released: boolean }>;
  isSupported(): Promise<{ supported: boolean }>;
}

export const Drpy = registerPlugin<DrpyPlugin>('Drpy');

export async function isDrpyAvailable(): Promise<boolean> {
  try {
    const result = await Drpy.isSupported();
    return result.supported === true;
  } catch (e) {
    logger.debug('Drpy 插件不可用', e);
    return false;
  }
}
