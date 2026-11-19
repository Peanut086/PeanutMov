/**
 * 下载下单前的闸门（P3-3）
 *
 * 「这条线路下不动 → 换一条再下一遍」在详情页和播放页都会发生，两处必须给同一个口径的提示，
 * 所以判定入口收在这里，而不是各写一遍——分头写过的结果就是详情页会问、播放页直接下单。
 *
 * 闸门只披露、不拦截：换线路常常正是用户此刻唯一可行的动作。
 */
import { describeCrossLineDuplicates, findCrossLineDuplicates } from '@/services/downloadBatch';
import { formatBytes } from '@/components/common/format';
import { useUiStore } from '@/stores/uiStore';
import type { CreateDownloadInput, DownloadTask } from '@/types';

export function useDownloadGuards() {
  const ui = useUiStore();

  /**
   * 有跨线路重复时弹一次确认；用户选择放弃返回 false（调用方直接中止下单）。
   *
   * @param inputs 本次要下的集（`toDownloadInputs` 的产物）
   * @param tasks 下载列表全量（含已完成；`downloads.tasks` 即 `downloadRepo.listAll()`）
   */
  async function confirmCrossLineDuplicates(
    inputs: CreateDownloadInput[],
    tasks: DownloadTask[],
  ): Promise<boolean> {
    const duplicates = findCrossLineDuplicates(inputs, tasks);
    if (duplicates.length === 0) return true;
    return ui.confirm({
      title: '这条线路的内容已下载过',
      message: describeCrossLineDuplicates(duplicates, formatBytes),
      confirmText: '仍要下载',
    });
  }

  return { confirmCrossLineDuplicates };
}
