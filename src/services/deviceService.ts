/**
 * 设备服务（API-12）
 *
 * 跨 Web / Android 统一：
 * - 亮度手势调整的是"画面遮罩层不透明度"（0~100，100 = 无遮罩），不改系统亮度；
 * - 横竖屏/状态栏/常亮在 Web 下为 no-op；
 * - 网络与应用状态由 `@/native/network`、`@/native/appLifecycle` 提供；
 * - 返回键在 Web 下注册无效监听（回调仍可被业务主动查询）。
 */
import { KeepAwake } from '@capacitor-community/keep-awake';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';

import { DIM_MAX_PERCENT } from '@/shared/constants';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import {
  exitApp as exitLifecycleApp,
  onAppStateChange as onLifecycleState,
  onBackButton as onLifecycleBack,
  type AppLifecycleState,
} from '@/native/appLifecycle';
import {
  getNetworkStatus as readNetworkStatus,
  onNetworkChange as onNetwork,
  type NetworkStatus,
} from '@/native/network';

export type { NetworkStatus };

export interface DeviceService {
  isNative(): boolean;
  /** 设置画面亮度 0~100（Web/Android 均通过遮罩实现，不改系统亮度） */
  setDim(percent: number): Promise<void>;
  getDim(): number;
  lockOrientation(orientation: 'portrait' | 'landscape' | null): Promise<void>;
  setStatusBarVisible(visible: boolean): Promise<void>;
  keepAwake(on: boolean): Promise<void>;
  getNetworkStatus(): Promise<NetworkStatus>;
  onNetworkChange(cb: (s: NetworkStatus) => void): () => void;
  /** App 退后台/回前台（Web 用 visibilitychange 兜底） */
  onAppStateChange(cb: (state: 'active' | 'background') => void): () => void;
  /** 返回 true 表示已处理 */
  onBackButton(cb: () => boolean): () => void;
  exitApp(): void;
}

/** 当前遮罩不透明度（0 = 完全黑，100 = 正常亮度） */
let dimPercent = 100;
let awakeActive = false;

function clampDim(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  // 产品设定：最低保留 20% 亮度（DIM_MAX_PERCENT = 80 表示遮罩最多 80%）
  const floor = 100 - DIM_MAX_PERCENT;
  return Math.min(100, Math.max(floor, Math.round(percent)));
}

export const deviceService: DeviceService = {
  isNative(): boolean {
    return isNative();
  },

  async setDim(percent: number): Promise<void> {
    dimPercent = clampDim(percent);
  },

  getDim(): number {
    return dimPercent;
  },

  async lockOrientation(orientation: 'portrait' | 'landscape' | null): Promise<void> {
    if (!isNative()) return;
    try {
      if (orientation === null) {
        await ScreenOrientation.unlock();
      } else {
        await ScreenOrientation.lock({ orientation });
      }
    } catch (e) {
      logger.warn('横竖屏锁定失败（忽略）', e);
    }
  },

  async setStatusBarVisible(visible: boolean): Promise<void> {
    if (!isNative()) return;
    try {
      if (visible) await StatusBar.show();
      else await StatusBar.hide();
    } catch (e) {
      logger.warn('状态栏切换失败（忽略）', e);
    }
  },

  async keepAwake(on: boolean): Promise<void> {
    if (!isNative()) {
      awakeActive = on;
      return;
    }
    if (on === awakeActive) return;
    try {
      if (on) await KeepAwake.keepAwake();
      else await KeepAwake.allowSleep();
      awakeActive = on;
    } catch (e) {
      logger.warn('常亮切换失败（忽略）', e);
    }
  },

  async getNetworkStatus(): Promise<NetworkStatus> {
    return readNetworkStatus();
  },

  onNetworkChange(cb: (s: NetworkStatus) => void): () => void {
    return onNetwork(cb);
  },

  onAppStateChange(cb: (state: 'active' | 'background') => void): () => void {
    return onLifecycleState((state: AppLifecycleState) => cb(state));
  },

  onBackButton(cb: () => boolean): () => void {
    return onLifecycleBack(cb);
  },

  exitApp(): void {
    void exitLifecycleApp();
  },
};

export type { DeviceService as DeviceServiceContract };

/** 测试辅助：重置亮度/常亮状态 */
export function resetDeviceState(): void {
  dimPercent = 100;
  awakeActive = false;
}
