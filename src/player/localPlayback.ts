import { buildLocalEpisodeCatalog } from '@/player/localEpisodeCatalog';
import type { PlayerLoadOptions } from '@/player/types';
import { AppError } from '@/shared/errors';
import type { DownloadTask, PlaybackSource } from '@/types';

interface LocalPlaybackOptionsInput {
  mediaId: string;
  task: DownloadTask;
  tasks: DownloadTask[];
  playback: PlaybackSource;
  startPositionSec: number;
  preferNativeEngine?: boolean;
  loadTask: (task: DownloadTask) => Promise<PlaybackSource>;
  preparePlayback?: (playback: PlaybackSource) => Promise<PlaybackSource>;
}

export function buildLocalPlaybackOptions(
  input: LocalPlaybackOptionsInput,
): PlayerLoadOptions {
  const prepare = input.preparePlayback ?? ((playback) => Promise.resolve(playback));

  const build = (
    task: DownloadTask,
    playback: PlaybackSource,
    startPositionSec: number,
  ): PlayerLoadOptions => {
    const episodes = buildLocalEpisodeCatalog(input.tasks, task.episodeId)
      .map((entry) => entry.episode);

    return {
      mediaId: input.mediaId,
      episodeId: task.episodeId,
      lineId: 'local',
      title: task.title,
      posterUrl: task.posterUrl,
      playback: startPositionSec > 0
        ? { ...playback, startPositionMs: Math.round(startPositionSec * 1000) }
        : playback,
      startPositionSec,
      totalEpisodes: episodes.length > 0 ? episodes.length : null,
      episodes,
      preferLocal: true,
      preferNativeEngine: input.preferNativeEngine === true,
      resolveEpisode: async (targetEpisodeId) => {
        const target = input.tasks.find(
          (candidate) => candidate.status === 'completed'
            && candidate.episodeId === targetEpisodeId,
        );
        if (!target) {
          throw new AppError('E_LOCAL_CORRUPT', '本地文件不可用，请重新下载这一集');
        }
        const targetPlayback = await prepare(await input.loadTask(target));
        return build(target, targetPlayback, 0);
      },
    };
  };

  return build(input.task, input.playback, input.startPositionSec);
}
