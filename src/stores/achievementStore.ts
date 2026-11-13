/**
 * 成就 / 彩蛋池 Store（F2 爆米花桶里程碑）
 *
 * 两部分：
 * - 连看会话计数（内存）：跨播放页逐集重建存活；离开播放页由路由守卫复位；
 * - 已 earned 徽章（kvRepo 持久化）：首页入口读取。
 *
 * 播放页每切一集都会重建（App.vue 以 fullPath 为 key），所以会话计数不能放在
 * 组件局部 ref，也不能放在 playerStore（其 reset 每次卸载都跑）。这里独立持有。
 * 仪式何时播放由播放页决定（暂停 / 片尾），本 store 只负责计数、落徽章与 pending 标记。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { kvRepo } from '@/db/repositories/kvRepo';
import { logger } from '@/shared/logger';
import { newId } from '@/shared/id';

export interface AchievementBadge {
  id: string;
  kind: 'binge';
  count: number;
  mediaId: string;
  title: string | null;
  earnedAt: number;
}

const KV_KEY = 'achievement-badges';
const BADGE_MAX = 30;
/** 连看里程碑集数 */
export const BINGE_MILESTONE = 3;

function isBadge(v: unknown): v is AchievementBadge {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    b.kind === 'binge' &&
    typeof b.id === 'string' &&
    typeof b.count === 'number' &&
    typeof b.earnedAt === 'number'
  );
}

export const useAchievementStore = defineStore('achievement', () => {
  const badges = ref<AchievementBadge[]>([]);
  const loaded = ref(false);

  /* 连看会话（内存，不落库） */
  const bingeMediaId = ref<string | null>(null);
  const bingeLastEp = ref<string | null>(null);
  const bingeCount = ref(0);
  const bingePending = ref(false);
  let bingeReached = false;

  const latestBingeBadge = computed<AchievementBadge | null>(() => {
    for (let i = badges.value.length - 1; i >= 0; i -= 1) {
      const b = badges.value[i];
      if (b && b.kind === 'binge') return b;
    }
    return null;
  });

  async function load(): Promise<void> {
    if (loaded.value) return;
    try {
      const stored = await kvRepo.get<AchievementBadge[]>(KV_KEY);
      badges.value = Array.isArray(stored) ? stored.filter(isBadge) : [];
    } catch (e) {
      logger.warn('成就徽章读取失败', e);
      badges.value = [];
    } finally {
      loaded.value = true;
    }
  }

  async function persist(): Promise<void> {
    try {
      await kvRepo.set(KV_KEY, badges.value);
    } catch (e) {
      logger.warn('成就徽章写入失败', e);
    }
  }

  async function earnBingeBadge(mediaId: string, title: string | null): Promise<void> {
    const badge: AchievementBadge = {
      id: newId(),
      kind: 'binge',
      count: bingeCount.value,
      mediaId,
      title,
      earnedAt: Date.now(),
    };
    badges.value = [...badges.value, badge].slice(-BADGE_MAX);
    await persist();
  }

  /**
   * 记录一次「进入某集」。同一部片连续进入不同集 → 计数 +1；换片复位；
   * 重复进入同一集（重建 / 回退）不计数。返回当前连看集数。
   * 首次达到里程碑：置 pending（仪式由播放页择机播放）并立即落徽章，
   * 这样即使仪式被推迟，首页入口也能马上看到成就。
   */
  function noteEpisodeEntry(mediaId: string, episodeId: string | null, title: string | null): number {
    const epKey = episodeId ?? '__first__';
    if (mediaId !== bingeMediaId.value) {
      bingeMediaId.value = mediaId;
      bingeLastEp.value = epKey;
      bingeCount.value = 1;
      bingeReached = false;
      bingePending.value = false;
      return 1;
    }
    if (epKey !== bingeLastEp.value) {
      bingeLastEp.value = epKey;
      bingeCount.value += 1;
    }
    if (bingeCount.value >= BINGE_MILESTONE && !bingeReached) {
      bingeReached = true;
      bingePending.value = true;
      void earnBingeBadge(mediaId, title);
    }
    return bingeCount.value;
  }

  function clearBingePending(): void {
    bingePending.value = false;
  }

  function resetBingeSession(): void {
    bingeMediaId.value = null;
    bingeLastEp.value = null;
    bingeCount.value = 0;
    bingePending.value = false;
    bingeReached = false;
  }

  return {
    badges,
    loaded,
    latestBingeBadge,
    bingeCount,
    bingePending,
    load,
    noteEpisodeEntry,
    clearBingePending,
    resetBingeSession,
  };
});

export type AchievementStore = ReturnType<typeof useAchievementStore>;