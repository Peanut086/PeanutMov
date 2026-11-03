/**
 * 横竖屏方向控制（技术方案 9.5）
 *
 * - 原生（Capacitor ScreenOrientation 可用）：`lock('landscape')` / `lock('portrait')`
 * - Web：只做 CSS 层适配，`screen.orientation.lock` 在多数浏览器会抛错，静默降级
 *
 * 全部方法不抛异常：能力不可用时是无操作（no-op），UI 不因此报错。
 */
import { isNative } from '@/shared/platform';

export type Orientation = 'portrait' | 'landscape' | null;

type ScreenOrientationLike = {
  lock?: (o: string) => Promise<void>;
  unlock?: () => void;
  type?: string;
};

export class OrientationController {
  private current: Orientation = null;
  private cleanup: (() => void) | null = null;

  async lock(orientation: 'portrait' | 'landscape'): Promise<void> {
    this.current = orientation;
    if (isNative()) {
      try {
        const { ScreenOrientation } = await import('@capacitor/screen-orientation');
        await ScreenOrientation.lock({ orientation: orientation === 'landscape' ? 'landscape' : 'portrait' });
        this.cleanup = () => {
          void ScreenOrientation.unlock().catch(() => undefined);
        };
        return;
      } catch {
        /* 插件缺失：退化为 Web 逻辑 */
      }
    }
    const so = (globalThis.screen as Screen & { orientation?: ScreenOrientationLike } | undefined)?.orientation;
    if (so?.lock) {
      try {
        await so.lock(orientation);
        this.cleanup = () => so.unlock?.();
        return;
      } catch {
        /* 浏览器拒绝锁定（非全屏/不支持）：静默降级 */
      }
    }
  }

  async unlock(): Promise<void> {
    this.current = null;
    if (this.cleanup) {
      try {
        this.cleanup();
      } catch {
        /* ignore */
      }
      this.cleanup = null;
    }
    if (isNative()) {
      try {
        const { ScreenOrientation } = await import('@capacitor/screen-orientation');
        await ScreenOrientation.unlock();
      } catch {
        /* ignore */
      }
    }
  }

  get locked(): Orientation {
    return this.current;
  }

  /** 当前是否为横屏（用于控制条布局切换，仅作初值；实际以 CSS 媒体查询为准） */
  static isLandscapeViewport(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return w > h;
  }

  destroy(): void {
    // CHG-29：销毁时锁定竖屏而非 unlock，避免把方向控制权交还给传感器。
    void this.lock('portrait');
  }
}
