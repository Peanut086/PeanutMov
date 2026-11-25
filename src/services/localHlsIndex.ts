import { AppError } from '@/shared/errors';
import { arrayBufferToBase64, deleteFile, renameFile, writeBase64 } from '@/native/fs';
import type { DownloadHlsIndex } from '@/types';

export function localHlsIndexPathOf(videoPath: string): string {
  return /\.[^/.]+$/.test(videoPath)
    ? videoPath.replace(/\.[^/.]+$/, '.m3u8')
    : `${videoPath}.m3u8`;
}

export function isCompleteLocalHlsIndex(
  index: DownloadHlsIndex | null | undefined,
  expectedSegments?: number,
  fileSize?: number,
): boolean {
  if (!index || index.version !== 1) return false;
  if (!Number.isSafeInteger(index.mediaSequence) || index.mediaSequence < 0) return false;
  if (!Number.isSafeInteger(index.targetDuration) || index.targetDuration < 0) return false;
  const total = expectedSegments ?? index.segments.length;
  if (total <= 0 || index.segments.length !== total) return false;

  let offset = 0;
  for (let i = 0; i < total; i += 1) {
    const segment = index.segments[i];
    if (!segment || segment.index !== i || segment.offset !== offset) return false;
    if (!Number.isSafeInteger(segment.length) || segment.length <= 0) return false;
    if (!Number.isFinite(segment.duration) || segment.duration < 0) return false;
    if (typeof segment.discontinuity !== 'boolean') return false;
    offset += segment.length;
    if (!Number.isSafeInteger(offset)) return false;
  }
  return fileSize === undefined || offset === fileSize;
}

export function buildLocalHlsManifest(index: DownloadHlsIndex, videoPath: string): string {
  if (!isCompleteLocalHlsIndex(index)) {
    throw new AppError('E_LOCAL_CORRUPT', '本地 HLS 索引不完整，无法生成播放清单');
  }
  const filename = videoPath.split('/').pop() ?? videoPath;
  const uri = encodeURIComponent(filename);
  const longest = Math.max(...index.segments.map((segment) => segment.duration));
  const targetDuration = Math.max(1, index.targetDuration, Math.ceil(longest));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${index.mediaSequence}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (const segment of index.segments) {
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(
      `#EXTINF:${segment.duration.toFixed(3)},`,
      `#EXT-X-BYTERANGE:${segment.length}@${segment.offset}`,
      uri,
    );
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export async function writeLocalHlsIndex(videoPath: string, index: DownloadHlsIndex): Promise<string> {
  const path = localHlsIndexPathOf(videoPath);
  const partPath = `${path}.part`;
  const bytes = new TextEncoder().encode(buildLocalHlsManifest(index, videoPath));
  try {
    await writeBase64(partPath, arrayBufferToBase64(bytes.buffer));
    await renameFile(partPath, path);
    return path;
  } catch (e) {
    await deleteFile(partPath).catch(() => undefined);
    throw e;
  }
}
