/**
 * 平台能力判定（SCF 冻结，PKG-B 只读）
 *
 * 不 import `@capacitor/core`，避免在 Node 测试环境中引入原生桥；
 * 仅通过 `globalThis.Capacitor` 的存在性与 `Capacitor.getPlatform()` 判断，
 * 未安装插件时也不会抛错。
 */
export type PlatformName = 'android' | 'ios' | 'web';

interface CapacitorGlobal {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  isNative?: boolean;
}

function getCapacitor(): CapacitorGlobal | null {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap && typeof cap === 'object' ? cap : null;
}

/** 当前平台名；无法判定时按 web 处理 */
export function getPlatform(): PlatformName {
  const cap = getCapacitor();
  if (cap?.getPlatform) {
    try {
      const p = cap.getPlatform();
      if (p === 'android' || p === 'ios') return p;
      return 'web';
    } catch {
      return 'web';
    }
  }
  if (typeof cap?.isNative === 'boolean' && cap.isNative) return 'android';
  if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)) {
    // 浏览器里的 Android 仍按 web 处理（无原生桥能力）
    return 'web';
  }
  return 'web';
}

/** 是否运行在原生容器（Android App）中 */
export function isNative(): boolean {
  const cap = getCapacitor();
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') {
    try {
      return cap.isNativePlatform();
    } catch {
      return false;
    }
  }
  if (typeof cap.isNative === 'boolean') return cap.isNative;
  const p = getPlatform();
  return p === 'android' || p === 'ios';
}

export function isWeb(): boolean {
  return !isNative();
}

export function isAndroid(): boolean {
  return getPlatform() === 'android';
}

/** 原生能力是否可用（插件缺失/Web 下统一返回 false，调用方据此降级） */
export function hasNativePlugin(name: string): boolean {
  const cap = getCapacitor() as (CapacitorGlobal & {
    Plugins?: Record<string, unknown>;
  }) | null;
  if (!cap || !isNative()) return false;
  return Boolean(cap.Plugins && cap.Plugins[name]);
}
