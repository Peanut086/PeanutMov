/**
 * 爬虫源插件 `Spider` 的 JS 代理
 *
 * Android 端由 `SpiderPlugin.java` + TVBox 框架 stub（`Spider`/`SpiderApi`/`SpiderDebug`）
 * 实现：下载 jar → md5 校验 → `DexClassLoader` 加载 → 反射调用爬虫方法。
 *
 * Web / 插件缺失时 `registerPlugin` 返回"调用即抛错"的代理，
 * 本模块把错误统一转成 `{ ok:false, reason }`，调用方（SpiderAdapter）无需 try/catch。
 */
import { registerPlugin } from '@capacitor/core';

import { logger } from '@/shared/logger';

/** 爬虫方法名（对应 TVBox `Spider` 子类的覆写） */
export type SpiderMethod =
  | 'homeContent'
  | 'categoryContent'
  | 'detailContent'
  | 'searchContent'
  | 'playerContent';

export interface SpiderLoadOptions {
  /** 爬虫 jar 地址，可带 `;md5;hash` 后缀 */
  jarUrl: string;
  /** jar 内的爬虫类名，如 `csp_XBPQ`；实际类为 `com.github.catvod.spider.{name}` */
  api: string;
  /** 传给 `Spider.init(context, ext)` 的原始 ext 字符串 */
  initExt?: string | null;
  /** 并发执行时的自定义 header 注入点（预留） */
  userAgent?: string | null;
}

export interface SpiderInvokeOptions {
  /** 加载时返回的实例句柄 */
  handle: string;
  method: SpiderMethod;
  /** 与 TVBox 方法签名对齐的位置参数（数组用于 List 形参） */
  args?: Array<string | number | boolean | Record<string, string> | string[]>;
  /**
   * 数组参数的显式声明。
   * Capacitor 桥接会把嵌套数组展平成字符串（`['1']` → `"1"`），
   * 因此 List 形参（`detailContent` 的 ids、`playerContent` 的 vipFlags）
   * 必须通过 `arrayArgs` 按位置下标传入。
   */
  arrayArgs?: Record<number, string[]>;
}

/** 一次爬虫调用的结果：`json` 是爬虫返回的 JSON 字符串 */
export interface SpiderInvokeResult {
  json: string | null;
  /** 爬虫内部日志（最近若干条，供排查） */
  logs?: string[];
}

/** 代理流请求（爬虫的 `proxy()`，用于图片防盗链与嗅探） */
export interface SpiderProxyResult {
  /** 最终内容地址（原生侧重定向后的直链） */
  url: string | null;
  headers: Record<string, string>;
}

export interface SpiderPlugin {
  /** 加载/初始化爬虫实例；重复加载同一 jar 复用缓存 */
  load(options: SpiderLoadOptions): Promise<{ handle: string }>;
  /** 调用爬虫方法，返回 JSON 字符串 */
  invoke(options: SpiderInvokeOptions): Promise<SpiderInvokeResult>;
  /** 走爬虫代理取内容地址 */
  proxy(options: { handle: string; url: string; headers?: Record<string, string> }): Promise<SpiderProxyResult>;
  /** 释放实例 */
  unload(options: { handle: string }): Promise<{ released: boolean }>;
  /** 插件是否可用（原生环境恒 true） */
  isSupported(): Promise<{ supported: boolean }>;
}

export const Spider = registerPlugin<SpiderPlugin>('Spider');

export async function isSpiderAvailable(): Promise<boolean> {
  try {
    const result = await Spider.isSupported();
    return result.supported === true;
  } catch (e) {
    logger.debug('Spider 插件不可用', e);
    return false;
  }
}

/** 调用失败时抛出（SpiderAdapter 负责转成 AppError） */
export async function spiderInvoke(options: SpiderInvokeOptions): Promise<SpiderInvokeResult> {
  return Spider.invoke(options);
}
