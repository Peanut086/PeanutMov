/**
 * 触觉反馈 composable（OPT-03 → A 批次·原生触觉重建）
 *
 * 原生容器走 `PlayerUi.haptic` → `View.performHapticFeedback`：由系统按机型选振动波形，
 * 拿到的是 CLICK / LONG_PRESS / CONTEXT_CLICK 这类语义质感，不需要 VIBRATE 权限。
 *
 * 之前实现只有 `navigator.vibrate(ms)`，而 manifest 未声明 VIBRATE、WebView 里又受 ROM
 * 限制，全 App 11 处调用基本空转。`navigator.vibrate` 现在只作为 Web 预览的兜底
 * ——它只能表达"震多久"，表达不了档位语义。
 *
 * 受 settingsStore.hapticEnabled 控制，关闭时所有调用静默跳过。
 */
import { computed } from 'vue';

import { fireNativeHaptic } from '@/native/playerUi';
import { useSettingsStore } from '@/stores/settingsStore';
import { isNative } from '@/shared/platform';

export type HapticMode = 'light' | 'medium' | 'heavy';

/** Web 兜底时长（毫秒）；原生档位不走这里 */
const FALLBACK_DURATIONS: Record<HapticMode, number> = {
  light: 10,
  medium: 25,
  heavy: 50,
};

let lastHapticAt = 0;

export function useHaptic() {
  const settings = useSettingsStore();

  /** 是否启用触觉反馈（从设置读取，默认开启） */
  const enabled = computed(() => settings.settings?.hapticEnabled ?? true);

  /**
   * 触发触觉反馈（50ms 节流，防止高频调用叠加振动）
   * @param mode 强度档位
   */
  function haptic(mode: HapticMode): void {
    if (!enabled.value) return;
    const now = Date.now();
    if (now - lastHapticAt < 50) return;
    lastHapticAt = now;

    if (isNative()) {
      // 桥失败已在 fireNativeHaptic 内吞掉；此时退回 vibrate 同样无效，不再兜底
      void fireNativeHaptic(mode);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    navigator.vibrate(FALLBACK_DURATIONS[mode]);
  }

  return { haptic, enabled };
}
