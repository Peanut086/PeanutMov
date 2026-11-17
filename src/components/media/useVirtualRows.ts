/**
 * 固定行高虚拟滚动（日志列表专用）。
 *
 * 与 useVirtualGrid（网格、可变列数）不同：日志行等高（单行截断，全文看详情抽屉），
 * 所以窗口计算是纯乘除，不需要高度测量与前缀和。窗口数学抽成纯函数便于单测。
 */
import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue';

/** 由 scrollTop / 视口高 / 总行数算出可见行窗口（含上下 overscan） */
export function computeWindow(
  scrollTop: number,
  viewportH: number,
  count: number,
  rowHeight: number,
  overscan: number,
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0 || viewportH <= 0) return { start: 0, end: 0 };
  // start 必须有上界：overscroll/回弹会让 scrollTop 短暂超过内容总高，
  // 不钳制则 padTop 越界、最后几行反而渲染不出。
  // 钳到 count-可见行 = 正常滚到底的窗口，而不是退回 0（那会全量渲染，虚拟滚动失效）。
  const maxStart = Math.max(0, count - Math.ceil(viewportH / rowHeight));
  const start = Math.min(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan), maxStart);
  const end = Math.min(count, Math.ceil((scrollTop + viewportH) / rowHeight) + overscan);
  return { start, end };
}

export function useVirtualRows(count: Ref<number>, rowHeight = 22, overscan = 10) {
  const containerRef = ref<HTMLElement | null>(null);
  const scrollTop = ref(0);
  const viewportH = ref(0);

  const win = computed(() =>
    computeWindow(scrollTop.value, viewportH.value, count.value, rowHeight, overscan),
  );
  const totalHeight = computed(() => count.value * rowHeight);
  const padTop = computed(() => win.value.start * rowHeight);
  const padBottom = computed(() => (count.value - win.value.end) * rowHeight);

  function onScroll(): void {
    if (containerRef.value) scrollTop.value = containerRef.value.scrollTop;
  }

  function measure(): void {
    if (containerRef.value) viewportH.value = containerRef.value.clientHeight;
  }

  let ro: ResizeObserver | null = null;

  onMounted(() => {
    measure();
    containerRef.value?.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
      ro = new ResizeObserver(measure);
      ro.observe(containerRef.value);
    }
  });

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', onScroll);
    ro?.disconnect();
    ro = null;
  });

  function scrollToIndex(index: number): void {
    if (!containerRef.value) return;
    containerRef.value.scrollTop = Math.max(0, index) * rowHeight;
  }

  function scrollToBottom(): void {
    if (!containerRef.value) return;
    containerRef.value.scrollTop = containerRef.value.scrollHeight;
  }

  function scrollToTop(): void {
    if (!containerRef.value) return;
    containerRef.value.scrollTop = 0;
  }

  /** 行顶部的 y 坐标（用于命中测试：点击行反查索引） */
  function indexOfClientY(clientY: number): number {
    if (!containerRef.value) return 0;
    const rect = containerRef.value.getBoundingClientRect();
    return Math.max(0, Math.floor((clientY - rect.top + scrollTop.value) / rowHeight));
  }

  return {
    containerRef,
    win,
    totalHeight,
    padTop,
    padBottom,
    scrollToIndex,
    scrollToBottom,
    scrollToTop,
    indexOfClientY,
    scrollTop,
    viewportH,
  };
}
