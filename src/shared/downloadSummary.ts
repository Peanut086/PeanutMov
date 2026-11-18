/**
 * 下载汇总口径（P2-1）
 *
 * 单一实现：`downloadRepo.summary()` 与 mock  store 都走这里，避免两份聚合口径漂移。
 *
 * 为什么不能用 `downloadedBytes / totalBytes` 当批次总进度：未开始的任务 `totalBytes`
 * 是 null（体积要等清单下来才知道），它不进分母。真机 13 集批次起跑 6s 时字节侧是
 * 「1.7 MB / 1.7 MB」——分母只有那 2 个已完成任务，于是头部显示 100%，而列表里还有
 * 9 个「等待」。这里改成按任务加权：完成记 1，其余按该任务自己的字节比，分母是任务数。
 */
import type { DownloadSummary, DownloadTask } from '@/types';

/** 单个任务对批次进度的贡献（0~1） */
function taskWeight(task: DownloadTask): number {
  if (task.status === 'completed') return 1;
  // 失败/取消的这一集永远不会变成 1：给它按字节记份额，等于把批次进度粉饰成
  // 「快完了」——12 完成 + 1 失败会显示 99%，而那个失败项并不会自己好起来。
  if (task.status === 'failed' || task.status === 'canceled') return 0;
  if (!task.totalBytes || task.totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, task.downloadedBytes / task.totalBytes));
}

/** 体积未知且还需要它继续下载的任务：这些任务进不了字节分母 */
function isSizeUnknown(task: DownloadTask): boolean {
  return task.totalBytes === null && task.status !== 'completed';
}

export function aggregateSummary(rows: DownloadTask[]): DownloadSummary {
  const summary: DownloadSummary = {
    total: rows.length,
    queued: 0,
    downloading: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    progress: 0,
    unknownSizeTasks: 0,
  };
  let weightSum = 0;
  for (const row of rows) {
    if (row.status === 'queued') summary.queued += 1;
    else if (row.status === 'downloading') summary.downloading += 1;
    else if (row.status === 'paused') summary.paused += 1;
    else if (row.status === 'completed') summary.completed += 1;
    else if (row.status === 'failed') summary.failed += 1;
    summary.totalBytes += row.totalBytes ?? 0;
    summary.downloadedBytes += row.downloadedBytes;
    if (isSizeUnknown(row)) summary.unknownSizeTasks += 1;
    weightSum += taskWeight(row);
  }
  summary.progress = rows.length > 0 ? weightSum / rows.length : 0;
  return summary;
}
