/**
 * 通用展示工具（组件内复用的小函数，非业务逻辑）
 *
 * 仅做"数据 → 中文展示文案"的映射；不访问 Store/Service。
 */
import type { MediaFormat, MediaItem, MediaType } from '@/types';

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  movie: '电影',
  series: '剧集',
  anime: '动漫',
  variety: '综艺',
  other: '其它',
};

export const MEDIA_FORMAT_LABELS: Record<MediaFormat, string> = {
  mp4: 'MP4',
  hls: 'HLS',
  webm: 'WebM',
  ts: 'TS',
  other: '其它',
};

export function mediaTypeLabel(type: MediaType | null | undefined): string {
  return type ? MEDIA_TYPE_LABELS[type] : '未知';
}

/** 列表副标题：`2021 · 剧集`（缺年份时只显示类型） */
export function mediaSubtitle(item: Pick<MediaItem, 'year' | 'type'>): string {
  const parts: string[] = [];
  if (item.year !== null) parts.push(String(item.year));
  parts.push(mediaTypeLabel(item.type));
  return parts.join(' · ');
}

/** 体积文案：`128.4 MB` / `2.4 GB`（设计规范 §11） */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

/** 速度文案：`12.3 MB/s` */
export function formatSpeed(bps: number | null | undefined): string {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return '0 B/s';
  const mb = bps / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

/** 0~1 → 整数百分比（不带 % 号） */
export function toPercent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/** 剩余时间估算：`2 分 30 秒` / `1 小时 5 分`；无法估算返回空串 */
export function formatEta(remainBytes: number, bps: number): string {
  if (!Number.isFinite(remainBytes) || remainBytes <= 0 || !Number.isFinite(bps) || bps <= 0) return '';
  const sec = Math.round(remainBytes / bps);
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
