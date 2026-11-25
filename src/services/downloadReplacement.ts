import { blobRepo } from '@/db/repositories/blobRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { deleteFile, readTextFile, renameFile, stat } from '@/native/fs';
import { scanTsFile, verifyRemuxedMedia } from '@/native/mediaToolPlugin';
import { appEvents } from '@/services/events';
import { buildLocalHlsManifest, isCompleteLocalHlsIndex, localHlsIndexPathOf, writeLocalHlsIndex } from '@/services/localHlsIndex';
import { nativeFilePathOf } from '@/services/downloadSink';
import { AppError } from '@/shared/errors';
import { newId } from '@/shared/id';
import { logger } from '@/shared/logger';
import type { DownloadTask } from '@/types';

const BACKUP_SUFFIX = '.replacement-old';
const ACTIVE_STATUSES = ['queued', 'downloading', 'paused'] as const;

async function removeCandidateFiles(task: DownloadTask): Promise<void> {
  if (task.sink !== 'filesystem') return;
  const paths = new Set<string>();
  if (task.artifactPath) paths.add(task.artifactPath);
  if (task.filePath) paths.add(task.filePath);
  if (task.hlsIndexPath) paths.add(task.hlsIndexPath);
  for (const path of paths) {
    await deleteFile(path).catch(() => undefined);
    await deleteFile(`${path}.part`).catch(() => undefined);
  }
}

/** 创建独立候选任务；旧 completed 记录和旧产物在本函数中完全不动。 */
export async function createSafeReplacement(taskId: string): Promise<DownloadTask> {
  const old = await downloadRepo.get(taskId);
  if (!old) throw new AppError('E_NOT_FOUND');
  if (old.status !== 'completed') throw new AppError('E_INVALID_INPUT', '只有已完成的下载可以安全重下');
  if (old.format !== 'hls') throw new AppError('E_INVALID_INPUT', '当前只支持 HLS 下载的安全重下');

  const siblings = await downloadRepo.listByEpisode(old.mediaId, old.episodeId);
  const active = siblings.find(
    (task) => task.replacesTaskId === old.id && ACTIVE_STATUSES.includes(task.status as typeof ACTIVE_STATUSES[number]),
  );
  if (active) return active;

  for (const stale of siblings.filter((task) => task.replacesTaskId === old.id)) {
    if (stale.blobKey && stale.blobKey !== old.blobKey) await blobRepo.delete(stale.blobKey).catch(() => undefined);
    await removeCandidateFiles(stale);
    await downloadRepo.remove(stale.id);
  }

  const now = Date.now();
  const oldPath = old.filePath ?? nativeFilePathOf(old);
  const artifactPath = old.sink === 'filesystem'
    ? oldPath.replace(/(\.[^/.]+)$/i, '.replacement$1')
    : null;
  const candidate: DownloadTask = {
    ...old,
    id: newId(),
    title: `${old.title}（安全重下候选）`,
    status: 'queued',
    downloadedBytes: 0,
    totalBytes: null,
    speedBps: 0,
    retries: 0,
    resumable: false,
    filePath: null,
    artifactPath,
    replacesTaskId: old.id,
    blobKey: null,
    hlsIndex: null,
    hlsIndexPath: null,
    hlsTotalSegments: 0,
    hlsDiscontinuities: 0,
    hlsPlaylistFingerprint: null,
    completedSegments: [],
    container: null,
    remux: null,
    contentDigest: null,
    estimatedBytes: null,
    preflight: null,
    pendingSubtitleUrls: undefined,
    pendingCoverUrl: undefined,
    batchId: null,
    errorCode: null,
    errorMessage: null,
    completedAt: null,
    priority: now,
    linkResolvedAt: old.format === 'hls' ? 0 : now,
    createdAt: now,
    updatedAt: now,
  };
  await downloadRepo.save(candidate);
  return candidate;
}

async function verifyCandidate(task: DownloadTask): Promise<void> {
  if (task.sink !== 'filesystem') {
    const blob = await blobRepo.get(task.blobKey ?? task.id);
    if (!blob || blob.size <= 0) throw new AppError('E_LOCAL_CORRUPT', '候选下载没有可验证的 Blob 产物');
    return;
  }
  const path = task.filePath ?? task.artifactPath;
  if (!path) throw new AppError('E_LOCAL_CORRUPT', '候选下载没有落盘路径');
  const file = await stat(path);
  if (!file.exists || file.size <= 0) throw new AppError('E_FILE_MISSING', '候选下载文件不存在');

  if (task.container === 'mp4' || task.container === 'fmp4' || /\.mp4$/i.test(path)) {
    const verdict = await verifyRemuxedMedia(path);
    if (!verdict) throw new AppError('E_LOCAL_CORRUPT', '当前版本无法复检候选 MP4，旧文件保持不变');
    if (!verdict.ok) throw new AppError('E_LOCAL_CORRUPT', `候选 MP4 复检未通过：${verdict.probeVerdict}`);
    return;
  }

  const index = task.hlsIndex;
  const indexPath = task.hlsIndexPath;
  if (
    !index
    || !indexPath
    || indexPath !== localHlsIndexPathOf(path)
    || task.hlsPlaylistFingerprint !== index.playlistFingerprint
    || !isCompleteLocalHlsIndex(index, task.hlsTotalSegments, file.size)
  ) {
    throw new AppError('E_LOCAL_CORRUPT', '候选 TS 没有完整的可拖动索引，旧文件保持不变');
  }
  const scan = await scanTsFile(path);
  if (!scan?.ok) throw new AppError('E_LOCAL_CORRUPT', '候选 TS 结构复检未通过');
  const manifest = await readTextFile(indexPath).catch(() => '');
  if (manifest !== buildLocalHlsManifest(index, path)) {
    throw new AppError('E_LOCAL_CORRUPT', '候选 TS 播放清单与字节索引不一致');
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path)).exists;
}

async function backup(path: string): Promise<boolean> {
  if (!await pathExists(path)) return false;
  const target = `${path}${BACKUP_SUFFIX}`;
  if (await pathExists(target)) throw new AppError('E_LOCAL_CORRUPT', '上次安全重下的备份仍在，请先处理后再试');
  await renameFile(path, target);
  return true;
}

async function restore(path: string): Promise<void> {
  const source = `${path}${BACKUP_SUFFIX}`;
  if (await pathExists(source)) await renameFile(source, path);
}

async function removeCommittedCandidate(candidate: DownloadTask): Promise<void> {
  try {
    await downloadRepo.remove(candidate.id);
  } catch (e) {
    logger.warn('安全重下已提交，候选记录清理失败', { taskId: candidate.id, error: e });
    await downloadRepo.save({
      ...candidate,
      status: 'failed',
      filePath: null,
      artifactPath: null,
      errorCode: 'E_DB',
      errorMessage: '安全重下已提交，候选记录清理失败；请删除该残留记录',
      updatedAt: Date.now(),
    }).catch((saveError) => {
      logger.error('安全重下候选残留记录状态写入失败', { taskId: candidate.id, error: saveError });
    });
  }
}

/** 候选下载成功后执行；只有复检通过才触碰旧产物。 */
export async function promoteReplacement(candidateId: string): Promise<void> {
  const candidate = await downloadRepo.get(candidateId);
  if (!candidate?.replacesTaskId) return;
  await verifyCandidate(candidate);
  const old = await downloadRepo.get(candidate.replacesTaskId);
  if (!old || old.status !== 'completed') throw new AppError('E_NOT_FOUND', '原下载记录已不存在');

  if (candidate.sink !== 'filesystem') {
    const next: DownloadTask = {
      ...old,
      blobKey: candidate.blobKey ?? candidate.id,
      filePath: null,
      downloadedBytes: candidate.downloadedBytes,
      totalBytes: candidate.totalBytes,
      container: candidate.container,
      remux: candidate.remux,
      hlsIndex: null,
      hlsIndexPath: null,
      hlsTotalSegments: 0,
      hlsDiscontinuities: 0,
      hlsPlaylistFingerprint: null,
      completedSegments: candidate.completedSegments ?? [],
      contentDigest: candidate.contentDigest,
      errorCode: null,
      errorMessage: null,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await downloadRepo.save(next);
    await removeCommittedCandidate(candidate);
    if (old.blobKey && old.blobKey !== next.blobKey) await blobRepo.delete(old.blobKey).catch(() => undefined);
    appEvents.emit('downloads:changed', { id: old.id });
    return;
  }

  const sourcePath = candidate.filePath ?? candidate.artifactPath;
  if (!sourcePath) throw new AppError('E_LOCAL_CORRUPT', '候选下载没有落盘路径');
  const oldPath = old.filePath ?? nativeFilePathOf(old);
  const isMp4 = candidate.container === 'mp4' || candidate.container === 'fmp4' || /\.mp4$/i.test(sourcePath);
  const finalPath = isMp4 ? oldPath.replace(/\.[^/.]+$/i, '.mp4') : oldPath;
  const oldManifest = old.hlsIndexPath ?? localHlsIndexPathOf(oldPath);
  const finalManifest = candidate.hlsIndex ? localHlsIndexPathOf(finalPath) : null;
  const touched = Array.from(new Set([
    oldPath,
    oldManifest,
    finalPath,
    ...(finalManifest ? [finalManifest] : []),
  ]));
  const backed: string[] = [];
  let installed = false;
  let manifestWritten = false;
  let committed = false;

  try {
    for (const path of touched) {
      if (await backup(path)) backed.push(path);
    }
    await renameFile(sourcePath, finalPath);
    installed = true;
    if (candidate.hlsIndex) {
      await writeLocalHlsIndex(finalPath, candidate.hlsIndex);
      manifestWritten = true;
    }

    const latest = await downloadRepo.get(old.id);
    if (!latest) throw new AppError('E_NOT_FOUND');
    await downloadRepo.save({
      ...latest,
      filePath: finalPath,
      artifactPath: null,
      replacesTaskId: null,
      blobKey: null,
      downloadedBytes: candidate.downloadedBytes,
      totalBytes: candidate.totalBytes,
      container: candidate.container,
      remux: candidate.remux,
      hlsIndex: candidate.hlsIndex ?? null,
      hlsIndexPath: finalManifest,
      hlsTotalSegments: candidate.hlsTotalSegments ?? 0,
      hlsDiscontinuities: candidate.hlsDiscontinuities ?? 0,
      hlsPlaylistFingerprint: candidate.hlsPlaylistFingerprint ?? null,
      completedSegments: candidate.completedSegments ?? [],
      contentDigest: candidate.contentDigest,
      errorCode: null,
      errorMessage: null,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    committed = true;
    await removeCommittedCandidate(candidate);
    appEvents.emit('downloads:changed', { id: old.id });
  } catch (e) {
    if (!committed) {
      if (manifestWritten && finalManifest) await deleteFile(finalManifest).catch(() => undefined);
      if (installed) {
        if (sourcePath !== finalPath) {
          await renameFile(finalPath, sourcePath).catch(async (error) => {
            logger.error('安全重下候选产物恢复失败', { sourcePath, finalPath, error });
            await deleteFile(finalPath).catch(() => undefined);
          });
        } else {
          await deleteFile(finalPath).catch(() => undefined);
        }
      }
      for (const path of backed.reverse()) await restore(path).catch((error) => {
        logger.error('安全重下回滚失败', { path, error });
      });
    }
    throw e;
  }

  if (committed) {
    for (const path of backed) await deleteFile(`${path}${BACKUP_SUFFIX}`).catch(() => undefined);
    if (candidate.hlsIndexPath && candidate.hlsIndexPath !== finalManifest) {
      await deleteFile(candidate.hlsIndexPath).catch(() => undefined);
    }
  }
}
