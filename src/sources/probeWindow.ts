/**
 * 探活窗口按源类型分级（P1-7）。
 *
 * 单一口径来源：`sourceService.probeTimeoutOf`（收窄 `httpClient` 的默认超时）与
 * `BaseAdapter.probeWindowMs`（适配器自身的探测闸门）都必须取这里的值，否则两层窗口
 * 会各自分级、短的那一层先误判。爬虫源的「冷/热」再分级由 `SpiderAdapter` 覆盖，
 * 因为它要按 jar 句柄是否已加载来定，类型层面拿不到句柄状态。
 */
import { TIMEOUT_PROBE_NETSTORE_MS, TIMEOUT_PROBE_SPIDER_MS, TIMEOUT_TEST_CONNECTION_MS } from '@/shared/constants';
import type { Source } from '@/types';

export function probeWindowMsFor(source: Source): number {
  switch (source.type) {
    case 'spider':
      return TIMEOUT_PROBE_SPIDER_MS;
    case 'alist':
    case 'webdav':
    case 'jellyfin':
      return TIMEOUT_PROBE_NETSTORE_MS;
    default:
      return TIMEOUT_TEST_CONNECTION_MS;
  }
}
