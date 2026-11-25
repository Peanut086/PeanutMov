import { downloadRepo } from '@/db/repositories/downloadRepo';
import { deleteFile, readTextFile, stat } from '@/native/fs';
import { scanTsTimelineFile, type TsTimelineScanResult } from '@/native/mediaToolPlugin';
import { appEvents } from '@/services/events';
import {
  buildLocalHlsManifest,
  isCompleteLocalHlsIndex,
  localHlsIndexPathOf,
  writeLocalHlsIndex,
} from '@/services/localHlsIndex';
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { DownloadHlsIndex, DownloadTask } from '@/types';

export type LocalTsRepairStatus = 'repaired' | 'already' | 'unsupported' | 'unreliable';

export interface LocalTsRepairResult {
  status: LocalTsRepairStatus;
  message: string;
  durationSec?: number;
  segments?: number;
}

export function isRepairableTsTask(task: DownloadTask): boolean {
  return task.status === 'completed'
    && task.sink === 'filesystem'
    && task.format === 'hls'
    && task.container !== 'fmp4'
    && task.container !== 'mp4'
    && typeof task.filePath === 'string'
    && /\.ts$/i.test(task.filePath);
}

export function buildTimelineHlsIndex(
  scan: TsTimelineScanResult,
  fileSize: number,
): DownloadHlsIndex | null {
  if (!scan.timelineReliable || !scan.ok || scan.fileSize !== fileSize || scan.alignedStart !== 0) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || scan.segments.length === 0) return null;

  let expectedOffset = 0;
  const segments = scan.segments.map((segment, index) => {
    const nextOffset = scan.segments[index + 1]?.offset ?? fileSize;
    const offset = index === 0 ? 0 : segment.offset;
    if (
      !Number.isSafeInteger(segment.offset)
      || !Number.isSafeInteger(nextOffset)
      || segment.offset < 0
      || (index > 0 && segment.offset !== expectedOffset)
      || nextOffset <= segment.offset
      || nextOffset > fileSize
      || !Number.isFinite(segment.durationUs)
      || segment.durationUs <= 0
    ) {
      throw new AppError('E_LOCAL_CORRUPT', 'TS 时间轴扫描返回了无效的字节边界');
    }
    expectedOffset = nextOffset;
    return {
      index,
      offset,
      length: nextOffset - offset,
      duration: segment.durationUs / 1_000_000,
      discontinuity: segment.discontinuity === true || index > 0,
    };
  });
  const fingerprint = `local-ts-${fileSize}-${Math.round(scan.durationUs)}-${segments.length}`;
  const index: DownloadHlsIndex = {
    version: 1,
    playlistFingerprint: fingerprint,
    targetDuration: Math.max(1, Math.ceil(Math.max(...segments.map((segment) => segment.duration)))),
    mediaSequence: 0,
    segments,
  };
  return isCompleteLocalHlsIndex(index, segments.length, fileSize) ? index : null;
}

async function hasValidManifest(task: DownloadTask, fileSize: number): Promise<boolean> {
  const index = task.hlsIndex;
  const path = task.hlsIndexPath;
  if (!index || !path || path !== localHlsIndexPathOf(task.filePath!)) return false;
  if (task.hlsPlaylistFingerprint !== index.playlistFingerprint) return false;
  if (!isCompleteLocalHlsIndex(index, task.hlsTotalSegments, fileSize)) return false;
  try {
    return await readTextFile(path) === buildLocalHlsManifest(index, task.filePath!);
  } catch {
    return false;
  }
}

/** 保留原 TS，只在真实时间轴可扫描时补一份同目录 BYTERANGE 清单。 */
export async function repairLocalTsIndex(
  taskId: string,
  options: { force?: boolean } = {},
): Promise<LocalTsRepairResult> {
  const task = await downloadRepo.get(taskId);
  if (!task) throw new AppError('E_NOT_FOUND');
  if (!isRepairableTsTask(task)) {
    throw new AppError('E_INVALID_INPUT', '只有已完成的 TS 下载可以修复拖动索引');
  }
  const path = task.filePath!;
  const file = await stat(path);
  if (!file.exists || file.size <= 0) throw new AppError('E_FILE_MISSING');

  if (!options.force && await hasValidManifest(task, file.size)) {
    return { status: 'already', message: '拖动索引已存在' };
  }

  const scan = await scanTsTimelineFile(path);
  if (!scan) {
    return { status: 'unsupported', message: '当前 App 版本不支持时间轴扫描，请更新后重试' };
  }
  if (!scan.ok || !scan.timelineReliable) {
    const reason = scan.verdict === 'no-timeline'
      ? '没有读到可靠的视频时间轴'
      : `文件时间轴扫描未通过（${scan.verdict}）`;
    return { status: 'unreliable', message: `${reason}，原文件保持不变` };
  }

  const index = buildTimelineHlsIndex(scan, file.size);
  if (!index) {
    return { status: 'unreliable', message: '时间轴边界不完整，原文件保持不变' };
  }

  const indexPath = await writeLocalHlsIndex(path, index);
  try {
    const latest = await downloadRepo.get(taskId);
    if (!latest) throw new AppError('E_NOT_FOUND');
    await downloadRepo.save({
      ...latest,
      hlsIndex: index,
      hlsIndexPath: indexPath,
      hlsTotalSegments: index.segments.length,
      hlsDiscontinuities: index.segments.filter((segment) => segment.discontinuity).length,
      hlsPlaylistFingerprint: index.playlistFingerprint,
      updatedAt: Date.now(),
    });
  } catch (e) {
    await deleteFile(indexPath).catch(() => undefined);
    throw e;
  }
  appEvents.emit('downloads:changed', { id: taskId });
  logger.info('存量 TS 已生成真实时间轴索引', {
    taskId,
    durationUs: scan.durationUs,
    segments: index.segments.length,
    source: scan.timelineSource,
  });
  return {
    status: 'repaired',
    message: '已生成拖动索引，原视频文件未改动',
    durationSec: scan.durationUs / 1_000_000,
    segments: index.segments.length,
  };
}
