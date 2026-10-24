import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceService } from '@/services/sourceService';
import { settingsService } from '@/services/settingsService';
import { appEvents } from '@/services/events';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { useSourceStore } from '@/stores/sourceStore';
import { DEMO_SOURCE_ID } from '@/data/demo/demoSeed';
import { AppError } from '@/shared/errors';
import { mediaIdOf } from '@/shared/id';
import type { DownloadTask, MediaItem, Source } from '@/types';

import { resetAll, tick } from './helpers';

const NOW = 1_700_000_000_000;

function makeMedia(sourceId: string): MediaItem {
  const id = mediaIdOf(sourceId, 'm1');
  return {
    id,
    sourceId,
    sourceItemId: 'm1',
    title: '缓存影片',
    originalTitle: null,
    type: 'movie',
    year: 2020,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: 100,
    episodeCount: null,
    titleLower: '缓存影片',
    isDemo: false,
    cachedAt: NOW,
    updatedAt: NOW,
  };
}

function makeDownload(source: Source, mediaId: string): DownloadTask {
  return {
    id: `dl-${mediaId}`,
    sourceId: source.id,
    mediaId,
    episodeId: `${mediaId}:1`,
    episodeNumber: 1,
    title: '缓存影片',
    episodeTitle: null,
    posterUrl: null,
    url: 'https://cdn.example.com/1.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'completed',
    priority: NOW,
    totalBytes: 100,
    downloadedBytes: 100,
    speedBps: 0,
    retries: 0,
    maxRetries: 3,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: 'blob-1',
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  };
}

describe('sourceStore（API-14 v1.1 / CHG-01）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  it('create：落库后列表 +1，非内置源优先成为默认源', async () => {
    await sourceService.ensureDemoSource();
    const store = useSourceStore();
    await store.load();
    expect(store.sources).toHaveLength(1);

    const created = await store.create({
      name: '家里 AList',
      type: 'alist',
      baseUrl: 'https://alist.example.com/',
    });

    expect(store.sources).toHaveLength(2);
    expect(store.sources.map((s) => s.id)).toContain(created.id);
    expect(created.baseUrl).toBe('https://alist.example.com');
    // 演示源虽启用，但默认源优先非内置源
    expect(store.defaultSource?.id).toBe(created.id);
    expect(store.error).toBeNull();
    // 与持久层一致
    expect((await sourceService.list()).map((s) => s.id)).toEqual(store.sources.map((s) => s.id));
  });

  it('默认源回退：新建源禁用后回落到演示源', async () => {
    await sourceService.ensureDemoSource();
    const store = useSourceStore();
    await store.load();
    const created = await store.create({ name: '源 A', type: 'alist', baseUrl: 'https://a.example.com' });
    expect(store.defaultSource?.id).toBe(created.id);

    await store.setEnabled(created.id, false);
    expect(store.enabledSources.map((s) => s.id)).toEqual([DEMO_SOURCE_ID]);
    expect(store.defaultSource?.id).toBe(DEMO_SOURCE_ID);
  });

  it('create 失败：写 error 且 re-throw，列表不变', async () => {
    const store = useSourceStore();
    await store.load();
    const before = store.sources.length;

    await expect(store.create({ name: '', type: 'alist', baseUrl: 'https://a.example.com' })).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    expect(store.error?.code).toBe('E_INVALID_INPUT');
    expect(store.sources).toHaveLength(before);
  });

  it('update：字段生效并同步内存 state', async () => {
    const store = useSourceStore();
    await store.load();
    const created = await store.create({ name: '旧名字', type: 'alist', baseUrl: 'https://a.example.com' });

    const updated = await store.update(created.id, { name: '新名字' });

    expect(updated.name).toBe('新名字');
    const inMemory = store.sources.find((s) => s.id === created.id);
    expect(inMemory?.name).toBe('新名字');
    expect(store.error).toBeNull();
    expect((await sourceService.get(created.id))?.name).toBe('新名字');
  });

  it('update 失败（源不存在）：error 有值且 re-throw', async () => {
    const store = useSourceStore();
    await store.load();
    await expect(store.update('missing-id', { name: '改名' })).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(store.error?.code).toBe('E_NOT_FOUND');
  });

  it('remove：删除源并级联清理媒体缓存与下载（removeDownloads）', async () => {
    const store = useSourceStore();
    await store.load();
    const created = await store.create({ name: '源 A', type: 'alist', baseUrl: 'https://a.example.com' });

    const media = makeMedia(created.id);
    await mediaRepo.save(media);
    await downloadRepo.save(makeDownload(created, media.id));
    expect(await mediaRepo.countBySource(created.id)).toBe(1);
    expect(await downloadRepo.count()).toBe(1);

    await store.remove(created.id, { removeDownloads: true });

    expect(store.sources.some((s) => s.id === created.id)).toBe(false);
    expect(await sourceService.get(created.id)).toBeNull();
    expect(await mediaRepo.countBySource(created.id)).toBe(0);
    expect(await downloadRepo.count()).toBe(0);
    expect(store.error).toBeNull();
  });

  it('remove：默认不删除下载任务；内置源删除被拒绝且 error 有值', async () => {
    await sourceService.ensureDemoSource();
    const store = useSourceStore();
    await store.load();
    const created = await store.create({ name: '源 A', type: 'alist', baseUrl: 'https://a.example.com' });
    const media = makeMedia(created.id);
    await mediaRepo.save(media);
    await downloadRepo.save(makeDownload(created, media.id));

    await store.remove(created.id);
    expect(await mediaRepo.countBySource(created.id)).toBe(0);
    expect(await downloadRepo.count()).toBe(1);

    await expect(store.remove(DEMO_SOURCE_ID)).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    expect(store.error?.code).toBe('E_INVALID_INPUT');
    expect(store.sources.some((s) => s.id === DEMO_SOURCE_ID)).toBe(true);
  });

  it('remove 当前选中的源后 currentSourceId 归零', async () => {
    const store = useSourceStore();
    await store.load();
    const created = await store.create({ name: '源 A', type: 'alist', baseUrl: 'https://a.example.com' });
    await store.select(created.id);
    expect(store.currentSourceId).toBe(created.id);

    await store.remove(created.id);
    expect(store.currentSourceId).toBeNull();
    expect(store.currentSource).toBeNull();
  });

  it('testConnection 失败：返回 ok:false + message，不抛穿', async () => {
    const store = useSourceStore();
    const feedback = await store.testConnection({ name: '坏源', type: 'alist', baseUrl: 'ftp://bad' });

    expect(feedback.ok).toBe(false);
    expect(feedback.message.length).toBeGreaterThan(0);
    expect(feedback.latencyMs).toBe(0);
  });

  it('testConnection：service 抛错时仍以 ok:false 返回', async () => {
    const spy = vi.spyOn(sourceService, 'testConnection').mockRejectedValueOnce(new AppError('E_NETWORK'));
    const store = useSourceStore();

    const feedback = await store.testConnection({ name: '源 A', type: 'alist', baseUrl: 'https://a.example.com' });
    expect(feedback.ok).toBe(false);
    expect(feedback.message).toBe('网络不可用，请检查网络后重试');
    spy.mockRestore();
  });

  it('testConnection 成功：转发真实探测的 latencyMs 与「连接成功」文案', async () => {
    const spy = vi.spyOn(sourceService, 'testConnection').mockResolvedValueOnce({
      ok: true,
      latencyMs: 42,
      health: 'ok',
      error: null,
      itemCount: 12,
    });
    const store = useSourceStore();

    const feedback = await store.testConnection({ name: '演示', type: 'demo', baseUrl: '' });
    expect(feedback).toEqual({ ok: true, message: '连接成功', latencyMs: 42 });
    spy.mockRestore();
  });

  it('写操作经 sources:changed 事件兜底刷新（订阅后无需手动 reload）', async () => {
    const store = useSourceStore();
    await store.load();
    let events = 0;
    const off = appEvents.on('sources:changed', () => {
      events += 1;
    });
    await sourceService.create({ name: '外部源', type: 'alist', baseUrl: 'https://ext.example.com' });
    off();
    await tick(5); // reload 由事件异步驱动

    expect(events).toBe(1);
    expect(store.sources.some((s) => s.name === '外部源')).toBe(true);
  });

  describe('disableUnhealthy（一键禁用失效源）', () => {
    async function makeSource(name: string): Promise<string> {
      const created = await store.create({ name, type: 'site', baseUrl: `https://${name}.example.com` });
      return created.id;
    }

    let store: ReturnType<typeof useSourceStore>;

    beforeEach(async () => {
      store = useSourceStore();
      await store.load();
    });

    it('只禁用检测失效且启用的源，返回数量并刷新内存', async () => {
      const dead1 = await makeSource('死源1');
      const dead2 = await makeSource('死源2');
      const alive = await makeSource('活源');
      await sourceService.markHealth(dead1, 'unreachable');
      await sourceService.markHealth(dead2, 'auth_failed');
      await sourceService.markHealth(alive, 'ok');

      const disabled = await store.disableUnhealthy();

      expect(disabled).toBe(2);
      const byId = new Map(store.sources.map((s) => [s.id, s]));
      expect(byId.get(dead1)?.enabled).toBe(false);
      expect(byId.get(dead2)?.enabled).toBe(false);
      expect(byId.get(alive)?.enabled).toBe(true);
    });

    it('timeout / 未检测的源不动', async () => {
      const slow = await makeSource('慢源');
      const unchecked = await makeSource('未检源');
      await sourceService.markHealth(slow, 'timeout');

      const disabled = await store.disableUnhealthy();

      expect(disabled).toBe(0);
      const byId = new Map(store.sources.map((s) => [s.id, s]));
      expect(byId.get(slow)?.enabled).toBe(true);
      expect(byId.get(unchecked)?.enabled).toBe(true);
    });

    it('已禁用的失效源不重复处理，当前选中源被禁用时选中态归零', async () => {
      const dead = await makeSource('死源');
      await sourceService.markHealth(dead, 'bad_config');
      const dead2 = await makeSource('死源2');
      await sourceService.markHealth(dead2, 'unreachable');
      await store.setEnabled(dead2, false); // 已禁用，不应计入
      await store.select(dead);

      const disabled = await store.disableUnhealthy();

      expect(disabled).toBe(1);
      expect(store.currentSourceId).toBeNull();
    });
  });
});
