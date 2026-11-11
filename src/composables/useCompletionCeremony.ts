/**
 * 下载完成收尾仪式的编排（C-11）
 *
 * 只做一件事：从任务数组里挑出「刚刚完成」的那些，并决定谁配庆祝。
 * 一次只完成一项 → 那一行放收尾动画；一次完成一批 → 只有汇总卡庆祝，
 * 单项静默变勾，否则缓存 12 集会满屏放烟花。
 *
 * 首次 observe 只登记基线，不给庆祝：进页面时列表里已有的已完成任务不该一进来就跳舞。
 */
import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';

import type { DownloadTask } from '@/types';

/** 庆祝状态存活时长：与 CSS 编舞的总时长对齐，到点自动摘 class */
export const CEREMONY_MS = 800;

export interface CompletionCeremonyApi {
  /** 刚完成、该放收尾动画的那一项（批量完成时为 null） */
  celebrateId: Ref<string | null>;
  /** 批量完成：汇总卡庆祝一次 */
  celebrateSummary: Ref<boolean>;
  /** 每次任务数组变化时调用，返回本轮新增的已完成任务 */
  observe: (tasks: DownloadTask[]) => { fresh: DownloadTask[]; bulk: boolean };
}

export function useCompletionCeremony(): CompletionCeremonyApi {
  const celebrateId = ref<string | null>(null);
  const celebrateSummary = ref(false);
  const seen = new Set<string>();
  let primed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    celebrateId.value = null;
    celebrateSummary.value = false;
  }

  function observe(tasks: DownloadTask[]): { fresh: DownloadTask[]; bulk: boolean } {
    const completed = tasks.filter((t) => t.status === 'completed');
    const alive = new Set(completed.map((t) => t.id));
    for (const id of seen) {
      if (!alive.has(id)) seen.delete(id);
    }

    const fresh = primed ? completed.filter((t) => !seen.has(t.id)) : [];
    for (const task of completed) seen.add(task.id);
    primed = true;
    if (fresh.length === 0) return { fresh, bulk: false };

    const bulk = fresh.length > 1;
    clear();
    if (bulk) celebrateSummary.value = true;
    else celebrateId.value = fresh[0]?.id ?? null;
    timer = setTimeout(clear, CEREMONY_MS);
    return { fresh, bulk };
  }

  if (getCurrentScope()) onScopeDispose(clear);

  return { celebrateId, celebrateSummary, observe };
}
