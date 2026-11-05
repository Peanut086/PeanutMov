/**
 * 智能预加载 composable（OPT-15）
 *
 * 检测 WiFi 环境，提供预加载单个内容的能力。
 * 复用 downloadStore 的创建逻辑，不重复实现下载流程。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { useSettingsStore } from '@/stores/settingsStore';
import { useDownloadStore } from '@/stores/downloadStore';
import { useLibraryStore } from '@/stores/libraryStore';
import type { CreateDownloadInput } from '@/types';

export function useSmartPreload() {
  const settings = useSettingsStore();
  const downloads = useDownloadStore();
  const library = useLibraryStore();

  const isWifi = ref(false);

  /** 是否应显示预加载提示（WiFi + 设置未开启 + 有可预加载内容） */
  const canPreload = computed(
    () => isWifi.value && !settings.settings?.smartPreloadEnabled,
  );

  /** 预加载存储上限（字节） */
  const preloadLimitBytes = computed(() => {
    const mb = settings.settings?.preloadStorageLimitMb ?? 1024;
    return mb === 0 ? Infinity : mb * 1024 * 1024;
  });

  /** 检测网络连接类型 */
  function checkConnection(): void {
    if (typeof navigator === 'undefined') return;
    const conn = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection;
    if (conn) {
      isWifi.value = conn.type === 'wifi' || conn.effectiveType === '4g';
    } else {
      // REV-12: API 不可用时默认不提示，避免计量网络（4G/5G）下误引导
      isWifi.value = false;
    }
  }

  /**
   * 预加载单个剧集
   * 复用 libraryStore.toDownloadInputs + downloadStore.create 链路
   */
  async function preloadItem(mediaId: string, episodeId: string): Promise<{ ok: boolean; message: string }> {
    // REV-13: 预加载前校验存储上限，避免 preloadLimitBytes 设置项形同虚设
    const currentBytes = downloads.summary.downloadedBytes;
    const limit = preloadLimitBytes.value;
    if (limit > 0 && currentBytes >= limit) {
      return { ok: false, message: '已达预加载存储上限' };
    }
    try {
      const inputs = await library.toDownloadInputs(mediaId, [episodeId], null);
      if (inputs.length === 0) {
        return { ok: false, message: '该集暂无可用的播放地址' };
      }
      const input: CreateDownloadInput = inputs[0];
      const result = await downloads.create(input);
      if (result.existed) {
        return { ok: true, message: '已在下载列表中' };
      }
      return { ok: true, message: '已开始预加载' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '预加载失败' };
    }
  }

  // REV-15: 生命周期 — 优先事件监听，setInterval 仅作最终兜底（60s）
  let connectionTimer: ReturnType<typeof setInterval> | null = null;
  let connectionApi: { type?: string; effectiveType?: string; addEventListener?: (type: string, handler: () => void) => void; removeEventListener?: (type: string, handler: () => void) => void } | null = null;

  function onConnectionChange(): void {
    checkConnection();
  }

  function onOnline(): void {
    checkConnection();
  }

  function onOffline(): void {
    isWifi.value = false;
  }

  onMounted(() => {
    checkConnection();

    if (typeof navigator !== 'undefined') {
      // 优先：Network Information API change 事件
      const nav = navigator as Navigator & { connection?: typeof connectionApi };
      connectionApi = nav.connection ?? null;
      if (connectionApi?.addEventListener) {
        connectionApi.addEventListener('change', onConnectionChange);
      }

      // 优先：window online/offline 事件
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }

    // 兜底：每 60 秒重新检测（覆盖 API 不支持事件监听的极端场景）
    connectionTimer = setInterval(checkConnection, 60_000);
  });

  onBeforeUnmount(() => {
    if (connectionApi?.removeEventListener) {
      connectionApi.removeEventListener('change', onConnectionChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
    if (connectionTimer !== null) {
      clearInterval(connectionTimer);
      connectionTimer = null;
    }
    connectionApi = null;
  });

  return { isWifi, canPreload, checkConnection, preloadItem, preloadLimitBytes };
}
