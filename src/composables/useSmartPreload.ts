/**
 * 智能预加载 composable（OPT-15）
 *
 * 检测 WiFi 环境，提供预加载单个内容的能力。
 * 复用 downloadStore 的创建逻辑，不重复实现下载流程。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { getNetworkStatus, onNetworkChange, type NetworkStatus } from '@/native/network';
import { useSettingsStore } from '@/stores/settingsStore';
import { useDownloadStore } from '@/stores/downloadStore';
import { useLibraryStore } from '@/stores/libraryStore';
import type { CreateDownloadInput } from '@/types';

export function useSmartPreload() {
  const settings = useSettingsStore();
  const downloads = useDownloadStore();
  const library = useLibraryStore();

  const isWifi = ref(false);

  /** 是否应显示预加载提示（WiFi + 设置已开启 + 有可预加载内容） */
  const canPreload = computed(
    () => isWifi.value && Boolean(settings.settings?.smartPreloadEnabled),
  );

  /** 预加载存储上限（字节） */
  const preloadLimitBytes = computed(() => {
    const mb = settings.settings?.preloadStorageLimitMb ?? 1024;
    return mb === 0 ? Infinity : mb * 1024 * 1024;
  });

  function applyStatus(status: NetworkStatus): void {
    isWifi.value = status.connected && status.type === 'wifi';
  }

  /** 检测网络连接类型（原生插件区分 wifi/cellular，Web 端类型未知按非 WiFi 处理） */
  async function checkConnection(): Promise<void> {
    applyStatus(await getNetworkStatus());
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

  // REV-15: 生命周期 — 原生插件事件驱动，挂载时补一次同步查询
  let unsubscribeNetwork: (() => void) | null = null;

  onMounted(() => {
    unsubscribeNetwork = onNetworkChange(applyStatus);
    void checkConnection();
  });

  onBeforeUnmount(() => {
    unsubscribeNetwork?.();
    unsubscribeNetwork = null;
  });

  return { isWifi, canPreload, checkConnection, preloadItem, preloadLimitBytes };
}
