/**
 * 应用生命周期（`@capacitor/app` 封装，Web 用 visibilitychange 兜底）
 *
 * 服务层与播放器只依赖本模块，不直接接触 DOM / Capacitor 插件。
 */
import { App } from '@capacitor/app';

import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';

export type AppLifecycleState = 'active' | 'background';
type StateListener = (state: AppLifecycleState) => void;
type BackListener = () => boolean;

const stateListeners = new Set<StateListener>();
const backListeners = new Set<BackListener>();
let webAttached = false;
let nativeAttached = false;
let sourceRefCount = 0;

function emitState(state: AppLifecycleState): void {
  for (const listener of [...stateListeners]) {
    try {
      listener(state);
    } catch (e) {
      logger.warn('生命周期监听器异常', e);
    }
  }
}

function emitBack(): boolean {
  let handled = false;
  for (const listener of [...backListeners]) {
    try {
      if (listener()) handled = true;
    } catch (e) {
      logger.warn('返回键监听器异常', e);
    }
  }
  return handled;
}

function attachWeb(): void {
  if (webAttached || typeof document === 'undefined') return;
  webAttached = true;
  document.addEventListener('visibilitychange', () => {
    emitState(document.visibilityState === 'hidden' ? 'background' : 'active');
  });
  window.addEventListener('pagehide', () => emitState('background'));
  window.addEventListener('pageshow', () => emitState('active'));
}

async function attachNative(): Promise<void> {
  if (nativeAttached) return;
  nativeAttached = true;
  try {
    await App.addListener('appStateChange', ({ isActive }) => {
      emitState(isActive ? 'active' : 'background');
    });
    await App.addListener('backButton', () => {
      const handled = emitBack();
      if (!handled) void App.exitApp();
    });
  } catch (e) {
    logger.debug('App 插件监听不可用，回退 Web 事件', e);
    nativeAttached = false;
    attachWeb();
  }
}

/** 订阅前后台切换；返回取消函数 */
export function onAppStateChange(cb: StateListener): () => void {
  attachWeb();
  if (isNative()) void attachNative();
  stateListeners.add(cb);
  sourceRefCount += 1;
  return () => {
    stateListeners.delete(cb);
    sourceRefCount = Math.max(0, sourceRefCount - 1);
  };
}

/**
 * 订阅 Android 返回键；回调返回 true 表示已处理（不再默认退出）。
 * Web 下退化为 `popstate` 监听（仅当回调返回 true 时阻止默认行为不可能，故 Web 直接不注册）。
 */
export function onBackButton(cb: BackListener): () => void {
  if (isNative()) void attachNative();
  backListeners.add(cb);
  return () => {
    backListeners.delete(cb);
  };
}

/** 退出 App（Web 下 no-op） */
export async function exitApp(): Promise<void> {
  if (!isNative()) return;
  try {
    await App.exitApp();
  } catch (e) {
    logger.warn('退出 App 失败', e);
  }
}

/** 当前是否处于前台（Web 依据 visibilityState） */
export function isAppActive(): boolean {
  if (typeof document !== 'undefined' && typeof document.visibilityState === 'string') {
    return document.visibilityState === 'visible';
  }
  return true;
}

/** 测试辅助：重置所有监听（不解除已注册的原生监听，仅清空业务回调） */
export function resetLifecycleState(): void {
  stateListeners.clear();
  backListeners.clear();
  sourceRefCount = 0;
}

/** 当前业务订阅数（测试用） */
export function listenerCount(): { state: number; back: number } {
  return { state: stateListeners.size, back: backListeners.size };
}
