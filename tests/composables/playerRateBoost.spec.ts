/**
 * 长按倍速的基准保护（11-21 ①+②）
 *
 * 真机上"没人碰却在 2x 快进"有两条漏口，这里各按一条断言：
 * 1. 引擎的 `ratechange` 不区分"按住的临时倍速"和"用户选的倍速"，临时值一旦被回写成基准，
 *    下一次抬手就恢复到 2x，黑匣子还会把 2x 当倍速记忆存进这一集——下次进来是真·自动 2x；
 * 2. 切后台那一刻 `pointerup` 永远不会送达，临时倍速一直挂着；HUD 又是单槽单计时器，
 *    任何一次短提示（点一下/拖进度/音量）到期都会把 "2x 快进中" 顶掉，用户只剩无声无息的 2x。
 *
 * `PlayerController` 整体打桩：这里核的是组合式函数的状态口径，不碰引擎实现。
 */
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

const stub = vi.hoisted(() => {
  const created: Array<{ rateCalls: number[] }> = [];
  class FakePlayerController {
    rateCalls: number[] = [];
    private handlers = new Map<string, Set<(payload: never) => void>>();

    constructor() {
      created.push(this);
    }

    on(event: string, cb: (payload: never) => void): () => void {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(cb);
      return () => this.handlers.get(event)?.delete(cb);
    }

    emit(event: string, payload: unknown): void {
      this.handlers.get(event)?.forEach((cb) => (cb as (p: unknown) => void)(payload));
    }

    mount(): void {}

    destroy(): void {}

    /** 真实语义：设速会回报一次 ratechange，正是这条把临时倍速送到状态层的 */
    setRate(rate: number): void {
      this.rateCalls.push(rate);
      this.emit('ratechange', { rate });
    }

    setVolume(): void {}

    setResizeMode(): void {}

    setSubtitleOffset(): void {}

    setBackgroundPlayback(): void {}

    pause(): void {}

    flushProgress(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { created, FakePlayerController };
});

vi.mock('@/player/PlayerController', () => ({ PlayerController: stub.FakePlayerController }));

import { usePlayerController } from '@/composables/usePlayerController';

const RATE_CALLS = () => stub.created[stub.created.length - 1]!.rateCalls;
const LAST_RATE = () => RATE_CALLS()[RATE_CALLS().length - 1];

/**
 * 挂一个只有 render 的宿主组件把 composable 跑起来（`onMounted` 需要真实组件实例），
 * 再按 PlayerView 的顺序建控制器：创建时先把引擎设成默认倍速。
 */
const mounted: ReturnType<typeof mount>[] = [];

function setup(defaultRate = 1, longPressRate = 2) {
  let api!: ReturnType<typeof usePlayerController>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = usePlayerController({
          saveProgress: vi.fn().mockResolvedValue(undefined),
          describe: () => ({
            sourceId: 'src-1',
            mediaId: 'media-1',
            episodeId: 'ep-1',
            episodeNumber: 1,
            title: '测试片',
            posterUrl: null,
            totalEpisodes: 2,
          }),
          subtitle: { size: 'medium', color: 'white', background: 'black', offsetSec: 0, preferredLang: null },
          defaultRate: defaultRate as never,
          autoPlayNext: false,
          backgroundPlayback: false,
          resizeMode: 'contain',
          longPressRate: longPressRate as never,
        });
        return () => h('div');
      },
    }),
  );
  api.createController(document.createElement('div'));
  mounted.push(wrapper);
  return { api, wrapper };
}

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  setActivePinia(createPinia());
  stub.created.length = 0;
});

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  setVisibility('visible');
});

describe('长按倍速 · 基准不被污染', () => {
  it('按住期间引擎走临时倍速，基准倍速仍是用户选的 1x', () => {
    const { api } = setup();

    expect(api.player.rate).toBe(1);
    expect(RATE_CALLS()).toEqual([1]);

    api.onGesture({ type: 'long-press-start' });

    expect(LAST_RATE()).toBe(2);
    // 这条断言就是倍速记忆的口径来源：黑匣子写的、抬手恢复的都是 player.rate
    expect(api.player.rate).toBe(1);
  });

  it('抬手恢复到 1x：长按不会把基准抬上去', () => {
    const { api } = setup();

    api.onGesture({ type: 'long-press-start' });
    api.onGesture({ type: 'long-press-end' });

    expect(RATE_CALLS()).toEqual([1, 2, 1]);
    expect(api.player.rate).toBe(1);
  });

  it('非长按期间的设速照常写回基准（幂等保护别过头）', () => {
    const { api } = setup();

    api.setRate(1.5 as never);

    expect(api.player.rate).toBe(1.5);
    expect(LAST_RATE()).toBe(1.5);

    // 之后的长按以新的基准为恢复点
    api.onGesture({ type: 'long-press-start' });
    api.onGesture({ type: 'long-press-end' });
    expect(api.player.rate).toBe(1.5);
    expect(LAST_RATE()).toBe(1.5);
  });
});

describe('长按倍速 · 退后台收尾', () => {
  it('切后台那一刻补收尾：倍速回到基准，"2x 快进中"不再挂着', () => {
    const { api } = setup();

    api.onGesture({ type: 'long-press-start' });
    expect(api.hud.value.kind).toBe('rate');

    setVisibility('hidden');

    expect(LAST_RATE()).toBe(1);
    expect(api.hud.value.kind).toBeNull();
    expect(api.player.rate).toBe(1);
  });

  it('没有长按在飞时，切后台不碰倍速', () => {
    setup();
    const before = RATE_CALLS().length;

    setVisibility('hidden');

    expect(RATE_CALLS()).toHaveLength(before);
  });

  it('回到前台不会把已收尾的长按又恢复一次', () => {
    const { api } = setup();
    api.onGesture({ type: 'long-press-start' });
    setVisibility('hidden');
    const after = RATE_CALLS().length;

    setVisibility('visible');

    expect(RATE_CALLS()).toHaveLength(after);
  });
});
