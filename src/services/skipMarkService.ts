/**
 * 片头/片尾标记（B-06）
 *
 * 记在**剧集**（mediaId）上而不是单集：标一次整季复用，这才是追剧要的效果。
 * 落在通用 `kv`（键 `skipmark:<mediaId>`）——只有按 mediaId 点查的需要，不建索引，
 * 不值得为它升一次 IndexedDB 版本。
 *
 * 边界存「秒」而不是比例：同剧各集时长不同，比例会把片尾算歪。
 */
import { ref, type Ref } from 'vue';

import { kvRepo } from '@/db/repositories/kvRepo';
import type { SkipMarks } from '@/types';

const PREFIX = 'skipmark:';
/** 边界离片头/片尾太近（如片头 2 秒）没有跳的意义，也会让胶囊一闪而过 */
const MIN_INTRO_SEC = 3;
const MIN_CREDITS_TAIL_SEC = 5;

function keyOf(mediaId: string): string {
  return `${PREFIX}${mediaId}`;
}

/** 每个 mediaId 一个 ref：换剧时各自独立，不会出现上一部的区间残留 */
const entries = new Map<string, Ref<SkipMarks | null>>();
const loadedKeys = new Set<string>();

export function marksRef(mediaId: string): Ref<SkipMarks | null> {
  let entry = entries.get(mediaId);
  if (!entry) {
    entry = ref(null);
    entries.set(mediaId, entry);
  }
  return entry;
}

/** 首次读取；播放页进集时调用，后续标记/清除都直接改同一个 ref */
export async function loadMarks(mediaId: string): Promise<SkipMarks | null> {
  const entry = marksRef(mediaId);
  if (loadedKeys.has(mediaId)) return entry.value;
  const stored = await kvRepo.get<SkipMarks | null>(keyOf(mediaId));
  // 并发调用只保留一次落位；标记可能在等待期间发生，不覆盖已写好的值
  loadedKeys.add(mediaId);
  if (entry.value === null) entry.value = stored ?? null;
  return entry.value;
}

function isValidIntro(sec: number, duration: number): boolean {
  return Number.isFinite(sec) && sec >= MIN_INTRO_SEC && sec < duration - MIN_CREDITS_TAIL_SEC;
}

function isValidCredits(sec: number, duration: number): boolean {
  return Number.isFinite(sec) && sec > MIN_CREDITS_TAIL_SEC && sec <= duration - MIN_CREDITS_TAIL_SEC;
}

/** 写片头结束点；非法区间返回 false 且不改任何数据 */
export async function markIntroEnd(mediaId: string, sec: number, duration: number): Promise<boolean> {
  if (!isValidIntro(sec, duration)) return false;
  const introEndSec = Math.round(sec);
  const prevCredits = marksRef(mediaId).value?.creditsStartSec ?? null;
  // 新区间把旧片尾吃掉了（片尾跑到片头前面）：宁可丢一侧，也不留一段永远跳不对的标记
  const creditsStartSec = prevCredits !== null && prevCredits > introEndSec ? prevCredits : null;
  const next: SkipMarks = { introEndSec, creditsStartSec, updatedAt: Date.now() };
  await kvRepo.set(keyOf(mediaId), next);
  marksRef(mediaId).value = next;
  loadedKeys.add(mediaId);
  return true;
}

/** 写片尾开始点；非法区间返回 false 且不改任何数据 */
export async function markCreditsStart(mediaId: string, sec: number, duration: number): Promise<boolean> {
  if (!isValidCredits(sec, duration)) return false;
  const creditsStartSec = Math.round(sec);
  const prevIntro = marksRef(mediaId).value?.introEndSec ?? null;
  const introEndSec = prevIntro !== null && prevIntro < creditsStartSec ? prevIntro : null;
  const next: SkipMarks = { introEndSec, creditsStartSec, updatedAt: Date.now() };
  await kvRepo.set(keyOf(mediaId), next);
  marksRef(mediaId).value = next;
  loadedKeys.add(mediaId);
  return true;
}

/** 只清一侧（标记错了时不用整条重标） */
export async function clearSide(mediaId: string, side: 'intro' | 'credits'): Promise<void> {
  const current = marksRef(mediaId).value;
  if (!current) return;
  const next: SkipMarks = {
    introEndSec: side === 'intro' ? null : current.introEndSec,
    creditsStartSec: side === 'credits' ? null : current.creditsStartSec,
    updatedAt: Date.now(),
  };
  if (next.introEndSec === null && next.creditsStartSec === null) {
    await clearMarks(mediaId);
    return;
  }
  await kvRepo.set(keyOf(mediaId), next);
  marksRef(mediaId).value = next;
}

export async function clearMarks(mediaId: string): Promise<void> {
  await kvRepo.delete(keyOf(mediaId));
  marksRef(mediaId).value = null;
  loadedKeys.add(mediaId);
}

export const skipMarkService = {
  marksRef,
  loadMarks,
  markIntroEnd,
  markCreditsStart,
  clearSide,
  clearMarks,
};
