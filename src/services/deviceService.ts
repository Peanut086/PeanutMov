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
  /**
   * 屏幕常亮（AC-53）。`owner` 是持锁者令牌（每个播放页实例一个）：
   * Vue 先挂新页再卸旧页，旧页的释放不能把新页刚拿到的锁清掉。
   */
  keepAwake(on: boolean, owner?: object): Promise<void>;
  getNetworkStatus(): Promise<NetworkStatus>;
  onNetworkChange(cb: (s: NetworkStatus) => void): () => void;
  /** App 退后台/回前台（Web 用 visibilitychange 兜底） */
  onAppStateChange(cb: (state: 'active' | 'background') => void): () => void;
  /** 返回 true 表示已处理 */
  onBackButton(cb: () => boolean): () => void;
  exitApp(): void;
}

/**
 * 常亮锁的期望态。真实状态以原生窗口 flag 为准——Activity 重建
 * （MainActivity 在 WebView 渲染进程崩溃时会 recreate）会把 flag 清掉，
 * 而 JS 侧缓存仍以为亮着，于是播放中永久熄屏。
 *
 * 三层收口（11-17 首集播放熄屏）：
 * 1) `awakeDesired` 是唯一意图来源，原生调用串行执行且只按最新意图落地，
 *    所以「起播瞬间 true→false→true」的并发请求不会把 flag 停在 false；
 * 2) 只要期望态是持有，复核周期表就一直在跑（含原生调用失败的分支），
 *    熄屏前一定补得回来，不再依赖「用户切一次前后台」自愈；
 * 3) 回前台由本模块自己重申，三个播放面（点播/直播/回看）共用同一份保护。
 */
let awakeDesired = false;
/**
 * 当前意图是谁下的（起播持锁 / 离开释放）。
 * 串行对齐的一轮里可能连着落两次意图（离开释放后又收到回前台重申），日志必须按意图记，
 * 而不是按"这轮由谁触发"记，否则会输出"持锁（离开释放）"这种读起来像 bug 的行。
 */
let awakeIntentReason = '初始';
let awakeOwner: object | null = null;
/** 与原生对齐成功的时刻；0 = 从未对齐 */
let awakeVerifiedAt = 0;
/** 进行中的对齐轮（串行入口），null = 空闲 */
let awakeLoop: Promise<void> | null = null;
/** 对齐期间又收到新意图 → 本轮结束后再跑一轮 */
let awakeDirty = false;
let awakeWatchdog: ReturnType<typeof setInterval> | null = null;
let awakeRetry: ReturnType<typeof setTimeout> | null = null;
let awakeRetryMs = 0;
/** 释放失败的剩余重试次数：持锁失败由周期表长期兜底，释放失败不必永久轮询 */
let awakeRetryBudget = 4;
let awakeForegroundOff: (() => void) | null = null;

/** 期望态未变时，距上次核对超过这个间隔就重新问一次原生 */
const AWAKE_RECHECK_MS = 10_000;
/** 原生调用失败后的退避上限 */
const AWAKE_RETRY_MAX_MS = 10_000;

function stopAwakeWatchdog(): void {
  if (awakeWatchdog !== null) {
    clearInterval(awakeWatchdog);
    awakeWatchdog = null;
  }
  if (awakeForegroundOff) {
    awakeForegroundOff();
    awakeForegroundOff = null;
  }
}

function stopAwakeRetry(): void {
  if (awakeRetry !== null) {
    clearTimeout(awakeRetry);
    awakeRetry = null;
  }
}

/** 持锁期间常驻复核：flag 掉了（重建 / ROM 清理 / 跨页释放）也能在熄屏前补回 */
function armAwakeGuards(): void {
  stopAwakeRetry();
  if (awakeWatchdog === null) {
    awakeWatchdog = setInterval(() => void requestAwakeAlign('复核'), AWAKE_RECHECK_MS);
  }
  if (awakeForegroundOff === null) {
    awakeForegroundOff = onLifecycleState((state: AppLifecycleState) => {
      if (state === 'active') void requestAwakeAlign('回前台');
    });
  }
}

function scheduleAwakeRetry(): void {
  if (awakeRetry !== null) return;
  // 持锁失败必须一直兜着（熄屏不可逆地毁掉观看）；释放失败重试几次就够，
  // 不能让一个已离开的播放页留下永久轮询。
  if (awakeDesired) armAwakeGuards();
  else awakeRetryBudget -= 1;
  awakeRetryMs = Math.min(AWAKE_RETRY_MAX_MS, Math.max(1000, awakeRetryMs * 2 || 1000));
  awakeRetry = setTimeout(() => {
    awakeRetry = null;
    void requestAwakeAlign('重试');
  }, awakeRetryMs);
}

/** 串行对齐原生 flag；并发调用共享同一轮，返回时意图已落到原生（或已排定重试） */
function requestAwakeAlign(reason: string): Promise<void> {
  if (awakeLoop) {
    awakeDirty = true;
    return awakeLoop;
  }
  awakeLoop = (async () => {
    do {
      awakeDirty = false;
      const target = awakeDesired;
      // 意图与目标一起在本轮开头取快照：对齐是异步的，期间新到的意图会把 awakeIntentReason
      // 改掉，若到打印时才读，就会输出"释放（意图 起播持锁）"这种自相矛盾的行。
      const intent = awakeIntentReason;
      const { isKeptAwake } = await KeepAwake.isKeptAwake();
      if (isKeptAwake !== target) {
        if (target) await KeepAwake.keepAwake();
        else await KeepAwake.allowSleep();
        logger.info(
          `屏幕常亮 flag 对齐为 ${target ? '持锁' : '释放'}（意图 ${intent}，触发 ${reason}）`,
          { was: isKeptAwake },
        );
      }
      if (awakeDesired !== target) {
        awakeDirty = true;
        continue;
      }
      awakeVerifiedAt = Date.now();
      awakeRetryMs = 0;
      stopAwakeRetry();
      if (target) armAwakeGuards();
      else stopAwakeWatchdog();
    } while (awakeDirty);
  })()
    .catch((e: unknown) => {
      logger.warn('常亮切换失败（稍后重试）', e);
      if (awakeDesired || awakeRetryBudget > 0) scheduleAwakeRetry();
    })
    .finally(() => {
      awakeLoop = null;
    });
  return awakeLoop;
}

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

  async keepAwake(on: boolean, owner?: object): Promise<void> {
    if (!isNative()) {
      awakeDesired = on;
      awakeIntentReason = on ? '起播持锁' : '离开释放';
      awakeVerifiedAt = Date.now();
      return;
    }
    if (on) {
      awakeOwner = owner ?? null;
    } else if (owner && awakeOwner && awakeOwner !== owner) {
      // 锁已被别的页面接手，这次释放属于过期请求
      return;
    }
    if (on === awakeDesired && Date.now() - awakeVerifiedAt < AWAKE_RECHECK_MS) return;
    awakeDesired = on;
    awakeIntentReason = on ? '起播持锁' : '离开释放';
    if (on) {
      awakeRetryBudget = 4;
    } else {
      awakeOwner = null;
      // 释放意图一到就先撤周期表：不该让已离开的播放页继续持锁轮询
      stopAwakeWatchdog();
    }
    await requestAwakeAlign('调用下发');
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
  awakeDesired = false;
  awakeIntentReason = '初始';
  awakeOwner = null;
  awakeVerifiedAt = 0;
  awakeRetryMs = 0;
  awakeRetryBudget = 4;
  stopAwakeRetry();
  stopAwakeWatchdog();
}
