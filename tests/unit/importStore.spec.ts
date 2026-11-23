import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useImportStore } from '@/stores/importStore';
import { importService } from '@/services/importService';
import { sourceService } from '@/services/sourceService';
import { settingsService } from '@/services/settingsService';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { KV_KEY_IMPORT_RECORDS } from '@/shared/constants';
import type { ImportPreview } from '@/types';
import { readKv, resetAll } from './helpers';

const SUBSCRIPTION = JSON.stringify({
  name: '我的订阅',
  version: 1,
  sources: [
    { key: 'alist-a', name: '家里 AList', type: 'alist', api: 'https://alist.example.com/' },
    { key: 'webdav-b', name: 'NAS', type: 'webdav', api: 'https://nas.example.com/dav' },
  ],
});

const SUBSCRIPTION_URL = 'https://example.com/sub.json';

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** P0-2 取消用例用的最小预览体（只关心 sourceUrl 与条目数量） */
function fakePreview(sourceUrl: string | null): ImportPreview {
  return {
    origin: 'url',
    sourceUrl,
    fileName: null,
    fetchedAt: Date.now(),
    name: '我的订阅',
    total: 0,
    entries: [],
    globalIssues: [],
    repos: [],
    lives: [],
  };
}

describe('importStore（API-14 v1.1 / CHG-02）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('previewFromText：写入 preview，entries 解析正确，无 error', async () => {
    const store = useImportStore();
    expect(store.preview).toBeNull();

    await store.previewFromText(SUBSCRIPTION, 'sub.json');

    expect(store.error).toBeNull();
    expect(store.parsing).toBe(false);
    expect(store.preview).not.toBeNull();
    expect(store.preview?.total).toBe(2);
    expect(store.preview?.entries.map((e) => e.key)).toEqual(['alist-a', 'webdav-b']);
    expect(store.preview?.origin).toBe('file');
    expect(store.preview?.fileName).toBe('sub.json');
  });

  it('previewFromUrl：拉取并解析，origin/sourceUrl 正确', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SUBSCRIPTION));
    const store = useImportStore();

    await store.previewFromUrl(SUBSCRIPTION_URL);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.error).toBeNull();
    expect(store.preview?.origin).toBe('url');
    expect(store.preview?.sourceUrl).toBe(SUBSCRIPTION_URL);
    expect(store.preview?.name).toBe('我的订阅');
  });

  it('previewFromFile：读取 File 内容并解析', async () => {
    const store = useImportStore();
    const file = new File([SUBSCRIPTION], 'subscription.json', { type: 'application/json' });

    await store.previewFromFile(file);

    expect(store.error).toBeNull();
    expect(store.preview?.fileName).toBe('subscription.json');
    expect(store.preview?.entries).toHaveLength(2);
  });

  it('预览 → 提交 → records 写入（含源列表 +2）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SUBSCRIPTION));
    const store = useImportStore();
    await store.previewFromUrl(SUBSCRIPTION_URL);
    const keys = store.preview?.entries.map((e) => e.key) ?? [];

    const result = await store.commit({ selectedKeys: keys, onDuplicate: 'skip' });

    expect(result.success).toBe(2);
    expect(result.skipped).toBe(0);
    expect(store.committing).toBe(false);
    expect(store.error).toBeNull();
    expect((await sourceRepo.list()).map((s) => s.key).sort()).toEqual(['alist-a', 'webdav-b']);

    await store.loadRecords();
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ url: SUBSCRIPTION_URL, success: 2 });

    // 持久层同源（KV 键 import-records）
    const persisted = await readKv<Array<{ url: string }>>(KV_KEY_IMPORT_RECORDS);
    expect(persisted?.[0]?.url).toBe(SUBSCRIPTION_URL);
  });

  it('commit：重复源按 skip 跳过，结果数字正确', async () => {
    await sourceService.create({ name: '家里 AList', type: 'alist', baseUrl: 'https://alist.example.com', key: 'alist-a' });
    const store = useImportStore();
    await store.previewFromText(SUBSCRIPTION, 'sub.json');

    const result = await store.commit({ selectedKeys: [], onDuplicate: 'skip' });

    expect(result.success).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.issues.some((i) => i.code === 'SKIPPED_DUPLICATE')).toBe(true);
  });

  it('commit：预览无效条目经 Store 透传后计入 skipped（AC-13 / CHG-03）', async () => {
    const store = useImportStore();
    // 3 条里第 2 条缺 api → 预览阶段即无效
    await store.previewFromText(
      JSON.stringify({
        name: '混合订阅',
        sources: [
          { key: 'alist-a', name: '家里 AList', type: 'alist', api: 'https://alist.example.com/' },
          { key: 'broken', name: '缺地址的源', type: 'alist' },
          { key: 'webdav-b', name: 'NAS', type: 'webdav', api: 'https://nas.example.com/dav' },
        ],
      }),
      'mixed.json',
    );
    expect(store.preview?.total).toBe(3);

    const result = await store.commit({ selectedKeys: [], onDuplicate: 'skip' });

    expect(result.success).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.issues.some((i) => i.code === 'SKIPPED_INVALID')).toBe(true);
    expect(result.success + result.skipped).toBe(store.preview?.total);
  });

  it('commit：selectedKeys 为空 = 导入全部有效项（Store 透传语义）', async () => {
    const store = useImportStore();
    await store.previewFromText(SUBSCRIPTION, 'sub.json');

    const result = await store.commit({ selectedKeys: [], onDuplicate: 'skip' });

    expect(result.success).toBe(2);
    expect(result.skipped).toBe(0);
    expect((await sourceRepo.list()).map((s) => s.key).sort()).toEqual(['alist-a', 'webdav-b']);
  });

  it('commit：preview 为 null 时抛 E_INVALID_STATE 并写 error', async () => {
    const store = useImportStore();
    await expect(store.commit({ selectedKeys: [], onDuplicate: 'skip' })).rejects.toMatchObject({
      code: 'E_INVALID_STATE',
    });
    expect(store.error?.code).toBe('E_INVALID_STATE');
    expect(store.committing).toBe(false);
  });

  it('commit 失败：写 error 并 re-throw（不吞错）', async () => {
    const store = useImportStore();
    await store.previewFromText(SUBSCRIPTION, 'sub.json');
    const spy = vi.spyOn(sourceRepo, 'list').mockRejectedValue(new Error('db down'));

    await expect(store.commit({ selectedKeys: [], onDuplicate: 'skip' })).rejects.toMatchObject({ code: 'E_DB' });
    expect(store.error?.code).toBe('E_DB');
    expect(store.committing).toBe(false);
    spy.mockRestore();
  });

  it('解析失败：error 有值且 preview 为 null，不抛出', async () => {
    const store = useImportStore();
    await store.previewFromText(SUBSCRIPTION, 'sub.json');
    expect(store.preview).not.toBeNull();

    await expect(store.previewFromText('   ', 'empty.json')).resolves.toBeUndefined();
    expect(store.error?.code).toBe('E_INVALID_INPUT');
    expect(store.preview).toBeNull();
    expect(store.parsing).toBe(false);
  });

  it('previewFromUrl 网络失败：error 有值且 preview 为 null', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const store = useImportStore();

    await store.previewFromUrl(SUBSCRIPTION_URL);

    expect(store.error?.code).toBe('E_NETWORK');
    expect(store.preview).toBeNull();
    expect(store.parsing).toBe(false);
  });

  it('reset：清空 preview 与 error，保留 records', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SUBSCRIPTION));
    const store = useImportStore();
    await store.previewFromUrl(SUBSCRIPTION_URL);
    await store.commit({ selectedKeys: [], onDuplicate: 'skip' });
    await store.loadRecords();
    expect(store.records).toHaveLength(1);

    store.reset();

    expect(store.preview).toBeNull();
    expect(store.error).toBeNull();
    expect(store.records).toHaveLength(1);
  });

  it('多仓索引：预览带 repos，commit 被拒绝（E_INVALID_STATE）', async () => {
    const multi = JSON.stringify({
      name: '多仓',
      urls: [
        { url: 'https://a.example.com/box.json', name: 'A' },
        'https://b.example.com/box.json',
      ],
    });
    const store = useImportStore();
    await store.previewFromText(multi, 'dc.txt');

    expect(store.preview?.repos).toEqual([
      'https://a.example.com/box.json',
      'https://b.example.com/box.json',
    ]);
    expect(store.preview?.entries).toHaveLength(0);

    await expect(store.commit({ selectedKeys: [], onDuplicate: 'skip' })).rejects.toThrow('多仓');
    expect(store.error?.code).toBe('E_INVALID_STATE');
  });

  it('previewFromRepo：展开单个仓库地址后得到源列表', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SUBSCRIPTION));
    const store = useImportStore();

    await store.previewFromRepo('https://a.example.com/box.json');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://a.example.com/box.json');
    expect(store.preview?.repos).toEqual([]);
    expect(store.preview?.entries.map((e) => e.key)).toEqual(['alist-a', 'webdav-b']);
    expect(store.preview?.sourceUrl).toBe('https://a.example.com/box.json');
  });

  /* ---------- P0-2：解析可取消（signal 真正交下去，而不只是丢弃结果） ---------- */

  /** 受控预览：记录每次调用拿到的 signal，并由测试决定何时返回 */
  function controllablePreview(
    signals: AbortSignal[],
    gates: Array<() => void>,
  ) {
    return vi.spyOn(importService, 'previewFromUrl').mockImplementation(async (url, signal) => {
      signals.push(signal as AbortSignal);
      await new Promise<void>((resolve) => gates.push(resolve));
      return fakePreview(url ?? null);
    });
  }

  it('连续解析：新请求中止旧请求，且只有最后一次结果落地', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    controllablePreview(signals, gates);
    const store = useImportStore();

    const first = store.previewFromUrl('https://a.example.com/sub.json');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = store.previewFromUrl('https://b.example.com/sub.json');
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    gates.forEach((open) => open());
    await Promise.all([first, second]);

    expect(store.preview?.sourceUrl).toBe('https://b.example.com/sub.json');
    expect(store.error).toBeNull();
    expect(store.parsing).toBe(false);
  });

  it('abortPreview：中止在途解析后不落地结果、不写错误、parsing 归位', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    controllablePreview(signals, gates);
    const store = useImportStore();

    const pending = store.previewFromUrl(SUBSCRIPTION_URL);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    store.abortPreview();

    expect(signals[0]?.aborted).toBe(true);
    expect(store.parsing).toBe(false);

    gates[0]?.();
    await pending;

    expect(store.preview).toBeNull();
    expect(store.error).toBeNull();
  });

  it('reset：清预览的同时中止在途解析（离开页面不再占请求）', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    controllablePreview(signals, gates);
    const store = useImportStore();

    const pending = store.previewFromUrl(SUBSCRIPTION_URL);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    store.reset();

    expect(signals[0]?.aborted).toBe(true);
    gates[0]?.();
    await pending;
    expect(store.preview).toBeNull();
  });
});
