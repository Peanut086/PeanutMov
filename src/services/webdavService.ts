/**
 * WebDAV 客户端服务（功能扩展-4）
 *
 * 用于将备份文件上传到 WebDAV 云盘（如坚果云、Nextcloud 等）。
 * 仅实现备份所需的最小操作集：PUT/GET/PROPFIND/MKCOL/DELETE。
 */
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { basicAuthHeader } from '@/sources/base/httpClient';

export interface WebDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  /** 远程备份目录路径（相对于 serverUrl） */
  backupPath: string;
}

export interface WebDAVFileEntry {
  href: string;
  name: string;
  size: number;
  lastModified: number;
  isDirectory: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;

function joinUrl(base: string, path: string): string {
  const baseTrimmed = base.replace(/\/+$/, '');
  const pathTrimmed = path.replace(/^\/+/, '');
  return `${baseTrimmed}/${pathTrimmed}`;
}

function extractNameFromHref(href: string): string {
  const decoded = decodeURIComponent(href);
  const parts = decoded.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

/**
 * 解析 PROPFIND 响应的 XML（简易解析，不依赖 DOMParser 以兼容 Worker）
 */
function parsePropfindResponse(xml: string): WebDAVFileEntry[] {
  const entries: WebDAVFileEntry[] = [];
  const responseRegex = /<D:response[^>]*>([\s\S]*?)<\/D:response>/gi;
  let match;

  while ((match = responseRegex.exec(xml)) !== null) {
    const block = match[1];

    const hrefMatch = /<D:href[^>]*>([^<]+)<\/D:href>/i.exec(block);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];

    const isDir = /<D:collection/i.test(block);

    const sizeMatch = /<D:getcontentlength[^>]*>(\d+)<\/D:getcontentlength>/i.exec(block);
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

    const dateMatch = /<D:getlastmodified[^>]*>([^<]+)<\/D:getlastmodified>/i.exec(block);
    const lastModified = dateMatch ? Date.parse(dateMatch[1]) : 0;

    entries.push({
      href,
      name: extractNameFromHref(href),
      size,
      lastModified: Number.isFinite(lastModified) ? lastModified : 0,
      isDirectory: isDir,
    });
  }

  return entries;
}

async function requestWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new AppError('E_TIMEOUT', '请求超时');
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class WebDAVClient {
  private config: WebDAVConfig;

  constructor(config: WebDAVConfig) {
    this.config = { ...config };
  }

  private getAuthHeader(): string {
    return basicAuthHeader(this.config.username, this.config.password);
  }

  private getRemoteUrl(path?: string): string {
    if (!path) return joinUrl(this.config.serverUrl, this.config.backupPath);
    return joinUrl(this.config.serverUrl, path);
  }

  /**
   * 测试连接（PROPFIND 根目录）
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await requestWithTimeout(this.getRemoteUrl(), {
        method: 'PROPFIND',
        headers: {
          Authorization: this.getAuthHeader(),
          Depth: '0',
        },
      });
      return response.ok || response.status === 207;
    } catch (e) {
      logger.warn('WebDAV 连接测试失败', { error: String(e) });
      return false;
    }
  }

  /**
   * 确保远程目录存在（不存在则创建）
   */
  async ensureDirectory(path: string): Promise<void> {
    const url = this.getRemoteUrl(path);

    // 先检查是否存在
    const checkResponse = await requestWithTimeout(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: this.getAuthHeader(),
        Depth: '0',
      },
    });

    if (checkResponse.ok || checkResponse.status === 207) {
      return; // 目录已存在
    }

    if (checkResponse.status === 404) {
      // 目录不存在，尝试创建
      const createResponse = await requestWithTimeout(url, {
        method: 'MKCOL',
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!createResponse.ok && createResponse.status !== 405) {
        // 405 = Method Not Allowed，某些服务器目录已存在时返回此
        throw new AppError('E_NETWORK', `创建目录失败: ${createResponse.status}`);
      }
      return;
    }

    throw new AppError('E_NETWORK', `检查目录失败: ${checkResponse.status}`);
  }

  /**
   * 列出目录内容
   */
  async listDirectory(path?: string): Promise<WebDAVFileEntry[]> {
    const url = this.getRemoteUrl(path);

    const response = await requestWithTimeout(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: this.getAuthHeader(),
        Depth: '1',
      },
    });

    if (!response.ok && response.status !== 207) {
      throw new AppError('E_NETWORK', `列出目录失败: ${response.status}`);
    }

    const xml = await response.text();
    const entries = parsePropfindResponse(xml);

    // 过滤掉当前目录本身
    const currentPath = path ? decodeURIComponent(new URL(url).pathname) : new URL(url).pathname;
    return entries.filter((e) => decodeURIComponent(new URL(e.href, url).pathname) !== currentPath);
  }

  /**
   * 上传文件
   */
  async uploadFile(remotePath: string, content: Blob | string, contentType?: string): Promise<void> {
    const url = this.getRemoteUrl(remotePath);

    const response = await requestWithTimeout(url, {
      method: 'PUT',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: content,
    });

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      throw new AppError('E_NETWORK', `上传失败: ${response.status}`);
    }
  }

  /**
   * 下载文件
   */
  async downloadFile(remotePath: string): Promise<Blob> {
    const url = this.getRemoteUrl(remotePath);

    const response = await requestWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: this.getAuthHeader(),
      },
    });

    if (!response.ok) {
      throw new AppError('E_NETWORK', `下载失败: ${response.status}`);
    }

    return await response.blob();
  }

  /**
   * 删除文件
   */
  async deleteFile(remotePath: string): Promise<void> {
    const url = this.getRemoteUrl(remotePath);

    const response = await requestWithTimeout(url, {
      method: 'DELETE',
      headers: {
        Authorization: this.getAuthHeader(),
      },
    });

    if (!response.ok && response.status !== 204 && response.status !== 404) {
      throw new AppError('E_NETWORK', `删除失败: ${response.status}`);
    }
  }

  /**
   * 检查文件是否存在
   */
  async fileExists(remotePath: string): Promise<boolean> {
    const url = this.getRemoteUrl(remotePath);

    try {
      const response = await requestWithTimeout(url, {
        method: 'HEAD',
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<WebDAVConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置（脱敏）
   */
  getConfig(): Omit<WebDAVConfig, 'password'> & { password: string; passwordMasked: boolean } {
    return {
      ...this.config,
      password: '***',
      passwordMasked: true,
    };
  }
}

/**
 * 创建 WebDAV 客户端实例
 */
export function createWebDAVClient(config: WebDAVConfig): WebDAVClient {
  return new WebDAVClient(config);
}

/**
 * 验证 WebDAV 配置是否有效
 */
export async function validateWebDAVConfig(config: WebDAVConfig): Promise<{ valid: boolean; error?: string }> {
  if (!config.serverUrl) {
    return { valid: false, error: '服务器地址不能为空' };
  }

  try {
    new URL(config.serverUrl);
  } catch {
    return { valid: false, error: '服务器地址格式不正确' };
  }

  if (!config.username || !config.password) {
    return { valid: false, error: '用户名和密码不能为空' };
  }

  const client = new WebDAVClient(config);
  const connected = await client.testConnection();

  if (!connected) {
    return { valid: false, error: '无法连接到 WebDAV 服务器' };
  }

  return { valid: true };
}
