/**
 * 在线/离线状态（组合式函数）
 *
 * 优先 `navigator.onLine` + `online/offline` 事件；不依赖 PKG-B 的
 * DeviceService，避免 UI 包在集成前被阻塞。原生容器同样会触发这两个事件。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

import { useUiStore } from '@/stores/uiStore';

export function useOnlineStatus(): {
  isOffline: Ref<boolean>;
  isOnline: Ref<boolean>;
} {
  const ui = useUiStore();
  const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

  const sync = (): void => {
    const next = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    if (isOnline.value === next) {
      ui.setOffline(!next);
      return;
    }
    isOnline.value = next;
    ui.setOffline(!next);
    if (next) ui.toast('网络已恢复', 'success');
  };

  const onUp = (): void => {
    sync();
  };
  const onDown = (): void => {
    sync();
  };

  onMounted(() => {
    sync();
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('online', onUp);
    window.removeEventListener('offline', onDown);
  });

  return { isOffline: ui.isOffline as unknown as Ref<boolean>, isOnline };
}
