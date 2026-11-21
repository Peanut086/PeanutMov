import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';

import { FLIP_DURATION_MS, useFlipReorder } from '@/composables/useFlipReorder';
import { prefersReducedMotion } from '@/composables/useSpring';

/**
 * G-B01 重排位移（FLIP）。
 *
 * happy-dom 没有布局引擎，这里用「格子在父节点里的序号」现算矩形：
 * 补丁前量到的是旧序号、补丁后是新序号，正好等价于真实重排，
 * 于是可以卡死两件事——位移只写 `transform`（不碰宽高），以及起始帧的位移量确实等于位置差。
 */
vi.mock('@/composables/useSpring', () => ({
  prefersReducedMotion: vi.fn(() => false),
}));

const COLS = 2;
const CELL_W = 100;
const CELL_H = 150;

function makeRect(left: number, top: number): DOMRect {
  return {
    left,
    top,
    width: CELL_W,
    height: CELL_H,
    right: left + CELL_W,
    bottom: top + CELL_H,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

function installLayoutStub(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const parent = this.parentElement;
    const idx = parent ? (Array.prototype.indexOf.call(parent.children, this) as number) : 0;
    return makeRect((idx % COLS) * CELL_W, Math.floor(idx / COLS) * CELL_H);
  });
}

interface Cell {
  key: string;
  transform: string;
  transition: string;
}

function harness(keys: Ref<string[]>, enabled: Ref<boolean>) {
  let rootEl: HTMLElement | null = null;
  /** `play()` 里那次强制回流是唯一的观察窗口：起始帧位移量只能在这里读 */
  const invert: { transforms: string[] } = { transforms: [] };

  const wrapper = mount(
    defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null);
        useFlipReorder({
          root: () => root.value,
          source: () => keys.value,
          enabled: () => enabled.value,
        });
        return () => {
          const el = h(
            'div',
            { ref: root },
            keys.value.map((key) => h('div', { key, 'data-flip-key': key })),
          );
          return el;
        };
      },
    }),
  );

  rootEl = wrapper.element as HTMLElement;
  Object.defineProperty(rootEl, 'offsetWidth', {
    configurable: true,
    get(): number {
      invert.transforms = Array.from(rootEl!.children).map((el) => (el as HTMLElement).style.transform);
      return 0;
    },
  });

  function cells(): Cell[] {
    return Array.from(rootEl!.querySelectorAll<HTMLElement>('[data-flip-key]')).map((el) => ({
      key: el.dataset.flipKey as string,
      transform: el.style.transform,
      transition: el.style.transition,
    }));
  }

  return { wrapper, cells, invert };
}

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  vi.mocked(prefersReducedMotion).mockReset();
  vi.mocked(prefersReducedMotion).mockReturnValue(false);
  installLayoutStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFlipReorder', () => {
  it('重排先按位置差反向位移，再放开回位', async () => {
    const keys = ref(['a', 'b', 'c']);
    const enabled = ref(true);
    const h1 = harness(keys, enabled);

    keys.value = ['c', 'a', 'b'];
    await flush();

    // DOM 顺序已是新的 [c,a,b]：c 从 (0,150) 走到 (0,0)，a 从 (0,0) 走到 (100,0)，b 从 (100,0) 走到 (0,150)
    expect(h1.invert.transforms).toEqual([
      'translate(0px, 150px)',
      'translate(-100px, 0px)',
      'translate(100px, -150px)',
    ]);

    const cells = h1.cells();
    expect(cells.map((c) => c.key)).toEqual(['c', 'a', 'b']);
    for (const cell of cells) {
      expect(cell.transform).toBe('');
      expect(cell.transition).toBe(`transform ${FLIP_DURATION_MS}ms var(--ease-standard)`);
    }
  });

  it('位移只声明 transform，不碰宽高', async () => {
    const keys = ref(['a', 'b', 'c']);
    const h1 = harness(keys, ref(true));

    keys.value = ['b', 'c', 'a'];
    await flush();

    for (const cell of h1.cells()) {
      expect(cell.transition).toContain('transform');
      expect(cell.transition).not.toContain('width');
      expect(cell.transition).not.toContain('height');
    }
  });

  it('没挪动的格子不参与位移', async () => {
    const keys = ref(['a', 'b', 'c', 'd']);
    const h1 = harness(keys, ref(true));

    keys.value = ['b', 'a', 'c', 'd'];
    await flush();

    const byKey = new Map(h1.cells().map((c) => [c.key, c]));
    expect(byKey.get('a')!.transition).toContain('transform');
    expect(byKey.get('b')!.transition).toContain('transform');
    expect(byKey.get('c')!.transition).toBe('');
    expect(byKey.get('d')!.transition).toBe('');
  });

  it('新增格子没有历史坐标，只给有坐标的补位移', async () => {
    const keys = ref(['a', 'b']);
    const h1 = harness(keys, ref(true));

    keys.value = ['b', 'a', 'c'];
    await flush();

    // a/b 互换过位置，所以仍要位移；c 没有历史坐标，只出现在新位置
    const byKey = new Map(h1.cells().map((c) => [c.key, c]));
    expect(byKey.get('c')!.transition).toBe('');
    expect(byKey.get('a')!.transition).toContain('transform');
  });

  it('enabled 为假时连快照都不量', async () => {
    const keys = ref(['a', 'b']);
    const h1 = harness(keys, ref(false));

    keys.value = ['b', 'a'];
    await flush();

    expect(h1.invert.transforms).toEqual([]);
    for (const cell of h1.cells()) {
      expect(cell.transition).toBe('');
      expect(cell.transform).toBe('');
    }
  });

  it('reduced-motion 下直接重排、不做位移', async () => {
    vi.mocked(prefersReducedMotion).mockReturnValue(true);
    const keys = ref(['a', 'b', 'c']);
    const h1 = harness(keys, ref(true));

    keys.value = ['c', 'b', 'a'];
    await flush();

    expect(h1.invert.transforms).toEqual([]);
    for (const cell of h1.cells()) {
      expect(cell.transition).toBe('');
      expect(cell.transform).toBe('');
    }
  });

  it('动画收尾后清掉内联 transition，免得拖慢后续布局', async () => {
    vi.useFakeTimers();
    const keys = ref(['a', 'b']);
    const h1 = harness(keys, ref(true));

    keys.value = ['b', 'a'];
    await flush();
    expect(h1.cells()[0]!.transition).toContain('transform');

    vi.advanceTimersByTime(FLIP_DURATION_MS + 61);
    for (const cell of h1.cells()) expect(cell.transition).toBe('');
  });

  it('卸载后收尾定时器不再写样式', async () => {
    vi.useFakeTimers();
    const keys = ref(['a', 'b']);
    const h1 = harness(keys, ref(true));

    keys.value = ['b', 'a'];
    await flush();
    const before = h1.cells().map((c) => c.transition);
    expect(before[0]).toContain('transform');

    h1.wrapper.unmount();
    vi.advanceTimersByTime(FLIP_DURATION_MS + 61);
    expect(h1.cells().map((c) => c.transition)).toEqual(before);
  });
});
