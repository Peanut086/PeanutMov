import type { EpisodeRef } from '@/player/types';
import type { DownloadTask } from '@/types';

export interface LocalEpisodeCatalogEntry {
  episode: EpisodeRef;
  task: DownloadTask;
}

function compareTasks(a: DownloadTask, b: DownloadTask): number {
  const aCompleted = a.completedAt ?? a.updatedAt ?? a.createdAt;
  const bCompleted = b.completedAt ?? b.updatedAt ?? b.createdAt;
  if (aCompleted !== bCompleted) return bCompleted - aCompleted;
  return a.id.localeCompare(b.id, 'zh-CN', { numeric: true });
}

export function buildLocalEpisodeCatalog(
  tasks: DownloadTask[],
  preferredEpisodeId?: string | null,
): LocalEpisodeCatalogEntry[] {
  const byNumber = new Map<number, DownloadTask>();

  for (const task of tasks) {
    if (task.status !== 'completed' || task.episodeNumber === null) continue;
    const current = byNumber.get(task.episodeNumber);
    if (!current) {
      byNumber.set(task.episodeNumber, task);
      continue;
    }

    const taskPreferred = task.episodeId === preferredEpisodeId;
    const currentPreferred = current.episodeId === preferredEpisodeId;
    if (taskPreferred !== currentPreferred) {
      if (taskPreferred) byNumber.set(task.episodeNumber, task);
      continue;
    }
    if (compareTasks(task, current) < 0) byNumber.set(task.episodeNumber, task);
  }

  return Array.from(byNumber, ([number, task]) => ({
    episode: {
      episodeId: task.episodeId,
      number,
      title: task.episodeTitle?.trim() || `第 ${number} 集`,
    },
    task,
  })).sort((a, b) => a.episode.number - b.episode.number);
}
