/**
 * 触觉反馈 composable（OPT-03）
 *
 * 封装 navigator.vibrate API，提供三档强度（light/medium/heavy）。
 * 受 settingsStore.hapticEnabled 控制，关闭时所有调用静默跳过。
 * 不支持振动的设备（如 iOS Safari、桌面浏览器）自动降级为无操作。
 */
import { computed } from 'vue';

import { useSettingsStore } from '@/stores/settingsStore';

export type HapticMode = 'light' | 'medium' | 'heavy';

/** 各档位对应的振动时长（毫秒） */
const HAPTIC_DURATIONS: Record<HapticMode, number> = {
  light: 10,
  medium: 25,
  heavy: 50,
};

let lastVibrateAt = 0;

export function useHaptic() {
  const settings = useSettingsStore();

  /** 是否启用触觉反馈（从设置读取，默认开启） */
  const enabled = computed(() => settings.settings?.hapticEnabled ?? true);

  /**
   * 触发触觉反馈（50ms 节流，防止高频叠加振动）
   * @param mode 振动强度档位
   */
  function haptic(mode: HapticMode): void {
    if (!enabled.value) return;
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    const now = Date.now();
    if (now - lastVibrateAt < 50) return;
    lastVibrateAt = now;
    navigator.vibrate(HAPTIC_DURATIONS[mode]);
  }

  return { haptic, enabled };
}
