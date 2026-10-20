/**
 * 无限滚动（IntersectionObserver + 分页）
 *
 * 用法：
 * ```ts
 * const { sentinelRef, isTriggered } = useInfiniteScroll({
 *   hasMore: () => lib.hasMore,
 *   loading: () => lib.state === 'refreshing',
 *   onLoadMore: () => lib.loadNextPage(),
 * });
 * ```
 * sentinel 元素放到列表底部，进入视口（下边距 300px）即触发下一页。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

import { INFINITE_SCROLL_THRESHOLD_PX } from '@/shared/constants';

export interface InfiniteScrollOptions {
  hasMore: () => boolean;
  loading: () => boolean;
  onLoadMore: () => void | Promise<void>;
  /** 视口下方提前触发的距离，默认 300px */
  rootMarginPx?: number;
}

export function useInfiniteScroll(options: InfiniteScrollOptions): {
  sentinelRef: Ref<HTMLElement | null>;
  isTriggered: Ref<boolean>;
} {
  const sentinelRef = ref<HTMLElement | null>(null);
  const isTriggered = ref(false);
  let observer: IntersectionObserver | null = null;

  const tryLoad = (): void => {
    if (!options.hasMore() || options.loading()) return;
    isTriggered.value = true;
    void options.onLoadMore();
    // 下一帧复位，允许重复触发（observer 会在滚动中再次回调）
    setTimeout(() => {
      isTriggered.value = false;
    }, 400);
  };

  const connect = (el: HTMLElement | null): void => {
    observer?.disconnect();
    observer = null;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const margin = options.rootMarginPx ?? INFINITE_SCROLL_THRESHOLD_PX;
    observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (hit) tryLoad();
      },
      { rootMargin: `0px 0px ${margin}px 0px`, threshold: 0 },
    );
    observer.observe(el);
  };

  watch(sentinelRef, (el) => connect(el), { flush: 'post' });

  onMounted(() => connect(sentinelRef.value));

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { sentinelRef, isTriggered };
}
