/**
 * 进度条胶片数据层（A-03）单测
 *
 * 覆盖三件在真机上最难肉眼判断的事：
 * 1. 该不该抽（在线源 / blob 兜底 / 时长未知 / 插件缺失都不能抽）；
 * 2. 抽的是不是格中心（端点会让整条预览系统性偏移半格）；
 * 3. 会不会重复抽（同一文件只跑一批，失败也不无限重试；并发只保留一路）。
 */
import { ref, type Ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource } from '@/types';
import { useSeekThumbnails } from '@/composables/useSeekThumbnails';

const env = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<{ path: string; timesMs: number[] }>,
  /** 下一次抽帧的返回值：null = 整批失败；数组 = 与请求下标对齐的槽位 */
  result: null as (string | null)[] | null,
  /** 置 true 后抽帧挂起，由 release() 放行 —— 用来测并发合并 */
  hold: false,
  release: null as (() => void) | null,
}));

vi.mock('@/native/mediaToolPlugin', () => ({
  isMediaToolAvailable: () => env.available,
  extractSeekFrames: (path: string, timesMs: number[]) => {
    env.calls.push({ path, timesMs });
    if (env.hold) {
      return new Promise<(string | null)[] | null>((resolve) => {
        env.release = () => resolve(env.result);
      });
    }
    return Promise.resolve(env.result);
  },
}));

const DURATION = 200;

function localSource(path: string | null): PlaybackSource {
  return {
    url: 'https://localhost/_capacitor_file_/x.mp4',
    format: 'mp4',
    headers: {},
    subtitles: [],
    lineId: 'local:1',
    quality: '1080P',
    expiresAt: null,
    isLocal: true,
    localPath: path ?? undefined,
  };
}

function onlineSource(): PlaybackSource {
  return { ...localSource(null), isLocal: false, url: 'https://example.com/index.m3u8' };
}

function fillUrls(count: number): (string | null)[] {
  return Array.from({ length: count }, (_, index) => `f${index}`);
}

function setCores(cores: number): void {
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: cores });
}

/** 排空 drain 的微任务链（没有真实 I/O，几个 tick 足够） */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/**
 * 数据层的入参是 getter，生产里读的是响应式源；测试也必须用 ref 喂，
 * 否则 computed 永不失效——看着像缓存没生效，其实是测试自己造了个假响应式。
 */
function setup(source: Ref<PlaybackSource | null>, duration = ref(DURATION)) {
  return useSeekThumbnails(() => source.value, () => duration.value);
}

beforeEach(() => {
  env.available = true;
  env.calls = [];
  env.result = null;
  env.hold = false;
  env.release = null;
  setCores(8);
});

describe('useSeekThumbnails · 该不该抽', () => {
  it('在线源不具备出图条件，不发起任何抽帧', async () => {
    const thumbs = setup(ref(onlineSource()));
    thumbs.prepare();
    await flush();
    expect(thumbs.enabled.value).toBe(false);
    expect(env.calls).toHaveLength(0);
    expect(thumbs.frameAt(100)).toBeNull();
  });

  it('blob 兜底没有文件路径，同样不抽帧', async () => {
    const thumbs = setup(ref(localSource(null)));
    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(0);
  });

  it('时长还没回来时先不抽，拿到时长再抽', async () => {
    const duration = ref(0);
    const thumbs = setup(ref(localSource('downloads/m/no-duration.mp4')), duration);
    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(0);

    duration.value = DURATION;
    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(1);
  });

  it('插件不可用（Web 预览 / 旧 APK）时静默关闭整条链路', async () => {
    env.available = false;
    const thumbs = setup(ref(localSource('downloads/m/no-plugin.mp4')));
    thumbs.prepare();
    await flush();
    expect(thumbs.enabled.value).toBe(false);
    expect(env.calls).toHaveLength(0);
  });

  it('换线路退到在线源后，胶片立刻停用且不残留旧格', async () => {
    const source = ref<PlaybackSource | null>(localSource('downloads/m/line-switch.mp4'));
    env.result = fillUrls(20);
    const thumbs = setup(source);
    thumbs.prepare();
    await flush();
    expect(thumbs.frameAt(0)).toBe('f0');

    source.value = onlineSource();
    expect(thumbs.enabled.value).toBe(false);
    expect(thumbs.slots.value).toHaveLength(0);
    expect(thumbs.frameAt(0)).toBeNull();
  });
});

describe('useSeekThumbnails · 抽哪些时间点', () => {
  it('一次铺满整条胶片，取每格中心而不是端点', async () => {
    env.result = fillUrls(20);
    const thumbs = setup(ref(localSource('downloads/m/centers.mp4')));
    thumbs.prepare();
    await flush();

    expect(thumbs.count).toBe(20);
    expect(env.calls).toHaveLength(1);
    // 200s / 20 格 → 中心 5,15,25… 单位毫秒
    expect(env.calls[0]!.timesMs).toEqual(Array.from({ length: 20 }, (_, i) => (i * 2 + 1) * 5000));
  });

  it('低档机降到 10 格，抽帧量减半', async () => {
    setCores(4);
    env.result = fillUrls(10);
    const thumbs = setup(ref(localSource('downloads/m/low-end.mp4')));
    thumbs.prepare();
    await flush();
    expect(thumbs.count).toBe(10);
    expect(env.calls[0]!.timesMs).toHaveLength(10);
  });

  it('按秒取格：落在哪一格就返回那一格，首尾都钳住', async () => {
    env.result = fillUrls(20);
    const thumbs = setup(ref(localSource('downloads/m/bucket.mp4')));
    thumbs.prepare();
    await flush();

    expect(thumbs.frameAt(0)).toBe('f0');
    expect(thumbs.frameAt(9.9)).toBe('f0');
    expect(thumbs.frameAt(100)).toBe('f10');
    expect(thumbs.frameAt(199)).toBe('f19');
    expect(thumbs.frameAt(9999)).toBe('f19');
    expect(thumbs.frameAt(-30)).toBe('f0');
  });
});

describe('useSeekThumbnails · 不重复抽', () => {
  it('同一文件第二次 prepare 不再调用原生', async () => {
    env.result = fillUrls(20);
    const thumbs = setup(ref(localSource('downloads/m/once.mp4')));
    thumbs.prepare();
    await flush();
    thumbs.prepare();
    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(1);
  });

  it('换回抽过的文件直接命中缓存，不再跑原生', async () => {
    env.result = fillUrls(20);
    const source = ref<PlaybackSource | null>(localSource('downloads/m/cached-a.mp4'));
    const thumbs = setup(source);

    thumbs.prepare();
    await flush();
    expect(thumbs.frameAt(100)).toBe('f10');

    source.value = localSource('downloads/m/cached-b.mp4');
    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(2);

    source.value = localSource('downloads/m/cached-a.mp4');
    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(2);
    expect(thumbs.frameAt(100)).toBe('f10');
  });

  it('整批失败也算跑过一轮，不会每次拖动都重试坏文件', async () => {
    env.result = null;
    const thumbs = setup(ref(localSource('downloads/m/broken.mp4')));
    thumbs.prepare();
    await flush();
    thumbs.prepare();
    await flush();

    expect(env.calls).toHaveLength(1);
    expect(thumbs.frameAt(100)).toBeNull();
    expect(thumbs.slots.value.every((url) => url === null)).toBe(true);
  });

  it('抽帧期间换集：迟到结果不盖当前集，当前集补跑一次', async () => {
    env.hold = true;
    const source = ref<PlaybackSource | null>(localSource('downloads/m/slow-a.mp4'));
    const thumbs = setup(source);

    thumbs.prepare();
    await flush();
    expect(env.calls).toHaveLength(1);

    source.value = localSource('downloads/m/slow-b.mp4');
    thumbs.prepare(); // 当前那路还挂着，只登记补跑
    await flush();
    expect(env.calls).toHaveLength(1);

    env.result = fillUrls(20);
    env.release?.(); // A 的迟到结果返回
    await flush();

    expect(env.calls.map((call) => call.path)).toEqual([
      'downloads/m/slow-a.mp4',
      'downloads/m/slow-b.mp4',
    ]);
    // B 自己那一路还挂着，画面必须仍是"未就绪"，不能被 A 的帧冒充
    expect(thumbs.frameAt(0)).toBeNull();
    expect(thumbs.slots.value[0]).toBeNull();
  });

  it('部分格取不到时，已就绪的格照常显示', async () => {
    env.result = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? `e${index}` : null));
    const thumbs = setup(ref(localSource('downloads/m/partial.mp4')));
    thumbs.prepare();
    await flush();

    expect(thumbs.frameAt(0)).toBe('e0');
    expect(thumbs.frameAt(12)).toBeNull();
    expect(thumbs.slots.value.filter((url) => url !== null)).toHaveLength(10);
  });
});
