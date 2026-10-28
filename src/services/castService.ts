/**
 * 投屏服务（API-11）
 *
 * 首版仅"系统 Intent 分享"，语义是**系统投屏/分享**，不是浏览器 Web Share：
 * - Android：自定义插件 `CastShare`（PKG-A 实现原生侧）；
 * - Web：**一律不支持**（`isSupported() = false`，`cast()` 返回
 *   `{ started:false, reason:'unsupported-platform' }` 且不抛异常）。
 *   AC-82/AC-84 明确要求 Web 环境按钮禁用并提示"当前环境不支持系统投屏（仅 Android App 可用）"，
 *   而 `navigator.share` 只是网页分享能力，不能当作系统投屏（REV-08）。
 */
import { isCastShareAvailable, openExternal, shareFile, shareUrl } from '@/native/castPlugin';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { toErrorShape } from '@/shared/errors';
import type { AppErrorShape } from '@/types';

export type CastKind = 'file' | 'url';

export interface CastRequest {
  kind: CastKind;
  /** kind=file 时为本地绝对路径（Filesystem Data 目录相对路径也可） */
  url: string;
  mime: string;
  title: string;
  /** kind=url 时附带的原始链接 */
  linkedUrl?: string | null;
}

export interface CastResult {
  started: boolean;
  /** started=false 的原因，UI 据此提示 */
  reason: 'unsupported-platform' | 'no-target' | 'canceled' | 'error' | null;
  error: AppErrorShape | null;
}

export interface CastService {
  isSupported(): Promise<boolean>;
  cast(req: CastRequest): Promise<CastResult>;
  /**
   * 用系统 Intent 打开外部 scheme（P1-4：磁力链接交给下载器/播放器）。
   * Web 一律 `unsupported-platform`，不抛异常。
   */
  openExternal(url: string): Promise<CastResult>;
}

/** Web / 非原生容器的统一降级提示（AC-82） */
export const CAST_UNSUPPORTED_MESSAGE = '当前环境不支持系统投屏（仅 Android App 可用）';

export const castService: CastService = {
  async isSupported(): Promise<boolean> {
    // Web 一律 false：Web Share 不等于系统投屏（AC-84 / REV-08）
    if (!isNative()) return false;
    return isCastShareAvailable();
  },

  async cast(req: CastRequest): Promise<CastResult> {
    // Web：直接降级，不抛异常（AC-82）
    if (!isNative()) {
      return { started: false, reason: 'unsupported-platform', error: null };
    }

    if (!req.url) {
      return { started: false, reason: 'no-target', error: null };
    }

    if (!(await isCastShareAvailable())) {
      return { started: false, reason: 'unsupported-platform', error: null };
    }
    try {
      const started =
        req.kind === 'file'
          ? await shareFile({ path: req.url, mime: req.mime, title: req.title })
          : await shareUrl({ url: req.linkedUrl ?? req.url, title: req.title, mime: req.mime });
      return started
        ? { started: true, reason: null, error: null }
        : { started: false, reason: 'canceled', error: null };
    } catch (e) {
      const error = toErrorShape(e);
      const canceled = /cancel|abort|dismiss/i.test(error.message);
      if (canceled) return { started: false, reason: 'canceled', error: null };
      logger.warn('系统分享失败', error);
      return { started: false, reason: 'error', error };
    }
  },

  async openExternal(url: string): Promise<CastResult> {
    if (!isNative()) return { started: false, reason: 'unsupported-platform', error: null };
    if (!url) return { started: false, reason: 'no-target', error: null };
    if (!(await isCastShareAvailable())) {
      return { started: false, reason: 'unsupported-platform', error: null };
    }
    try {
      const started = await openExternal(url);
      return started
        ? { started: true, reason: null, error: null }
        : { started: false, reason: 'error', error: null };
    } catch (e) {
      const error = toErrorShape(e);
      logger.warn('外部打开失败', error);
      return { started: false, reason: 'error', error };
    }
  },
};

export type { CastService as CastServiceContract };
