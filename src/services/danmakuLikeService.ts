/**
 * 弹幕点赞（B-04）
 *
 * 源站弹幕是只读流，没有可靠 id：同一秒同一句话可能重复出现，换源后顺序也会变。
 * 身份只能自己算——用「秒 + 文本哈希」，按「剧集 + 集号」分桶存进通用 `kv`。
 *
 * 计数只有本地这一份：点赞是「这条我觉得有意思」的记号，不往任何源站回写。
 */
import { ref, type Ref } from 'vue';

import { kvRepo } from '@/db/repositories/kvRepo';
import type { DanmakuComment } from '@/types';

const PREFIX = 'danmakuLikes:';

type LikeBook = Record<string, number>;

/** 每个分桶一个 ref：换集/换剧各自独立，不会把上一部的赞带过来 */
const entries = new Map<string, Ref<LikeBook>>();
const loadedKeys = new Set<string>();

function bucketKey(mediaId: string, episodeNumber: number | string): string {
  return `${PREFIX}${mediaId}#${episodeNumber}`;
}

/** FNV-1a：够短、够稳，同一条弹幕在任意次拉取里算出同一个键 */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 弹幕身份：时间抹到 0.1s，避开各源解析出来的尾数抖动 */
export function likeKey(comment: DanmakuComment): string {
  return `${comment.time.toFixed(1)}:${hashText(comment.text)}`;
}

export function countsRef(mediaId: string, episodeNumber: number | string): Ref<LikeBook> {
  const key = bucketKey(mediaId, episodeNumber);
  let entry = entries.get(key);
  if (!entry) {
    entry = ref<LikeBook>({});
    entries.set(key, entry);
  }
  return entry;
}

/** 首次读取；进入某集时调用，之后的点赞都直接改同一个 ref */
export async function loadLikes(mediaId: string, episodeNumber: number | string): Promise<LikeBook> {
  const key = bucketKey(mediaId, episodeNumber);
  const entry = countsRef(mediaId, episodeNumber);
  if (loadedKeys.has(key)) return entry.value;
  const stored = await kvRepo.get<LikeBook>(key);
  loadedKeys.add(key);
  // 等待期间可能已经点过赞，不能拿旧数据盖回去
  if (Object.keys(entry.value).length === 0 && stored) entry.value = stored;
  return entry.value;
}

/** 点赞/取消，返回操作后是否为已赞 */
export async function toggleLike(
  mediaId: string,
  episodeNumber: number | string,
  comment: DanmakuComment,
): Promise<boolean> {
  const key = bucketKey(mediaId, episodeNumber);
  const entry = countsRef(mediaId, episodeNumber);
  const id = likeKey(comment);
  const next: LikeBook = { ...entry.value };
  const liked = (next[id] ?? 0) === 0;
  if (liked) next[id] = 1;
  else delete next[id];
  entry.value = next;
  await kvRepo.set(key, next);
  loadedKeys.add(key);
  return liked;
}

export const danmakuLikeService = {
  likeKey,
  countsRef,
  loadLikes,
  toggleLike,
};

/**
 * 备份导入后调用：内存分桶与 `loadedKeys` 属于导入前的设备状态，
 * 不清掉的话已看过的集永远不会重读刚落库的点赞。
 */
export function resetDanmakuLikeCache(): void {
  entries.clear();
  loadedKeys.clear();
}
