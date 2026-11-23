/**
 * 签名地址寿命学习单测（OPT-26 / P2-⑫）
 *
 * 覆盖这套「只记观测、不猜 TTL」的四条围栏：
 * - 按 host 归并（同一条 CDN 的签名策略是 host 级的），本地/私网地址完全不参与；
 * - 一次样本不动缓存（多半是自己网络）、60 秒以内的样本不入账（那是起播链路问题）；
 * - 年龄从「第一次发给播放器」算起，缓存命中复用不刷新——从最近一次算等于永远不过期；
 * - 学到的下界夹在 [2 分钟, 30 分钟]，落盘 5 秒窗口合并写，重启读回且旧结论不覆盖本次观测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { playUrlLifetimeService } from '@/services/playUrlLifetimeService';

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/db/repositories/kvRepo', () => ({
  kvRepo: {
    get: vi.fn(async (key: string) => (store.has(key) ? structuredClone(store.get(key)) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  },
}));

const KV_KEY = 'play-url-lifetime-v1';
const CDN = 'https://cdn-a.example.com/v/1.mp4?sign=aaa';
const SAME_HOST_OTHER = 'https://cdn-a.example.com/v/2.mp4?sign=bbb';
const OTHER_HOST = 'https://cdn-b.example.com/v/3.mp4?sign=ccc';

/** 把一个地址「播下去」ageMs 之后确认看不下去：登记 + 走时钟 + 记账 */
async function staleAfter(url: string, ageMs: number): Promise<number | null> {
  playUrlLifetimeService.noteAddressIssued(url);
  await vi.advanceTimersByTimeAsync(ageMs);
  return playUrlLifetimeService.recordStale(url);
}

/** ensureLoaded 那条「动态 import → kvRepo.get」的 promise 链要落定，内存表才反映磁盘 */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
  store.clear();
  playUrlLifetimeService.__reset();
});

afterEach(() => {
  playUrlLifetimeService.__reset();
  vi.useRealTimers();
});

describe('playUrlLifetimeService', () => {
  it('同一 host 归并成一条结论，不同 host 各算各的', async () => {
    expect(await staleAfter(CDN, 90_000)).toBe(90);
    expect(await staleAfter(SAME_HOST_OTHER, 150_000)).toBe(150);
    expect(playUrlLifetimeService.entryOf(CDN)).toMatchObject({ staleAgeMs: 90_000, staleSamples: 2 });
    // 取最小：一次侥幸播到 150 秒不构成「能用 150 秒」的证据
    expect(playUrlLifetimeService.ttlOf(CDN)).toBe(120_000);
    expect(playUrlLifetimeService.ttlOf(OTHER_HOST)).toBeNull();
  });

  it('只有一次样本时不动缓存：一次断流多半是自己的网络', async () => {
    await staleAfter(CDN, 300_000);
    expect(playUrlLifetimeService.ttlOf(CDN)).toBeNull();
    expect(playUrlLifetimeService.entryOf(CDN)).toMatchObject({ staleSamples: 1 });
  });

  it('60 秒以内的样本不入账：那是起播链路问题，与签名寿命无关', async () => {
    expect(await staleAfter(CDN, 59_000)).toBeNull();
    expect(await staleAfter(SAME_HOST_OTHER, 59_000)).toBeNull();
    expect(playUrlLifetimeService.entryOf(CDN)).toBeNull();
    // 攒够两次也全被拒了，缓存仍然不能开口
    expect(playUrlLifetimeService.ttlOf(CDN)).toBeNull();

    expect(await staleAfter(OTHER_HOST, 60_000)).toBe(60);
    expect(playUrlLifetimeService.entryOf(OTHER_HOST)).toMatchObject({ staleSamples: 1 });
  });

  it('年龄从第一次交给播放器算起，缓存命中复用不刷新', async () => {
    playUrlLifetimeService.noteAddressIssued(CDN);
    await vi.advanceTimersByTimeAsync(40_000);
    playUrlLifetimeService.noteAddressIssued(CDN);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(playUrlLifetimeService.addressAgeMs(CDN)).toBe(80_000);
    expect(playUrlLifetimeService.recordStale(CDN)).toBe(80);

    // 没登记过的地址没有年龄可算，也不能凭空记账
    expect(playUrlLifetimeService.addressAgeMs(SAME_HOST_OTHER)).toBeNull();
    expect(playUrlLifetimeService.recordStale(SAME_HOST_OTHER)).toBeNull();
  });

  it('本地代理与局域网地址不参与学习', async () => {
    const localUrls = [
      'http://127.0.0.1:9978/seg-1.ts',
      'http://localhost:9978/seg-1.ts',
      'http://[::1]:9978/seg-1.ts',
      'http://192.168.1.7:8080/v.mp4',
      'http://10.0.0.5/v.mp4',
      'http://172.20.0.3/v.mp4',
    ];
    for (const url of localUrls) {
      expect(await staleAfter(url, 600_000)).toBeNull();
      expect(playUrlLifetimeService.addressAgeMs(url)).toBeNull();
      expect(playUrlLifetimeService.entryOf(url)).toBeNull();
      expect(playUrlLifetimeService.ttlOf(url)).toBeNull();
    }
    expect(store.size).toBe(0);
    // 私网判定只认 IP 字面量：域名恰好以 `10.` 开头也得能学（`10.foo.com` 不在 10/8 段里）
    expect(await staleAfter('https://10.foo.com/v.mp4', 90_000)).toBe(90);
  });

  it('坏地址与非法地址都只当作「没学到」', async () => {
    expect(await staleAfter('not a url', 90_000)).toBeNull();
    expect(await staleAfter('', 90_000)).toBeNull();
    expect(playUrlLifetimeService.ttlOf('not a url')).toBeNull();
  });

  it('学到的下界夹在 [2 分钟, 30 分钟]', async () => {
    // 90 秒就断：不能据此把每次起播都变成一次爬虫调用，取下界
    expect(await staleAfter('https://tiny.example.com/a.mp4', 90_000)).toBe(90);
    expect(await staleAfter('https://tiny.example.com/b.mp4', 100_000)).toBe(100);
    expect(playUrlLifetimeService.ttlOf('https://tiny.example.com/a.mp4')).toBe(120_000);

    // 播了两小时才断：再往外扩就等于没学，取上界
    expect(await staleAfter('https://huge.example.com/a.mp4', 7_200_000)).toBe(7200);
    expect(await staleAfter('https://huge.example.com/b.mp4', 7_200_000)).toBe(7200);
    expect(playUrlLifetimeService.ttlOf('https://huge.example.com/a.mp4')).toBe(30 * 60_000);
  });

  it('5 秒窗口内的多次记账合并成一次写盘，重启后读回', async () => {
    const { kvRepo } = await import('@/db/repositories/kvRepo');
    playUrlLifetimeService.noteAddressIssued(CDN);
    playUrlLifetimeService.noteAddressIssued(SAME_HOST_OTHER);
    vi.setSystemTime(Date.now() + 300_000);
    expect(playUrlLifetimeService.recordStale(CDN)).toBe(300);
    expect(playUrlLifetimeService.recordStale(SAME_HOST_OTHER)).toBe(300);
    expect(kvRepo.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(kvRepo.set).toHaveBeenCalledTimes(1);
    expect(store.get(KV_KEY)).toEqual({
      'cdn-a.example.com': { staleAgeMs: 300_000, staleSamples: 2, updatedAt: expect.any(Number) },
    });

    playUrlLifetimeService.__reset();
    playUrlLifetimeService.ttlOf(CDN);
    await drain();
    expect(playUrlLifetimeService.ttlOf(CDN)).toBe(300_000);
  });

  it('读盘期间的本次观测不被磁盘上的旧结论覆盖', async () => {
    store.set(KV_KEY, {
      'cdn-a.example.com': { staleAgeMs: 30_000, staleSamples: 5, updatedAt: Date.now() - 3_600_000 },
    });
    playUrlLifetimeService.__reset();

    // 读盘是异步的；只要测试不 await，本次会话的两笔观测就先于磁盘结论落进内存
    playUrlLifetimeService.noteAddressIssued(CDN);
    vi.setSystemTime(Date.now() + 400_000);
    expect(playUrlLifetimeService.recordStale(CDN)).toBe(400);
    playUrlLifetimeService.noteAddressIssued(SAME_HOST_OTHER);
    vi.setSystemTime(Date.now() + 500_000);
    expect(playUrlLifetimeService.recordStale(SAME_HOST_OTHER)).toBe(500);

    await drain();
    expect(playUrlLifetimeService.entryOf(CDN)).toMatchObject({ staleAgeMs: 400_000, staleSamples: 2 });
  });

  it('host 表超过 200 条时按更新时间淘汰最旧', async () => {
    const seeded: Record<string, { staleAgeMs: number; staleSamples: number; updatedAt: number }> = {};
    for (let i = 0; i < 200; i += 1) {
      seeded[`h${i}.example.com`] = { staleAgeMs: 300_000, staleSamples: 3, updatedAt: 1_000 + i };
    }
    store.set(KV_KEY, seeded);

    expect(await staleAfter('https://fresh.example.com/a.mp4', 300_000)).toBe(300);
    expect(await staleAfter('https://fresh.example.com/b.mp4', 300_000)).toBe(300);
    await vi.advanceTimersByTimeAsync(6_000);

    const saved = store.get(KV_KEY) as Record<string, { staleSamples: number }>;
    expect(Object.keys(saved)).toHaveLength(200);
    expect(saved['h0.example.com']).toBeUndefined();
    expect(saved['h199.example.com']).toBeDefined();
    expect(saved['fresh.example.com']?.staleSamples).toBe(2);
  });

  it('登记超过 500 个地址时按登记顺序最早的那个不再计龄', async () => {
    const first = 'https://many.example.com/0.mp4';
    playUrlLifetimeService.noteAddressIssued(first);
    for (let i = 1; i <= 500; i += 1) {
      playUrlLifetimeService.noteAddressIssued(`https://many.example.com/${i}.mp4`);
    }
    expect(playUrlLifetimeService.addressAgeMs(first)).toBeNull();
    expect(playUrlLifetimeService.addressAgeMs('https://many.example.com/500.mp4')).toBe(0);
  });
});
