/**
 * 自定义投屏插件 `CastShare` 的 JS 代理（技术方案 10.4）
 *
 * Android 端由 PKG-A 实现 `CastSharePlugin.java`（FileProvider + ACTION_SEND）。
 * Web / 插件缺失时，`registerPlugin` 会返回一个"调用即抛错"的代理，
 * 本模块把错误转换为 `{ started:false, reason }`，调用方无需 try/catch。
 */
import { registerPlugin } from '@capacitor/core';

import { logger } from '@/shared/logger';

export interface ShareFileOptions {
  /** 应用私有目录相对路径，如 `downloads/{mediaId}/{episodeId}.mp4` */
  path: string;
  mime: string;
  title: string;
  /** 可选文本（分享附带文案） */
  text?: string;
}

export interface ShareUrlOptions {
  url: string;
  title: string;
  mime?: string;
}

export interface CastSharePlugin {
  shareFile(options: ShareFileOptions): Promise<{ started: boolean }>;
  shareUrl(options: ShareUrlOptions): Promise<{ started: boolean }>;
  isSupported(): Promise<{ supported: boolean }>;
}

export const CastShare = registerPlugin<CastSharePlugin>('CastShare');

/** 插件是否可用（原生 + 方法存在） */
export async function isCastShareAvailable(): Promise<boolean> {
  try {
    const result = await CastShare.isSupported();
    return result.supported === true;
  } catch (e) {
    logger.debug('CastShare 插件不可用', e);
    return false;
  }
}

/** 分享本地文件；失败抛出（调用方 castService 负责转成 CastResult） */
export async function shareFile(options: ShareFileOptions): Promise<boolean> {
  const result = await CastShare.shareFile(options);
  return result.started !== false;
}

/** 分享远程链接 */
export async function shareUrl(options: ShareUrlOptions): Promise<boolean> {
  const result = await CastShare.shareUrl(options);
  return result.started !== false;
}
