/**
 * Netdisk 插件的 Web 端实现（占位）
 *
 * Web 端不支持网盘登录功能，所有方法抛出错误。
 */
import type { NetdiskPluginInterface, WriteCookieFileResult, ReadCookieFileResult, BackupCookieFileResult, LoginWebViewResult } from './netdiskPlugin';

export class NetdiskWeb implements NetdiskPluginInterface {
  async hasAllFilesAccess() {
    return { granted: false };
  }

  async requestAllFilesAccess() {
    throw new Error('Web 端不支持所有文件访问权限');
  }

  async writeCookieFile(_options: { platform: string; content: string }): Promise<WriteCookieFileResult> {
    throw new Error('Web 端不支持写入 cookie 文件');
  }

  async readCookieFile(_options: { platform: string }): Promise<ReadCookieFileResult> {
    return { success: false, exists: false };
  }

  async loginWebView(_options: { platform: string; loginUrl: string }): Promise<LoginWebViewResult> {
    throw new Error('Web 端不支持登录 WebView');
  }

  async backupCookieFile(_options: { platform: string }): Promise<BackupCookieFileResult> {
    return { success: false, exists: false };
  }

  async restoreCookieFile(_options: { platform: string }): Promise<BackupCookieFileResult> {
    return { success: false, exists: false };
  }
}
