/**
 * 投屏服务（API-11）
 *
 * 首版仅"系统 Intent 分享"：
 * - Android：自定义插件 `CastShare`（PKG-A 实现原生侧）；
 * - Web：`navigator.share` 可用则调用，否则 `isSupported() = false`，
 *   `cast()` 返回 `{ started:false, reason:'unsupported-platform' }` 且**不抛异常**（AC-82）。
 */
import { isCastShareAvailable, shareFile, shareUrl } from '@/native/castPlugin';
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
}

/** Web Share API（TS DOM 库已含 share/canShare，这里只做存在性判断，避免可选性冲突） */
type WebNavigator = Navigator;

function webNavigator(): WebNavigator | null {
  if (typeof navigator === 'undefined') return null;
  return navigator;
}

function hasWebShare(nav: WebNavigator | null): nav is Navigator {
  return nav !== null && typeof nav.share === 'function';
}

export const castService: CastService = {
  async isSupported(): Promise<boolean> {
    if (isNative()) {
      return isCastShareAvailable();
    }
    return hasWebShare(webNavigator());
  },

  async cast(req: CastRequest): Promise<CastResult> {
    if (!req.url) {
      return { started: false, reason: 'no-target', error: null };
    }

    if (isNative()) {
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
    }

    const nav = webNavigator();
    if (!hasWebShare(nav)) {
      return { started: false, reason: 'unsupported-platform', error: null };
    }

    try {
      if (req.kind === 'url') {
        const url = req.linkedUrl ?? req.url;
        const can = typeof nav.canShare === 'function' ? nav.canShare({ url }) : true;
        if (!can) {
          await nav.share({ title: req.title, text: url });
        } else {
          await nav.share({ title: req.title, url });
        }
      } else {
        await nav.share({ title: req.title, text: req.url });
      }
      return { started: true, reason: null, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/abort|cancel|dismiss/i.test(message)) {
        return { started: false, reason: 'canceled', error: null };
      }
      return { started: false, reason: 'error', error: toErrorShape(e) };
    }
  },
};

export type { CastService as CastServiceContract };
