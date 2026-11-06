/**
 * 网盘账号插件 `Netdisk` 的 JS 代理
 *
 * P1: 登录 WebView、cookie 持久化、回读自检
 * P2: 多平台抽象
 * P3: 启动静默校验、过期提示
 */
import { registerPlugin } from '@capacitor/core';
import { logger } from '@/shared/logger';

export interface HasAllFilesAccessResult {
  granted: boolean;
}

export interface WriteCookieFileResult {
  success: boolean;
  path: string;
}

export interface ReadCookieFileResult {
  success: boolean;
  exists: boolean;
  content?: string;
  path?: string;
}

export interface BackupCookieFileResult {
  success: boolean;
  exists?: boolean;
  path?: string;
}

/**
 * 登录页返回结果（R-DEV04-05 / AND-06 / AND-07）
 *
 * - `success=false`：用户取消或夸克账号校验失败，此时不会写入 cookie 文件；
 * - `success=true && verified=false`：cookie 已保存，但该平台不支持账号校验
 *   （夸克以外平台），调用方必须展示「已保存，账号未验证」而不是「登录成功」。
 */
export interface LoginWebViewResult {
  success: boolean;
  verified: boolean;
  nickname: string | null;
  memberType: string | null;
  note: string | null;
}

export interface NetdiskPluginInterface {
  hasAllFilesAccess(): Promise<HasAllFilesAccessResult>;
  requestAllFilesAccess(): Promise<void>;
  writeCookieFile(options: { platform: string; content: string }): Promise<WriteCookieFileResult>;
  readCookieFile(options: { platform: string }): Promise<ReadCookieFileResult>;
  loginWebView(options: { platform: string; loginUrl: string }): Promise<LoginWebViewResult>;
  backupCookieFile(options: { platform: string }): Promise<BackupCookieFileResult>;
  restoreCookieFile(options: { platform: string }): Promise<BackupCookieFileResult>;
}

const Netdisk = registerPlugin<NetdiskPluginInterface>('Netdisk', {
  web: () => import('./netdiskPlugin.web').then(m => new m.NetdiskWeb()),
});

/**
 * 检查是否拥有所有文件访问权限
 */
export async function hasAllFilesAccess(): Promise<boolean> {
  try {
    const result = await Netdisk.hasAllFilesAccess();
    return result.granted;
  } catch (e) {
    logger.error('Failed to check all-files access', e);
    return false;
  }
}

/**
 * 请求所有文件访问权限
 */
export async function requestAllFilesAccess(): Promise<void> {
  try {
    await Netdisk.requestAllFilesAccess();
  } catch (e) {
    logger.error('Failed to request all-files access', e);
    throw e;
  }
}

/**
 * 写入 cookie 文件
 */
export async function writeCookieFile(platform: string, content: string): Promise<string> {
  try {
    const result = await Netdisk.writeCookieFile({ platform, content });
    if (!result.success) {
      throw new Error('写入失败');
    }
    return result.path;
  } catch (e) {
    logger.error('Failed to write cookie file', e);
    throw e;
  }
}

/**
 * 读取 cookie 文件
 */
export async function readCookieFile(platform: string): Promise<{ exists: boolean; content?: string }> {
  try {
    const result = await Netdisk.readCookieFile({ platform });
    return {
      exists: result.exists,
      content: result.content,
    };
  } catch (e) {
    logger.error('Failed to read cookie file', e);
    return { exists: false };
  }
}

/**
 * 启动登录页并等待结果（R-DEV04-05）
 *
 * 原生侧 `loginWebView` 会阻塞到登录页关闭，返回
 * `{ success, verified, nickname, memberType, note }`；
 * 这里补齐缺省字段，调用方据此区分「登录成功」「已保存但未验证」「未登录」。
 */
export async function loginWebView(platform: string, loginUrl: string): Promise<LoginWebViewResult> {
  try {
    const result = await Netdisk.loginWebView({ platform, loginUrl });
    return {
      success: result?.success === true,
      verified: result?.verified === true,
      nickname: result?.nickname ?? null,
      memberType: result?.memberType ?? null,
      note: result?.note ?? null,
    };
  } catch (e) {
    logger.error('Failed to launch login WebView', e);
    throw e;
  }
}

/**
 * P3-3: 备份 cookie 文件到应用私有目录
 */
export async function backupCookieFile(platform: string): Promise<boolean> {
  try {
    const result = await Netdisk.backupCookieFile({ platform });
    return result.success;
  } catch (e) {
    logger.error('Failed to backup cookie file', e);
    return false;
  }
}

/**
 * P3-3: 从备份恢复 cookie 文件
 */
export async function restoreCookieFile(platform: string): Promise<boolean> {
  try {
    const result = await Netdisk.restoreCookieFile({ platform });
    return result.success;
  } catch (e) {
    logger.error('Failed to restore cookie file', e);
    return false;
  }
}

export { Netdisk };
