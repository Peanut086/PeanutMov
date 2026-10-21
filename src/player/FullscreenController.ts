/**
 * 全屏控制（技术方案 9.5）
 *
 * - Web：Fullscreen API（容器元素）；失败或不支持时回退为 CSS 全屏（fixed inset: 0）
 * - 原生：CSS 全屏 + 状态栏隐藏 + 横屏锁定（均静默降级）
 * - 统一 `onChange` 回调，View 只需绑定按钮与状态
 */
import { isNative } from '@/shared/platform';

export interface FullscreenHooks {
  onChange: (fullscreen: boolean) => void;
  /** 进入/退出时调用（原生状态栏、屏幕常亮等） */
  onEnter?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
}
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozFullScreenElement?: Element | null;
  mozCancelFullScreen?: () => Promise<void> | void;
};

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
};

export class FullscreenController {
  private active = false;
  private cssFallback = false;
  private listeners: Array<() => void> = [];

  constructor(private readonly hooks: FullscreenHooks) {}

  get isActive(): boolean {
    return this.active;
  }

  /** 绑定原生 fullscreenchange（构造后调用一次） */
  bind(): void {
    if (typeof document === 'undefined') return;
    const handler = (): void => {
      if (this.cssFallback) return;
      const fsEl = this.fullscreenElement();
      const next = fsEl !== null && fsEl === this.element;
      if (next !== this.active) {
        this.active = next;
        this.hooks.onChange(next);
        if (next) this.runHook(this.hooks.onEnter);
        else this.runHook(this.hooks.onExit);
      }
    };
    const doc = document as FsDocument;
    doc.addEventListener('fullscreenchange', handler);
    doc.addEventListener('webkitfullscreenchange', handler);
    this.listeners.push(() => {
      doc.removeEventListener('fullscreenchange', handler);
      doc.removeEventListener('webkitfullscreenchange', handler);
    });
  }

  private element: HTMLElement | null = null;

  /**
   * 安全执行生命周期钩子（AC-52）。
   *
   * 进入/退出全屏时的附带动作（隐藏状态栏、锁横屏等）**不得阻断全屏**：
   * 同步异常与 Promise reject 都在这里吞掉，只留 `console.warn` 便于排查。
   */
  private runHook(hook: (() => void | Promise<void>) | undefined): void {
    if (!hook) return;
    try {
      const result = hook();
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch((e: unknown) => {
          console.warn('[fullscreen] 全屏附带动作失败（已忽略）', e);
        });
      }
    } catch (e) {
      console.warn('[fullscreen] 全屏附带动作失败（已忽略）', e);
    }
  }

  setElement(el: HTMLElement | null): void {
    this.element = el;
  }

  async enter(): Promise<void> {
    if (this.active) return;
    if (isNative() || !this.element) {
      this.applyCssFallback(true);
      return;
    }
    const el = this.element as FsElement;
    try {
      const request =
        el.requestFullscreen?.bind(el) ??
        el.webkitRequestFullscreen?.bind(el) ??
        el.mozRequestFullScreen?.bind(el);
      if (!request) {
        this.applyCssFallback(true);
        return;
      }
      await request();
      this.active = true;
      this.hooks.onChange(true);
      // 状态栏/横屏等附带动作失败不影响全屏本身（AC-52）
      this.runHook(this.hooks.onEnter);
    } catch {
      this.applyCssFallback(true);
    }
  }

  async exit(): Promise<void> {
    if (!this.active) return;
    if (this.cssFallback) {
      this.applyCssFallback(false);
      return;
    }
    const doc = document as FsDocument;
    try {
      const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc) ?? doc.mozCancelFullScreen?.bind(doc);
      if (exit) await exit();
    } catch {
      /* 已在非全屏状态时浏览器会抛错，忽略 */
    }
    this.active = false;
    this.hooks.onChange(false);
    this.runHook(this.hooks.onExit);
  }

  async toggle(): Promise<void> {
    if (this.active) await this.exit();
    else await this.enter();
  }

  destroy(): void {
    this.listeners.forEach((off) => off());
    this.listeners = [];
    if (this.active) void this.exit();
    this.cssFallback = false;
    this.element = null;
  }

  private fullscreenElement(): Element | null {
    const doc = document as FsDocument;
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.mozFullScreenElement ?? null;
  }

  private applyCssFallback(on: boolean): void {
    this.cssFallback = on;
    this.active = on;
    this.hooks.onChange(on);
    if (on) this.runHook(this.hooks.onEnter);
    else this.runHook(this.hooks.onExit);
  }
}
