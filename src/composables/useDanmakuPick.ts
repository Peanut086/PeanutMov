/**
 * 弹幕互动层（B-04）
 *
 * 把「单击命中一条弹幕」变成「它停住 + 头顶出点赞/复制/定位」。
 *
 * 关键取舍：canvas 永远 `pointer-events:none`，命中判定由手势层递进来的坐标做。
 * 所以互动开关关掉只是这条链路提前 return，手势/控制条行为与现状一字不差——
 * 不会出现「开了互动，点哪儿都不出控制条」这种抢手势的事故。
 *
 * 冻结有 `DANMAKU_PICK_MAX_MS` 上限：超时自动放行，别让一条弹幕挂在画面上不走。
 */
import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue';

import { DanmakuOverlay, type DanmakuPick as PickHit } from '@/player/DanmakuOverlay';
import { DANMAKU_PICK_MAX_MS } from '@/player/constants';
import { danmakuLikeService } from '@/services/danmakuLikeService';

export interface DanmakuPickApi {
  /** 当前被点中的弹幕（含它在画面里的矩形）；null = 没点中或已放行 */
  pick: Ref<PickHit | null>;
  liked: ComputedRef<boolean>;
  likeCount: ComputedRef<number>;
  /**
   * 手势层递来一次单击坐标。命中返回 true（这次单击已被吃掉，不该再开关控制条），
   * 没命中返回 false 并顺手收掉上一次的操作条。
   */
  tapAt: (clientX: number, clientY: number) => boolean;
  /** 点赞/取消，返回操作后是否为已赞 */
  toggleLike: () => Promise<boolean>;
  /** 把播放进度跳到该弹幕的出现时间 */
  locate: () => void;
  copyText: () => void;
  close: () => void;
}

const WATCH_INTERVAL_MS = 200;

export function useDanmakuPick(input: {
  overlay: ShallowRef<DanmakuOverlay | null>;
  /** 互动开关：settings.danmaku.interactive 且不在 PiP */
  enabled: Ref<boolean>;
  mediaId: Ref<string>;
  episodeNumber: Ref<number | null>;
  seek: (sec: number) => void;
  copy: (text: string) => void;
}): DanmakuPickApi {
  const pick = ref<PickHit | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let pickedAt = 0;

  function stopTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function close(): void {
    stopTimer();
    input.overlay.value?.releasePick();
    pick.value = null;
  }

  function bucket(): number | string {
    return input.episodeNumber.value ?? 0;
  }

  const likes = computed(() => danmakuLikeService.countsRef(input.mediaId.value, bucket()).value);
  const liked = computed(() => {
    const comment = pick.value?.comment;
    if (!comment) return false;
    return (likes.value[danmakuLikeService.likeKey(comment)] ?? 0) > 0;
  });
  const likeCount = computed(() => {
    const comment = pick.value?.comment;
    return comment ? (likes.value[danmakuLikeService.likeKey(comment)] ?? 0) : 0;
  });

  /**
   * 200ms 看一眼而不是只挂一个 4s 定时器：
   * seek / 换集 / 改显示区域都会让渲染层自己丢掉冻结的条目，操作条得跟着收，
   * 否则会悬在画面上指着一条已经不存在的位置。
   */
  function startTimer(): void {
    stopTimer();
    pickedAt = Date.now();
    timer = setInterval(() => {
      const overlay = input.overlay.value;
      if (!overlay || overlay.pickedComment === null || Date.now() - pickedAt >= DANMAKU_PICK_MAX_MS) close();
    }, WATCH_INTERVAL_MS);
  }

  function tapAt(clientX: number, clientY: number): boolean {
    const overlay = input.overlay.value;
    if (!overlay || !input.enabled.value) return false;
    const hit = overlay.pick(clientX, clientY);
    if (!hit) {
      close();
      return false;
    }
    pick.value = hit;
    void danmakuLikeService.loadLikes(input.mediaId.value, bucket());
    startTimer();
    return true;
  }

  async function toggleLike(): Promise<boolean> {
    const comment = pick.value?.comment;
    if (!comment) return false;
    return danmakuLikeService.toggleLike(input.mediaId.value, bucket(), comment);
  }

  function locate(): void {
    const comment = pick.value?.comment;
    if (!comment) return;
    input.seek(comment.time);
    close();
  }

  function copyText(): void {
    const comment = pick.value?.comment;
    if (!comment) return;
    input.copy(comment.text);
  }

  // 关掉开关 / 换集换剧：都不该把上一次的操作条留在画面上
  watch(input.enabled, (on) => {
    if (!on) close();
  });
  watch(
    () => [input.mediaId.value, input.episodeNumber.value] as const,
    () => close(),
  );

  // 组件外的作用域里调用（如单测直接起）没有可挂靠的 scope，不能强注册
  if (getCurrentScope()) onScopeDispose(stopTimer);

  return { pick, liked, likeCount, tapAt, toggleLike, locate, copyText, close };
}
