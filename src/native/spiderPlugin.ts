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

/**
 * P0-1：单条退出现场读数。字段与原生 `SpiderExitLedger` / `MainApplication` 的
 * `CrashExit` 日志行一一对应，治理判定（构件指纹 + API + 阶段 + 退出证据）看的就是这些。
 */
export interface SpiderExitEvidence {
  ts: number;
  pid: number;
  /** 崩溃线程 id；跨进程写回的证据没有该字段（-1） */
  tid?: number;
  threadName?: string;
  /** 构件指纹（jarMd5） */
  jarHash?: string;
  /** 订阅配置里的爬虫类名 */
  api?: string;
  /** 阶段：spider.load / spider.invoke:playContent / spider.proxy:do … */
  phase?: string;
  /** java:<异常类名> / aei:REASON_* / native:tombstone */
  exitReason?: string;
  /** SIGSEGV / SIGABRT …；Java 退出与无法读取时为 `-` */
  signal?: string;
  /** NONE / COOLDOWN / QUARANTINE / QUARANTINE_JAR */
  responseTier?: string;
  /** 异常原文摘要（已截断，不含 URL/token） */
  detail?: string;
  /** true = 上一次进程留下的证据（本次启动归因后写回） */
  fromPreviousProcess?: boolean;
}

export interface SpiderPlugin {
  /** 加载/初始化爬虫实例；重复加载同一 jar 复用缓存。`native` 标记该 jar 是否自带原生库 */
  load(options: SpiderLoadOptions): Promise<{ handle: string; native?: boolean }>;
  /** 调用调用爬虫方法，返回 JSON 字符串 */
  invoke(options: SpiderInvokeOptions): Promise<SpiderInvokeResult>;
  /** 走爬虫代理取内容地址 */
  proxy(options: { handle: string; url: string; headers?: Record<string, string> }): Promise<SpiderProxyResult>;
  /** 释放实例 */
  unload(options: { handle: string }): Promise<{ released: boolean }>;
  /** 设置本地代理当前归属的爬虫句柄（避免多爬虫场景下代理请求被错误路由） */
  setCurrentOwner(options: { handle: string | null }): Promise<{ owner: string | null }>;
  /** 插件是否可用（原生环境恒 true） */
  isSupported(): Promise<{ supported: boolean }>;
  /** 查询安全模式状态（近期多次崩溃后原生会暂停爬虫加载） */
  getSafeMode(): Promise<{ active: boolean }>;
  /**
   * F4：查询预热降级状态。`throttled` 在原生崩溃签名 24h 内复发 ≥2 次后置真，
   * 前端据此把带原生库的源的预热改为串行延后（见 libraryService.warmupSources）。
   */
  getPrewarmState(): Promise<{ throttled: boolean; safeMode: boolean }>;
  /** 手动退出安全模式并清空崩溃历史，恢复爬虫源加载 */
  exitSafeMode(): Promise<{ ok: boolean }>;
  /**
   * REV-24：查询当前崩溃隔离名单（同 jar+api 签名 24h 内崩 2 次→隔 7 天）。
   * `items` 为隔离签名数组（形如 `spider:<jarMd5>:<api>` 或 `spider:<jarMd5>:*`）。
   *
   * P0-1：`cooldowns` 是「短时冷却」档——单次可疑崩溃（无 tombstone 实锤）只拦 30 分钟，
   * 不占用隔离名单，所以必须单独列出，否则健康中心会显示「没有隔离任何源」而源仍然打不开。
   * `remainMs` 为距自动放行的剩余毫秒。
   */
  getQuarantined(): Promise<{
    items: string[];
    cooldowns: Array<{ signature: string; remainMs: number }>;
  }>;
  /** REV-24：手动解除某个签名的隔离（冷却档一并清除：一次点击就放行到底） */
  unquarantine(options: { signature: string }): Promise<{ ok: boolean }>;
  /**
   * P0-1：退出现场读数（本轮内存台账 + 上次启动写回的 AEI / tombstone 证据）。
   *
   * 覆盖面要诚实：原生信号能直接杀死进程，那一半当场来不及记录，只能在下次启动归因后读到；
   * 实时可拉的是被 catch 住的那一半（构件级 LinkageError、proxy 里被吞掉的异常）——
   * 这部分过去在日志里完全隐身，坏构件因此永远隔离不掉。
   */
  getRecentExits(): Promise<{ items: SpiderExitEvidence[] }>;
  /** 设置详细日志开关 */
  setDebugLog(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  /** 获取日志状态（开关、文件数、总字节、保留天数） */
  getDebugLogStatus(): Promise<{
    enabled: boolean;
    fileCount: number;
    totalBytes: number;
    retentionDays: number;
  }>;
  /** 清理过期日志 */
  cleanLogs(): Promise<{ cleanedCount: number; freedBytes: number }>;
  /** 清空全部日志 */
  clearAllLogs(): Promise<{ ok: boolean }>;
  /** 列出所有日志文件 */
  listLogFiles(): Promise<{
    files: Array<{ name: string; size: number; mtime: number }>;
  }>;
  /** 导出日志（scope: all/crash/today/recent1h，合并为单文件，返回 FileProvider URI） */
  exportLogs(options?: { scope?: string }): Promise<{ uri: string; path: string; size: number }>;
  /** 增量读取日志文件尾部 */
  readLogTail(options: { file?: string; offset?: number; maxBytes?: number }): Promise<{
    file: string;
    size: number;
    offset: number;
    text: string;
    reset: boolean;
  }>;
  /** 全量读取日志文件（.gz 解压），offset 为字符偏移，分块拉取直到 eof */
  readLogRange(options: { file?: string; offset?: number; maxBytes?: number }): Promise<{
    file: string;
    size: number;
    offset: number;
    byteOffset: number;
    text: string;
    eof: boolean;
  }>;
  /** 批量写入 JS 侧日志 */
  appendLogs(options: {
    entries: Array<{ level: string; tag: string; message: string; ts: number }>;
    source?: string;
  }): Promise<{ written: number }>;
  /** 崩溃/退出事件列表（tombstones + java-crash 环形栈 + ApplicationExitInfo 合并去重） */
  getCrashEvents(): Promise<{
    events: Array<{
      id: string;
      kind: string;
      ts: number;
      source: string;
      title: string;
      detail: string;
    }>;
  }>;
  /** 单个崩溃事件全文（详情抽屉用） */
  getCrashDetail(options: { id: string }): Promise<{
    id: string;
    kind: string;
    ts: number;
    source: string;
    title: string;
    text: string;
  }>;
  /** 单事件取证导出：全文 + ±windowMinutes 日志上下文合成一个分享文件 */
  exportCrashEvent(options: { id: string; windowMinutes?: number }): Promise<{
    uri: string;
    path: string;
    size: number;
  }>;
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
