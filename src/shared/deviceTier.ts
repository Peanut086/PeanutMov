/**
 * 设备档位（C 批次共用）
 *
 * WebView 里没有可靠的跑分入口，只能用 `navigator` 上那两个粗指标判"这台机器
 * 该不该跑逐帧动效"。拿不到指标时按高档处理——宁可多画几帧，也不要把
 * 中高端设备误降级成素版本。
 */

/** 与 useSeekThumbnails 的胶片格数启发式同源：内存 <4GB 或核数 ≤4 视为低端 */
export function isLowEndDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 0;
  return (memory !== undefined && memory > 0 && memory < 4) || (cores > 0 && cores <= 4);
}

/** 粒子/取样数量按档位减半（向上取整，保证至少 1） */
export function budgetAt(base: number): number {
  return isLowEndDevice() ? Math.max(1, Math.ceil(base / 2)) : base;
}
