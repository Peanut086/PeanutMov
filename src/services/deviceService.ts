/**
 * 设备服务（API-12）
 *
 * 跨 Web / Android 统一：
 * - 亮度：原生写本窗口背光（`screenBrightness`，可超过系统设置、不动系统值），
 *   读不到系统起点时整体退回画面遮罩；
 * - 音量：原生读写媒体流档位，与实体音量键是同一份状态；Web 退回播放器倍率；
 * - 横竖屏/状态栏/常亮在 Web 下为 no-op；
 * - 网络与应用状态由 `@/native/network`、`@/native/appLifecycle` 提供；
 * - 返回键在 Web 下注册无效监听（回调仍可被业务主动查询）。
 */
import { KeepAwake } from '@capacitor-community/keep-awake';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';

import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { brightnessToWindowRatio, clampBrightness, windowRatioToBrightness } from '@/player/brightness';
import {
  exitApp as exitLifecycleApp,
  onAppStateChange as onLifecycleState,
  onBackButton as onLifecycleBack,
  type AppLifecycleState,
} from '@/native/appLifecycle';
import {
  clearWindowBrightness,
  readRawSystemLevels,
  readRawSystemVolume,
  writeSystemVolume,
  writeWindowBrightness,
} from '@/native/playerUi';
import {
  getNetworkStatus as readNetworkStatus,
  onNetworkChange as onNetwork,
  type NetworkStatus,
} from '@/native/network';

export type { NetworkStatus };

/** 播放页的亮度/音量起点（均为用户语义 0~100） */
export interface SystemLevels {
  /** 当前屏幕背光换算出的亮度 */
  brightness: number;
  /** 当前媒体音量档位百分比 */
  volume: number;
}

export interface DeviceService {
  isNative(): boolean;
  /**
   * 读取系统亮度与媒体音量。
   *
   * 任一项读不到就整体返回 null：播放页据此退回「遮罩 + 播放器倍率」，
   * 避免出现"亮度是真值、音量是假值"这种半套语义。
   */
  readSystemLevels(): Promise<SystemLevels | null>;
  /** 写本窗口背光 0~100；false = 原生能力不可用（调用方改用遮罩） */
  setBrightness(percent: number): Promise<boolean>;
  /** 离开播放页：交还系统背光。音量是全局状态，按产品决策不恢复 */
  releaseBrightness(): Promise<void>;
  /** 写系统媒体音量 0~100，返回离散档位量化后实际生效的百分比；null = 不可用 */
  setVolume(percent: number): Promise<number | null>;
  /** 读系统媒体音量：实体按键可能在本页不知情时改过，手势按下前用它校准基准 */
  readVolume(): Promise<number | null>;
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

let awakeActive = false;

/** 非法值一律不落到系统：写坏用户的全局音量比不写严重得多 */
function clampVolumePercent(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export const deviceService: DeviceService = {
  isNative(): boolean {
    return isNative();
  },

  async readSystemLevels(): Promise<SystemLevels | null> {
    const raw = await readRawSystemLevels();
    if (!raw) return null;
    if (!Number.isFinite(raw.brightnessRatio) || raw.brightnessRatio < 0) return null;
    if (!Number.isFinite(raw.volumePercent) || raw.volumePercent < 0) return null;
    return {
      brightness: windowRatioToBrightness(raw.brightnessRatio),
      volume: raw.volumePercent,
    };
  },

  async setBrightness(percent: number): Promise<boolean> {
    if (!Number.isFinite(percent)) return false;
    return writeWindowBrightness(brightnessToWindowRatio(clampBrightness(percent)));
  },

  async releaseBrightness(): Promise<void> {
    await clearWindowBrightness();
  },

  async setVolume(percent: number): Promise<number | null> {
    const value = clampVolumePercent(percent);
    return value === null ? null : writeSystemVolume(value);
  },

  async readVolume(): Promise<number | null> {
    return readRawSystemVolume();
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

/** 测试辅助：重置常亮状态 */
export function resetDeviceState(): void {
  awakeActive = false;
}
