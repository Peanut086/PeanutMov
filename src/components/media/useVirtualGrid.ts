/**
 * 虚拟网格（REV-11）
 *
 * 目的：把"渲染 N 个卡片"限制成"只渲染视口附近的卡片"。规则网格 + 固定行高，
 * 因此不需要测量真实 DOM：按列数、海报比例与间距直接算出每行高度。
 *
 * 关键取舍：
 * - **只在条目足够多时启用**（默认 >40 行）。少量条目下虚拟化反而会引入
 *   滚动位置抖动与首屏占位计算，收益为负。
 * - 行高用 CSS 变量推导而非写死，与 `--layout-grid-columns` /
 *   `--layout-poster-ratio` 的响应式保持一致（手机 2 列 / 平板 3 列 / 桌面 4 列）。
 * - 视口容器是网格自身的 `scrollParent`：由调用方保证它是可滚动祖先
 *   （媒体库的 `.library-body`、首页的分区容器）。容器不可滚动时退化为全量渲染。
 *
 * 行高推导：`(列宽 * 3/2) + 标题区 + row-gap`。标题区高度随 `showMeta` 变化，
 * 因此 `ROW_EXTRA_PX` 由 `showMeta` 决定（关闭副标题时卡片更矮）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';

/** 超过该行数才启用虚拟化（小列表直接全量渲染，避免抖动） */
export const VIRTUALIZE_MIN_ROWS = 40;
/** 视口上下各多渲染的行数（缓冲，减少快速滚动时的白屏） */
const OVERSCAN_ROWS = 3;

/** 海报 2:3 → 高度 = 宽度 * 1.5；标题/描述区约 44px（showMeta）或 20px */
const ROW_EXTRA_META_PX = 46;
const ROW_EXTRA_BARE_PX = 22;

export interface VirtualGridOptions<T> {
  items: () => T[];
  /** 每行列数（响应式 token 的实际值） */
  columns: () => number;
  /** 网格水平内边距（左右合计，用于算列宽） */
  paddingX: () => number;
  showMeta: () => boolean;
  /** 关闭虚拟化的开关（测试/降级用） */
  enabled?: () => boolean;
  /**
   * 每行步长（含 row-gap），单位 px。
   *
   * 缺省按「列宽 × 3/2 + 标题区」推导，那只对海报墙成立；
   * 单行文本列表（直播频道）与列宽无关，由调用方量一次真实行高后给进来。
   */
  rowStride?: () => number;
}

export interface VirtualGridState<T> {
  /** 实际渲染的条目切片 */
  visibleItems: ComputedRef<T[]>;
  /** 虚拟化是否生效（条目数不足 / 容器不可滚动时为 false） */
  active: Ref<boolean>;
  /** 上方占位高度（px） */
  padTop: Ref<number>;
  /** 下方占位高度（px） */
  padBottom: Ref<number>;
  /** 窗口首条在整表中的下标：渲染用的 `id`/`key` 要它，窗口内偏移会随滚动漂移 */
  startIndex: Ref<number>;
  /** 重新计算（列数/容器尺寸变化时调用） */
  refresh: () => void;
  /**
   * 把窗口挪到「包含第 itemIndex 条」并等下一帧 DOM 落地。
   *
   * 窗口化以后第 itemIndex 行很可能压根不在 DOM 里，调用方直接
   * `getElementById(...).scrollIntoView()` 会静默拿不到节点（定位/高亮失效）。
   */
  scrollToIndex: (itemIndex: number) => Promise<void>;
}

export function useVirtualGrid<T>(
  gridEl: () => HTMLElement | null,
  options: VirtualGridOptions<T>,
): VirtualGridState<T> {
  const enabled = options.enabled ?? (() => true);
  const rowCount = computed(() => Math.ceil(options.items().length / Math.max(1, options.columns())));
  const shouldVirtualize = computed(
    () => enabled() && rowCount.value > VIRTUALIZE_MIN_ROWS,
  );

  const active = ref(false);
  const startRow = ref(0);
  const endRow = ref(0);
  const padTop = ref(0);
  const padBottom = ref(0);
  const startIndex = ref(0);

  /** 最近一次算出的行步长，`scrollToIndex` 靠它把条目下标换算成行下标 */
  let lastStride = 0;

  /** 读取当前列数（CSS 变量由媒体查询决定） */
  function currentColumns(): number {
    const el = gridEl();
    if (!el) return options.columns();
    const raw = getComputedStyle(el).getPropertyValue('--layout-grid-columns').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, options.columns());
  }

  /** 计算一行的高度：调用方给的行步长优先，否则列宽 * 海报比例 + 标题区 + 行间距 */
  function computeRowHeight(): number {
    const el = gridEl();
    if (!el) return 0;
    if (options.rowStride) {
      const stride = options.rowStride();
      return Number.isFinite(stride) && stride > 0 ? stride : 0;
    }
    const containerWidth = el.clientWidth;
    if (containerWidth <= 0) return 0;
    const columns = currentColumns();
    const gap = readPxVar(el, '--layout-grid-gap') ?? 12;
    // 容器宽度已含自身 padding，这里用 content-box 之外的净宽推导列宽
    const columnWidth = (containerWidth - gap * (columns - 1)) / columns;
    if (columnWidth <= 0) return 0;
    const extra = options.showMeta() ? ROW_EXTRA_META_PX : ROW_EXTRA_BARE_PX;
    // 行间距计入行步长：padTop/padBottom 按步长累加，漏算 gap 会逐行累积漂移
    const rowGap = Number.parseFloat(getComputedStyle(el).rowGap);
    return columnWidth * 1.5 + extra + (Number.isFinite(rowGap) ? rowGap : 0);
  }

  function readPxVar(el: HTMLElement | null, name: string): number | null {
    if (!el) return null;
    const raw = getComputedStyle(el).getPropertyValue(name).trim();
    if (raw.length === 0) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * 滚动来源候选：最近的可滚动祖先 + 页面级滚动（`documentElement`）。
   *
   * 不能只缓存一个节点：布局里中间层常写 `overflow: auto` 但高度未被约束，
   * 真正的滚动发生在 `documentElement`；反之在固定高度的 `main` 容器里又只有
   * 中间层在滚。因此两者都监听，每次取**滚动量更大**的那个作为事实来源。
   */
  function scrollSources(): Array<HTMLElement | null> {
    const el = gridEl();
    let node = el?.parentElement ?? null;
    let inner: HTMLElement | null = null;
    while (node && node !== document.body) {
      const overflow = getComputedStyle(node).overflowY;
      const scrollable = node.scrollHeight > node.clientHeight + 1;
      if ((overflow === 'auto' || overflow === 'scroll') && scrollable) {
        inner = node;
        break;
      }
      node = node.parentElement;
    }
    const doc = document.documentElement;
    const pageScrollable = doc.scrollHeight > doc.clientHeight + 1;
    return [inner, pageScrollable ? doc : null];
  }

  /** 当前生效的滚动来源与滚动量（取两者中滚得更多的那个） */
  function activeScrollSource(): { source: HTMLElement; scrollTop: number; viewport: number } | null {
    const [inner, doc] = scrollSources();
    let best: { source: HTMLElement; scrollTop: number; viewport: number } | null = null;
    for (const candidate of [inner, doc]) {
      if (!candidate) continue;
      const entry = {
        source: candidate,
        scrollTop: candidate.scrollTop,
        viewport: candidate.clientHeight,
      };
      if (best === null || entry.scrollTop > best.scrollTop) best = entry;
    }
    return best;
  }

  let sources: Array<HTMLElement | null> = [];

  function recompute(): void {
    const el = gridEl();
    if (!el) return;
    if (!shouldVirtualize.value) {
      active.value = false;
      padTop.value = 0;
      padBottom.value = 0;
      return;
    }

    const scrolled = activeScrollSource();
    if (scrolled === null || scrolled.viewport <= 0) {
      active.value = false;
      padTop.value = 0;
      padBottom.value = 0;
      return;
    }

    const height = computeRowHeight();
    if (height <= 0) return;

    /*
     * 网格顶部被滚过的距离（px）。
     *
     * 两种滚动来源的几何关系不同，必须分开算：
     * - **内层容器**：容器在视口中位置固定，`sourceRect.top` 不随自身滚动变化，
     *   滚过量 = `sourceRect.top - gridRect.top`（grid 相对容器视口顶部的负偏移）。
     * - **documentElement（页面滚动）**：它的 rect 随滚动一起移动，
     *   `sourceRect.top === -scrollTop`，若沿用上式会得到 `-G`（完全错），
     *   此时应直接用 `-gridRect.top`（grid 相对视口顶部的负偏移）。
     *
     * 判据用 `source === documentElement`：这是唯一"自身即文档"的滚动容器。
     */
    const gridTop = el.getBoundingClientRect().top;
    const offset =
      scrolled.source === document.documentElement
        ? Math.max(0, -gridTop)
        : Math.max(0, scrolled.source.getBoundingClientRect().top - gridTop);

    lastStride = height;
    applyWindow(
      Math.max(0, Math.floor(offset / height) - OVERSCAN_ROWS),
      Math.min(rowCount.value, Math.ceil((offset + scrolled.viewport) / height) + OVERSCAN_ROWS),
      height,
    );
  }

  /**
   * 落窗口：`first`/`last` 是行下标（左闭右开），占位高度按行步长累加。
   * `startIndex` 同时导出，调用方渲染 `id`/`key` 要用绝对下标而非窗口内偏移。
   */
  function applyWindow(first: number, last: number, height: number): void {
    const clampedFirst = Math.max(0, Math.min(first, Math.max(0, rowCount.value - 1)));
    const clampedLast = Math.min(rowCount.value, Math.max(clampedFirst, last));
    startRow.value = clampedFirst;
    endRow.value = clampedLast;
    padTop.value = clampedFirst * height;
    padBottom.value = Math.max(0, (rowCount.value - clampedLast) * height);
    active.value = clampedLast > clampedFirst;
    startIndex.value = clampedFirst * Math.max(1, currentColumns());
  }

  /**
   * 滚动事件合并到每帧一次。
   *
   * `recompute()` 要读 `getComputedStyle`（列数/间距）与 `getBoundingClientRect`，
   * 手指滑动时一帧能来十几个 scroll 事件，逐个执行就是把布局反复逼出来。
   *
   * 只合并**真实**滚动：`LibraryView` 恢复滚动位置时派发的是一个手工
   * `new Event('scroll')`，那一帧必须立刻算完，否则返程首帧只画得出占位空白
   * （`isTrusted` 是唯一能区分两者的判据）。
   */
  let scrollFrame = 0;

  function onScroll(event: Event): void {
    if (!event.isTrusted) {
      recompute();
      return;
    }
    if (scrollFrame !== 0) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      recompute();
    });
  }

  async function scrollToIndex(itemIndex: number): Promise<void> {
    if (!active.value || lastStride <= 0) return;
    const columns = Math.max(1, currentColumns());
    const target = Math.floor(Math.min(Math.max(0, itemIndex), Math.max(0, options.items().length - 1)) / columns);
    const span = Math.max(1, endRow.value - startRow.value);
    const half = Math.floor(span / 2);
    // 把目标行放到窗口中部：上下都留出缓冲，接着的 scrollIntoView 才有的可滚
    const first = Math.max(0, Math.min(target - half, Math.max(0, rowCount.value - span)));
    applyWindow(first, Math.min(rowCount.value, first + span), lastStride);
    await nextTick();
  }

  /**
   * 绑定滚动监听。
   *
   * 页面级滚动的 `scroll` 事件目标是 `document` 而非 `documentElement`
   * （Chrome/Firefox 均如此），所以 `document` 必须一起监听，否则在
   * "内容直接撑开 body"的布局下永远收不到滚动事件。
   * 同时监听 `document` 与 `documentElement`：前者捕获页面滚动，后者兼容
   * 少数把 `documentElement` 设为滚动容器的场景。
   */
  function bind(): void {
    sources = scrollSources();
    sources.forEach((node) => node?.addEventListener('scroll', onScroll, { passive: true }));
    document.addEventListener('scroll', onScroll, { passive: true });
  }

  function unbind(): void {
    if (scrollFrame !== 0) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
    }
    sources.forEach((node) => node?.removeEventListener('scroll', onScroll));
    sources = [];
    document.removeEventListener('scroll', onScroll);
  }

  onMounted(() => {
    bind();
    recompute();
  });

  onBeforeUnmount(() => {
    unbind();
  });

  // 条目数变化（翻页/切源）时重算；列数变化由 ResizeObserver 处理
  watch(rowCount, () => recompute());
  watch(options.showMeta, () => recompute());

  /**
   * 网格节点本身也可能「挂载后才出现」。
   *
   * 直播频道列表在加载态下不渲染 `<ul>`（v-else 链），此时 onMounted 里算出的
   * `sources` 只有 document，真正的滚动容器压根没绑上，窗口会永远停在第一屏。
   * 所以节点从无到有时重新走一遍绑定。
   */
  watch(
    () => gridEl(),
    (el) => {
      if (!el) return;
      unbind();
      bind();
      observeResize();
      recompute();
    },
  );

  /** 容器尺寸/断点变化 */
  let observer: ResizeObserver | null = null;
  function observeResize(): void {
    const el = gridEl();
    if (!el || typeof ResizeObserver === 'undefined') return;
    observer?.disconnect();
    observer = new ResizeObserver(() => recompute());
    observer.observe(el);
    if (el.parentElement) observer.observe(el.parentElement);
  }
  onMounted(observeResize);
  onBeforeUnmount(() => observer?.disconnect());

  const visibleItems = computed(() => {
    if (!active.value) return options.items();
    const columns = Math.max(1, currentColumns());
    const from = startRow.value * columns;
    const to = endRow.value * columns;
    return options.items().slice(from, to);
  });

  return {
    visibleItems,
    active,
    padTop,
    padBottom,
    startIndex,
    refresh: recompute,
    scrollToIndex,
  };
}
