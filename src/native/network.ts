/**
 * 网络状态（`@capacitor/network` 封装，Web 用 navigator.onLine + online/offline 事件兜底）
 *
 * 服务层不直接接触 DOM：所有浏览器事件监听都收敛在此模块。
 */
import { Network } from '@capacitor/network';

import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';

/** 网络状态（API-12 契约形状；types/index.ts 未定义，收敛在此模块） */
export interface NetworkStatus {
  connected: boolean;
  type: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';
}

type Listener = (status: NetworkStatus) => void;

const listeners = new Set<Listener>();
let lastStatus: NetworkStatus = { connected: true, type: 'unknown' };
let initialized = false;
let nativeHandleRegistered = false;

function normalizeType(): NetworkStatus['type'] {
  return 'unknown';
}

function emit(status: NetworkStatus): void {
  lastStatus = status;
  for (const listener of [...listeners]) {
    try {
      listener(status);
    } catch (e) {
      logger.warn('网络状态监听器异常', e);
    }
  }
}

/** 仅做 Web 侧的事件订阅（Native 由 Capacitor 插件推送） */
function attachWebListeners(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('online', () => {
    emit({ connected: true, type: normalizeType() });
  });
  window.addEventListener('offline', () => {
    emit({ connected: false, type: 'none' });
  });
}

/** 初始化原生监听（只做一次） */
async function attachNativeListener(): Promise<void> {
  if (nativeHandleRegistered) return;
  nativeHandleRegistered = true;
  try {
    await Network.addListener('networkStatusChange', (status) => {
      const type: NetworkStatus['type'] =
        status.connectionType === 'wifi' || status.connectionType === 'cellular'
          ? status.connectionType
          : status.connected
            ? 'unknown'
            : 'none';
      emit({ connected: status.connected, type });
    });
  } catch (e) {
    logger.debug('Network 插件监听不可用，回退 Web 事件', e);
    nativeHandleRegistered = false;
    attachWebListeners();
  }
}

/** 当前是否在线（同步判断，供服务层做快速分支） */
export function isOnline(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return lastStatus.connected;
}

/** 当前网络类型（同步） */
export function currentNetworkType(): NetworkStatus['type'] {
  return lastStatus.type;
}

/** 查询网络状态（尽量走原生插件，失败回退 navigator.onLine） */
export async function getNetworkStatus(): Promise<NetworkStatus> {
  attachWebListeners();
  if (!isNative()) {
    return { connected: isOnline(), type: isOnline() ? 'unknown' : 'none' };
  }
  try {
    const status = await Network.getStatus();
    const type: NetworkStatus['type'] =
      status.connectionType === 'wifi' || status.connectionType === 'cellular'
        ? status.connectionType
        : status.connected
          ? 'unknown'
          : 'none';
    const next: NetworkStatus = { connected: status.connected, type };
    lastStatus = next;
    return next;
  } catch (e) {
    logger.warn('读取网络状态失败，按在线处理', e);
    return { connected: isOnline(), type: isOnline() ? 'unknown' : 'none' };
  }
}

/** 订阅网络变化，返回取消函数 */
export function onNetworkChange(cb: Listener): () => void {
  attachWebListeners();
  if (isNative()) void attachNativeListener();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 测试辅助：重置内部状态 */
export function resetNetworkState(): void {
  listeners.clear();
  lastStatus = { connected: true, type: 'unknown' };
  initialized = false;
  nativeHandleRegistered = false;
}
