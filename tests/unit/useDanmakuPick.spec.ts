/**
 * 弹幕互动层（B-04 · 编排）
 *
 * 渲染层的 `pick()` 在这里只当探针用，重点是「点中/没点中之后各走哪条路」：
 * - 点中吃掉这次单击，不再开关控制条；没命中要顺手收掉上一次的操作条；
 * - 互动开关关掉时连命中测试都不做，手势链路一字不改地走原路；
 * - 冻结有 4s 上限，渲染层自己丢条目时操作条也得跟着收，不能悬空；
 * - 点赞立刻可见，定位跳进度，复制不关条。
 *
 * 每个用例的分桶都在起时钟前 `loadLikes` 预热完（预热后 tapAt 内部的 loadLikes 走内存
 * 分支，不再碰库）；只有看门狗两个用例装伪时钟，涉及落库的点赞测试留在真时钟里。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

import { useDanmakuPick } from '@/composables/useDanmakuPick';
import { danmakuLikeService } from '@/services/danmakuLikeService';
import type { DanmakuOverlay, DanmakuPick as PickHit } from '@/player/DanmakuOverlay';
import type { DanmakuComment } from '@/types';

const HIT_RECT = { left: 300, top: 40, width: 60, height: 24 };

let seq = 0;
function nextMediaId(): string {
  seq += 1;
  return `tb:pick-${seq}`;
}

function comment(time = 12.5, text = '名场面'): DanmakuComment {
  return { text, time, mode: 'scroll', color: 0xffffff };
}

interface FakeOverlay {
  pick: (x: number, y: number) => PickHit | null;
  releasePick: () => void;
  pickedComment: DanmakuComment | null;
}

interface Harness {
  api: ReturnType<typeof useDanmakuPick>;
  overlay: FakeOverlay;
  overlayRef: ShallowRef<DanmakuOverlay | null>;
  mediaId: Ref<string>;
  episodeNumber: Ref<number | null>;
  enabled: Ref<boolean>;
  seeked: number[];
  copied: string[];
}

async function setup(
  options: { hit?: PickHit | null; enabled?: boolean; fakeClock?: boolean } = {},
): Promise<Harness> {
  const hit: PickHit | null =
    options.hit === undefined ? { comment: comment(), rect: HIT_RECT } : options.hit;
  const mediaId = ref(nextMediaId());
  const episodeNumber = ref<number | null>(1);
  const enabled = ref(options.enabled ?? true);

  const overlay: FakeOverlay = {
    pick: vi.fn(() => hit),
    releasePick: vi.fn(() => {
      overlay.pickedComment = null;
    }),
    pickedComment: hit ? hit.comment : null,
  };
  const overlayRef = shallowRef(overlay as unknown as DanmakuOverlay | null);
  const seeked: number[] = [];
  const copied: string[] = [];

  await danmakuLikeService.loadLikes(mediaId.value, 1);
  // 只有看门狗用例要拨时钟：伪时钟会卡住 fake-indexeddb，落库的 toggleLike 都得留在真时钟里
  if (options.fakeClock) vi.useFakeTimers();

  const api = useDanmakuPick({
    overlay: overlayRef,
    enabled,
    mediaId,
    episodeNumber,
    seek: (sec) => seeked.push(sec),
    copy: (text) => copied.push(text),
  });

  await nextTick();
  return { api, overlay, overlayRef, mediaId, episodeNumber, enabled, seeked, copied };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useDanmakuPick · 单击分流', () => {
  it('点中弹幕：吃掉这次单击，操作条挂上且不放行', async () => {
    const h = await setup();

    expect(h.api.tapAt(360, 28)).toBe(true);
    expect(h.api.pick.value?.comment.text).toBe('名场面');
    expect(h.overlay.pickedComment).not.toBeNull();
    expect(h.overlay.releasePick).not.toHaveBeenCalled();
  });

  it('没点中：不吃单击，并顺手收掉上一次的操作条', async () => {
    const h = await setup({ hit: null });
    h.api.tapAt(10, 10);
    expect(h.api.pick.value).toBeNull();
    expect(h.overlay.pick).toHaveBeenCalled();

    const h2 = await setup();
    h2.api.tapAt(360, 28);
    h2.overlay.pick = vi.fn(() => null);
    expect(h2.api.tapAt(500, 300)).toBe(false);
    expect(h2.api.pick.value).toBeNull();
    expect(h2.overlay.releasePick).toHaveBeenCalledTimes(1);
  });

  it('互动开关关掉：不做命中测试，返回值交回手势层', async () => {
    const h = await setup({ enabled: false });

    expect(h.api.tapAt(360, 28)).toBe(false);
    expect(h.overlay.pick).not.toHaveBeenCalled();
    expect(h.api.pick.value).toBeNull();
  });

  it('渲染层还没挂载：不炸，也只返回 false', async () => {
    const h = await setup();
    h.overlayRef.value = null;

    expect(h.api.tapAt(360, 28)).toBe(false);
    expect(() => h.api.close()).not.toThrow();
  });

  it('关掉开关：正在冻结的那条立刻放行、操作条收起', async () => {
    const h = await setup();
    h.api.tapAt(360, 28);

    h.enabled.value = false;
    await nextTick();

    expect(h.api.pick.value).toBeNull();
    expect(h.overlay.releasePick).toHaveBeenCalledTimes(1);
  });
});

describe('useDanmakuPick · 自动放行', () => {
  it('冻结满 4s 自动放行，不让一条弹幕挂在画面上', async () => {
    const h = await setup({ fakeClock: true });
    h.api.tapAt(360, 28);

    vi.advanceTimersByTime(3800);
    expect(h.api.pick.value).not.toBeNull();

    vi.advanceTimersByTime(400);
    expect(h.api.pick.value).toBeNull();
    expect(h.overlay.releasePick).toHaveBeenCalledTimes(1);
  });

  it('渲染层丢条目（seek / 换集 / 改区域）时操作条跟着收，不悬空', async () => {
    const h = await setup({ fakeClock: true });
    h.api.tapAt(360, 28);

    h.overlay.pickedComment = null;
    vi.advanceTimersByTime(200);

    expect(h.api.pick.value).toBeNull();
    expect(h.overlay.releasePick).toHaveBeenCalledTimes(1);
  });

  it('换集：上一次的冻结与操作条都不带进下一集', async () => {
    const h = await setup();
    h.api.tapAt(360, 28);

    h.episodeNumber.value = 2;
    await nextTick();

    expect(h.api.pick.value).toBeNull();
    expect(h.overlay.releasePick).toHaveBeenCalledTimes(1);
  });

  it('换剧同样收掉，且新剧的分桶不会带上旧剧的赞', async () => {
    const h = await setup();
    h.api.tapAt(360, 28);
    await h.api.toggleLike();
    expect(h.api.liked.value).toBe(true);

    h.mediaId.value = nextMediaId();
    await nextTick();
    expect(h.api.pick.value).toBeNull();

    h.api.tapAt(360, 28);
    expect(h.api.liked.value).toBe(false);
    expect(h.api.likeCount.value).toBe(0);
  });
});

describe('useDanmakuPick · 操作条动作', () => {
  it('点赞立刻 +1，再点取消', async () => {
    const h = await setup();
    h.api.tapAt(360, 28);

    expect(await h.api.toggleLike()).toBe(true);
    expect(h.api.liked.value).toBe(true);
    expect(h.api.likeCount.value).toBe(1);

    expect(await h.api.toggleLike()).toBe(false);
    expect(h.api.liked.value).toBe(false);
    expect(h.api.likeCount.value).toBe(0);
  });

  it('「定位」把进度跳到该弹幕出现的时间并收条', async () => {
    const h = await setup({ hit: { comment: comment(88.5, '这里'), rect: HIT_RECT } });
    h.api.tapAt(360, 28);

    h.api.locate();

    expect(h.seeked).toEqual([88.5]);
    expect(h.api.pick.value).toBeNull();
    expect(h.overlay.releasePick).toHaveBeenCalledTimes(1);
  });

  it('「复制」只递文本，操作条留着', async () => {
    const h = await setup();
    h.api.tapAt(360, 28);

    h.api.copyText();

    expect(h.copied).toEqual(['名场面']);
    expect(h.api.pick.value).not.toBeNull();
  });

  it('没点中时三个动作都空转，不会误 seek', async () => {
    const h = await setup({ hit: null });

    h.api.locate();
    h.api.copyText();
    h.api.close();
    expect(await h.api.toggleLike()).toBe(false);

    expect(h.seeked).toEqual([]);
    expect(h.copied).toEqual([]);
  });
});
