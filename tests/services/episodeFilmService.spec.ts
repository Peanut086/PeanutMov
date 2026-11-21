import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, watchEffect } from 'vue';

/**
 * 选集「胶片墙」的取帧服务（G-B07）
 *
 * 这一层的职责只有一句话：**把已下载的本机文件，一格一格地变成画面，变不出来就老实空着**。
 * 锁六条口径：
 * 1. 没有抽帧桥（Web / 旧 APK）时一个原生调用都不发，也不进等待态；
 * 2. 一集取正中间那一帧，边长按设备档位（高档 168 / 低端 128）；
 * 3. 单轮截上限（24 / 12），串行解码且每格之间让一个宏任务给渲染——详情不能因为铺墙而卡住；
 * 4. 没路径、时长未知的一律不抽；抽不出（失败 / 空串）记成「确认没画面」，坏文件不反复重试；
 * 5. 排队未出结果与彻底没画面是两回事，UI 才能一个是呼吸底板、一个是一直空板；
 * 6. 缓存按 LRU 截在 48 格，被摸过的格子往后挪。
 *
 * `requestAnimationFrame` 换成 `setTimeout` 并计数：既让"让出渲染"这一步可被假时钟观测，
 * 也保证用例不依赖宿主有没有 vsync。
 */

const h = vi.hoisted(() => ({
  tool: { value: true },
  lowEnd: { value: false },
  raf: { count: 0 },
  extract: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/deviceTier', () => ({ isLowEndDevice: () => h.lowEnd.value }));

vi.mock('@/native/mediaToolPlugin', () => ({
  isMediaToolAvailable: () => h.tool.value,
  extractSeekFrames: h.extract,
}));

import {
  episodeFilmOf,
  episodeFilmSupported,
  episodeFilmWaiting,
  requestEpisodeFilms,
  __resetEpisodeFilmState,
  type EpisodeFilmTarget,
} from '@/services/episodeFilmService';

function target(episodeId: string, path = `downloads/${episodeId}.mp4`, durationSec = 100): EpisodeFilmTarget {
  return { episodeId, path, durationSec };
}

/** 第一格卡在原生里，用 `release()` 放行 */
function gate(): { promise: Promise<string[] | null>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<string[] | null>((resolve) => {
    release = () => {
      resolve(['x']);
    };
  });
  return { promise, release };
}

/** 把排队 + 每格之间的让帧全部跑完 */
async function settle(rounds = 80): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.raf.count = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    h.raf.count += 1;
    return setTimeout(() => cb(0), 0);
  });
  h.tool.value = true;
  h.lowEnd.value = false;
  h.extract.mockReset();
  __resetEpisodeFilmState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('episodeFilmService · 能力与档位', () => {
  it('没有抽帧桥：不发原生调用，也不假装在等', async () => {
    h.tool.value = false;
    expect(episodeFilmSupported()).toBe(false);

    requestEpisodeFilms([target('e1', 'p1'), target('e2', 'p2')]);
    await settle();

    expect(h.extract).not.toHaveBeenCalled();
    expect(episodeFilmWaiting('p1')).toBe(false);
    expect(episodeFilmOf('p1')).toEqual([]);
  });

  it('一集取正中间那一帧，用高档边长', async () => {
    h.extract.mockResolvedValue(['data:image/jpeg;base64,A']);

    requestEpisodeFilms([target('e1', 'p1', 100)]);
    await settle();

    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(h.extract).toHaveBeenCalledWith('p1', [50_000], 168);
    expect(episodeFilmOf('p1')).toEqual(['data:image/jpeg;base64,A']);
    expect(episodeFilmWaiting('p1')).toBe(false);
  });

  it('低端机：边长降到 128，一轮最多 12 格', async () => {
    h.lowEnd.value = true;
    h.extract.mockResolvedValue(['f']);
    const many = Array.from({ length: 15 }, (_, i) => target(`e${i}`, `p${i}`));

    requestEpisodeFilms(many);
    await settle();

    expect(h.extract).toHaveBeenCalledTimes(12);
    expect(h.extract).toHaveBeenCalledWith('p0', [50_000], 128);
    // 第 13 集起根本没排队，不该挂"正在抽"
    expect(episodeFilmWaiting('p14')).toBe(false);
  });

  it('高档一轮最多 24 格，多出来的留给下一次请求补上', async () => {
    h.extract.mockResolvedValue(['f']);
    const many = Array.from({ length: 30 }, (_, i) => target(`e${i}`, `p${i}`));

    requestEpisodeFilms(many);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(24);

    requestEpisodeFilms(many);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(30);
    expect(episodeFilmOf('p29')).toEqual(['f']);
  });
});

describe('episodeFilmService · 不收的请求', () => {
  it('没路径 / 时长未知 / 时长为负：一律不上队', async () => {
    h.extract.mockResolvedValue(['f']);

    requestEpisodeFilms([target('e0', '', 100), target('e1', 'p1', 0), target('e2', 'p2', -5)]);
    await settle();

    expect(h.extract).not.toHaveBeenCalled();
    expect(episodeFilmWaiting('p1')).toBe(false);
  });

  it('重复请求同一批只抽一次，抽完之后也不再重抽', async () => {
    h.extract.mockResolvedValue(['f']);
    const one = [target('e1', 'p1')];

    requestEpisodeFilms(one);
    requestEpisodeFilms(one);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(1);

    requestEpisodeFilms(one);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('抽不出来的集记成「确认没画面」，坏文件不会被反复重试', async () => {
    h.extract.mockResolvedValue(null);

    requestEpisodeFilms([target('e1', 'p1')]);
    await settle();

    expect(episodeFilmOf('p1')).toEqual([]);
    expect(episodeFilmWaiting('p1')).toBe(false);

    requestEpisodeFilms([target('e1', 'p1')]);
    await settle();
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('原生抛错与返回空串都算没画面，不留下"正在抽"的假状态', async () => {
    h.extract.mockRejectedValueOnce(new Error('E_DECODE')).mockResolvedValueOnce(['']);

    requestEpisodeFilms([target('e1', 'p1'), target('e2', 'p2')]);
    await settle();

    expect(episodeFilmOf('p1')).toEqual([]);
    expect(episodeFilmOf('p2')).toEqual([]);
    expect(episodeFilmWaiting('p1')).toBe(false);
    expect(episodeFilmWaiting('p2')).toBe(false);
  });

  it('路径为空时读取画面不炸', () => {
    expect(episodeFilmOf('')).toEqual([]);
    expect(episodeFilmOf(null)).toEqual([]);
    expect(episodeFilmWaiting(undefined)).toBe(false);
  });
});

describe('episodeFilmService · 排队节奏', () => {
  it('串行解码：上一集没解完，下一集不会并发进来', async () => {
    const lock = gate();
    let secondStarted = false;
    h.extract
      .mockImplementationOnce(() => lock.promise)
      .mockImplementationOnce(() => {
        secondStarted = true;
        return Promise.resolve(['b']);
      });

    requestEpisodeFilms([target('e1', 'p1'), target('e2', 'p2')]);
    // 排队中的第二集要在墙上出呼吸底板
    expect(episodeFilmWaiting('p2')).toBe(true);

    await settle();
    expect(secondStarted).toBe(false);

    lock.release();
    await settle();

    expect(secondStarted).toBe(true);
    expect(episodeFilmOf('p1')).toEqual(['x']);
    expect(episodeFilmOf('p2')).toEqual(['b']);
    expect(episodeFilmWaiting('p2')).toBe(false);
  });

  it('每抽完一格就让一个宏任务给渲染', async () => {
    h.extract.mockResolvedValue(['f']);

    requestEpisodeFilms([target('e1', 'p1'), target('e2', 'p2'), target('e3', 'p3')]);
    await settle();

    expect(h.extract).toHaveBeenCalledTimes(3);
    // 三格之间各让一次（最后一格也要让，抽完这轮渲染才接手）
    expect(h.raf.count).toBeGreaterThanOrEqual(3);
  });
});

describe('episodeFilmService · 响应式', () => {
  it('抽完的画面能被 computed 感知，而读取本身不会把自己弄脏（不画循环）', async () => {
    h.extract.mockResolvedValue(['data:one']);
    const view = computed(() => episodeFilmOf('p1')[0] ?? null);
    const renders: (string | null)[] = [];
    const stop = watchEffect(() => renders.push(view.value));

    requestEpisodeFilms([target('e1', 'p1')]);
    await settle();
    await nextTick();
    stop();

    expect(view.value).toBe('data:one');
    // 一次初值 + 一次结果写入；再多就是 LRU 的自激循环
    expect(renders.length).toBeLessThanOrEqual(2);
  });
});

describe('episodeFilmService · 缓存上限', () => {
  it('满 48 格后挤出最久未用的，摸过的格子往后挪', async () => {
    h.extract.mockResolvedValue(['f']);
    const many = Array.from({ length: 48 }, (_, i) => target(`e${i}`, `p${i}`));

    // 服务自己每轮截 24 格，两轮刚好铺满 48
    for (let round = 0; round < 2; round++) {
      requestEpisodeFilms(many);
      await settle();
    }
    expect(h.extract).toHaveBeenCalledTimes(48);

    // 摸一下 p0：它挪到队尾，于是第 49 格进来时被挤出去的是 p1
    expect(episodeFilmOf('p0')).toEqual(['f']);
    requestEpisodeFilms([target('e48', 'p48')]);
    await settle();

    expect(episodeFilmOf('p48')).toEqual(['f']);
    expect(episodeFilmOf('p1')).toEqual([]);
    expect(episodeFilmOf('p0')).toEqual(['f']);
    expect(episodeFilmOf('p2')).toEqual(['f']);
  });

  it('重置清掉画面、等待态与队列', async () => {
    const lock = gate();
    h.extract.mockImplementationOnce(() => lock.promise);
    requestEpisodeFilms([target('e1', 'p1'), target('e2', 'p2')]);
    await settle();

    __resetEpisodeFilmState();

    expect(episodeFilmWaiting('p1')).toBe(false);
    expect(episodeFilmWaiting('p2')).toBe(false);
    expect(episodeFilmOf('p1')).toEqual([]);
  });
});
