import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attachSuggestions, importService } from '@/services/importService';
import { sourceService } from '@/services/sourceService';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { resetAll } from './helpers';

/** 爬虫 jar 预检的 HEAD mock（CHG-10）；仅预检使用 httpClient，commit 链路不受影响 */
const { httpHead } = vi.hoisted(() => ({
  httpHead: vi.fn(async (_url: string, _options?: unknown) => {}),
}));
vi.mock('@/sources/base/httpClient', () => ({ httpClient: { request: httpHead } }));

/**
 * `ImportResult` 口径（CHG-03 / AC-13）
 *
 * - `skipped` = 预览阶段无效条目 + 与已有源重复且 skip 的条目；
 * - `selectedKeys: []` = 导入全部有效项；
 * - 不变量：`success + skipped + 未勾选的合法条目 = preview.total`。
 */
const MIXED = JSON.stringify({
  name: '混合订阅',
  version: 1,
  sources: [
    { key: 'alist-a', name: '家里 AList', type: 'alist', api: 'https://alist.example.com/' },
    { key: 'broken', name: '缺地址的源', type: 'alist' },
    { key: 'webdav-b', name: 'NAS', type: 'webdav', api: 'https://nas.example.com/dav' },
  ],
});

const ALL_BROKEN = JSON.stringify({
  name: '全无效订阅',
  sources: [
    { key: 'bad-1', name: '坏源 1', type: 'alist' },
    { key: 'bad-2', name: '坏源 2', type: 'unknown-type', api: 'https://x.example.com' },
  ],
});

const CLEAN = JSON.stringify({
  name: '干净订阅',
  sources: [
    { key: 'alist-a', name: '家里 AList', type: 'alist', api: 'https://alist.example.com/' },
    { key: 'webdav-b', name: 'NAS', type: 'webdav', api: 'https://nas.example.com/dav' },
  ],
});

async function seedExisting(key: string, name: string, baseUrl: string): Promise<string> {
  const created = await sourceService.create({ key, name, type: 'alist', baseUrl });
  return created.id;
}

describe('importService.commit 的 skipped 口径（AC-13 / CHG-03）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('预览阶段判定无效的条目计入 skipped，并给出 SKIPPED_INVALID 汇总', async () => {
    const preview = await importService.previewFromText(MIXED, 'mixed.json');
    expect(preview.total).toBe(3);
    expect(preview.entries.filter((e) => !e.valid)).toHaveLength(1);

    const result = await importService.commit(
      preview,
      { selectedKeys: preview.entries.map((e) => e.key), onDuplicate: 'skip' },
    );

    expect(result.success).toBe(2);
    expect(result.skipped).toBe(1); // 缺 api 的条目
    expect(result.failed).toBe(0);
    expect(result.sourceIds).toHaveLength(2);

    const invalidIssue = result.issues.find((i) => i.code === 'SKIPPED_INVALID');
    expect(invalidIssue?.level).toBe('info');
    expect(invalidIssue?.message).toContain('缺地址的源');
    expect(invalidIssue?.message).toContain('1 个源');
  });

  it('预览无效 + 重复源两类同时计入 skipped（success + skipped = total）', async () => {
    await seedExisting('alist-a', '家里 AList', 'https://alist.example.com');
    const preview = await importService.previewFromText(MIXED, 'mixed.json');
    const duplicated = preview.entries.find((e) => e.key === 'alist-a');
    expect(duplicated?.duplicateOf).not.toBeNull();

    const result = await importService.commit(
      preview,
      { selectedKeys: preview.entries.map((e) => e.key), onDuplicate: 'skip' },
    );

    // 缺 api 的 1 条 + 与已有源重复的 1 条 = 2；仅 webdav-b 落库
    expect(result.success).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.issues.filter((i) => i.code === 'SKIPPED_DUPLICATE')).toHaveLength(1);
    expect(result.issues.filter((i) => i.code === 'SKIPPED_INVALID')).toHaveLength(1);
    expect(result.success + result.skipped).toBe(preview.total);
    expect((await sourceRepo.list()).map((s) => s.key).sort()).toEqual(['alist-a', 'webdav-b']);
  });

  it('重复源在 keep-both / overwrite 下不增加 skipped（只算预览无效）', async () => {
    await seedExisting('alist-a', '家里 AList', 'https://alist.example.com');
    const preview = await importService.previewFromText(MIXED, 'mixed.json');
    const keys = preview.entries.map((e) => e.key);

    const keepBoth = await importService.commit(preview, { selectedKeys: keys, onDuplicate: 'keep-both' });
    expect(keepBoth.success).toBe(2);
    expect(keepBoth.skipped).toBe(1); // 只剩缺 api 的那条

    const overwrite = await importService.commit(preview, { selectedKeys: keys, onDuplicate: 'overwrite' });
    expect(overwrite.success).toBe(2);
    expect(overwrite.skipped).toBe(1);
  });

  it('同一份预览重复提交（overwrite）：过期快照的 key 冲突按覆盖处理，不触发唯一索引错误', async () => {
    const preview = await importService.previewFromText(CLEAN, 'clean.json');
    const keys = preview.entries.map((e) => e.key);

    const first = await importService.commit(preview, { selectedKeys: keys, onDuplicate: 'overwrite' });
    expect(first.success).toBe(2);

    // 预览是旧快照（duplicateOf 均为 null），此时两个 key 都已存在
    const second = await importService.commit(preview, { selectedKeys: keys, onDuplicate: 'overwrite' });
    expect(second.success).toBe(2);
    expect(second.skipped).toBe(0);
    // 覆盖不新增记录：仍为 2 条，且 id 保持不变
    const rows = await sourceRepo.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((s) => s.id).sort()).toEqual([...first.sourceIds].sort());
  });

  it('全部条目无效时：success 0 / skipped = total，且不写库', async () => {
    const preview = await importService.previewFromText(ALL_BROKEN, 'broken.json');
    expect(preview.total).toBe(2);

    const result = await importService.commit(preview, { selectedKeys: [], onDuplicate: 'skip' });

    expect(result.success).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.sourceIds).toEqual([]);
    expect(result.issues.filter((i) => i.code === 'SKIPPED_INVALID')).toHaveLength(1);
    expect(await sourceRepo.list()).toHaveLength(0);
  });

  it('无效条目不因未勾选而重复计数', async () => {
    const preview = await importService.previewFromText(MIXED, 'mixed.json');
    // 只勾选一条有效源：无效的 1 条 → skipped，未勾选的另 1 条有效源 → 不计 skipped
    const result = await importService.commit(preview, { selectedKeys: ['webdav-b'], onDuplicate: 'skip' });

    expect(result.success).toBe(1);
    expect(result.skipped).toBe(1);
    // 不变量：success + skipped + 未勾选的合法条目 = total
    expect(result.success + result.skipped + 1).toBe(preview.total);
    expect((await sourceRepo.list()).map((s) => s.key)).toEqual(['webdav-b']);
  });
});

describe('importService.commit 的 selectedKeys 语义（CHG-03）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('selectedKeys: [] 表示导入全部有效项', async () => {
    const preview = await importService.previewFromText(CLEAN, 'clean.json');
    expect(preview.entries.every((e) => e.valid)).toBe(true);

    const result = await importService.commit(preview, { selectedKeys: [], onDuplicate: 'skip' });

    expect(result.success).toBe(2);
    expect(result.skipped).toBe(0);
    expect((await sourceRepo.list()).map((s) => s.key).sort()).toEqual(['alist-a', 'webdav-b']);
  });

  it('非空 selectedKeys 只导入命中项（大小写/空白敏感）', async () => {
    const preview = await importService.previewFromText(CLEAN, 'clean.json');

    const result = await importService.commit(preview, { selectedKeys: ['alist-a'], onDuplicate: 'skip' });

    expect(result.success).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.sourceIds).toHaveLength(1);
    expect((await sourceRepo.list()).map((s) => s.key)).toEqual(['alist-a']);
  });

  it('selectedKeys 全为无效 key 时不写入任何源', async () => {
    const preview = await importService.previewFromText(CLEAN, 'clean.json');

    const result = await importService.commit(
      preview,
      { selectedKeys: ['not-exist-key'], onDuplicate: 'skip' },
    );

    expect(result.success).toBe(0);
    expect(result.skipped).toBe(0); // 未勾选 ≠ 跳过
    expect(result.sourceIds).toEqual([]);
    expect(await sourceRepo.list()).toHaveLength(0);
  });
});

describe('importService 爬虫 jar 预检（CHG-10）', () => {
  /** 两个条目共享同一 jar（共享结果只 HEAD 一次），另有一个独立 jar 的条目 */
  const SUB = JSON.stringify({
    name: '爬虫订阅',
    spider: 'https://cdn.example.com/shared.jar',
    sites: [
      { key: 's-shared-1', name: '共享爬虫 1', type: 3, api: 'csp_A' },
      { key: 's-shared-2', name: '共享爬虫 2', type: 3, api: 'csp_B' },
      { key: 's-own', name: '独立爬虫', type: 3, api: 'csp_C', jar: 'https://cdn.example.com/own.jar' },
      { key: 'site-x', name: '站点源', type: 0, api: 'https://cms.example.com/api.php/provide/vod' },
    ],
  });

  beforeEach(async () => {
    await resetAll();
    httpHead.mockReset();
    httpHead.mockResolvedValue(undefined);
  });

  it('jar 可达：条目默认勾选且无 jar 警示', async () => {
    const preview = await importService.previewFromText(SUB, 's.json');
    const spiders = preview.entries.filter((e) => e.type === 'spider');
    expect(spiders).toHaveLength(3);
    for (const entry of spiders) {
      expect(entry.selected).toBe(true);
      expect(entry.warning ?? '').not.toContain('jar');
    }
  });

  it('jar 403：判死条目取消默认勾选并追加警示，其余不受影响', async () => {
    const { AppError } = await import('@/shared/errors');
    httpHead.mockImplementation(async (url: string) => {
      if (String(url).includes('own.jar')) {
        throw new AppError('E_HTTP_403', undefined, { httpStatus: 403 });
      }
    });
    const preview = await importService.previewFromText(SUB, 's.json');

    const own = preview.entries.find((e) => e.key === 's-own');
    expect(own?.selected).toBe(false);
    expect(own?.warning).toContain('jar 不可达');
    expect(own?.warning).toContain('403');

    const shared = preview.entries.filter((e) => e.key.startsWith('s-shared'));
    for (const entry of shared) {
      expect(entry.selected).toBe(true);
      expect(entry.warning ?? '').not.toContain('jar 不可达');
    }
  });

  it('共享 jar 只 HEAD 一次（结果复用）', async () => {
    await importService.previewFromText(SUB, 's.json');
    const urls = httpHead.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u.includes('shared.jar'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('own.jar'))).toHaveLength(1);
    // 非 spider 条目（站点源）不预检
    expect(urls.some((u) => u.includes('cms.example.com'))).toBe(false);
  });

  it('HEAD 超时：结论不确定，不判死', async () => {
    const { AppError } = await import('@/shared/errors');
    httpHead.mockRejectedValue(new AppError('E_TIMEOUT'));
    const preview = await importService.previewFromText(SUB, 's.json');
    for (const entry of preview.entries.filter((e) => e.type === 'spider')) {
      expect(entry.selected).toBe(true);
      expect(entry.warning ?? '').not.toContain('jar 不可达');
    }
  });
});

/* ---------- v1.7/CHG-18：非订阅内容兜底建议 ---------- */

describe('CHG-18 suggestions', () => {
  const LIVE_M3U = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="央视",CCTV-1',
    'https://cdn.example.com/1.m3u8',
    '#EXTINF:-1 group-title="央视",CCTV-2',
    'https://cdn.example.com/2.m3u8',
  ].join('\n');

  it('m3u 直播列表：不被误判为多仓索引（真机回归），URL 导入产出 add-live 建议', async () => {
    const preview = await importService.previewFromText(LIVE_M3U, 'live.m3u');
    expect(preview.repos).toEqual([]); // 不再误判为多仓
    // 文件/文本导入无来源地址，不产建议（attachSuggestions 门控）
    expect(preview.suggestions ?? []).toEqual([]);
    // URL 导入路径（真机走的就是这条）
    const withUrl = attachSuggestions(preview, LIVE_M3U, 'https://cdn.example.com/live.m3u');
    expect(withUrl.suggestions).toHaveLength(1);
    expect(withUrl.suggestions?.[0]).toMatchObject({ kind: 'live-list', action: 'add-live', channelCount: 2 });
  });

  it('单流 m3u8：URL 导入产出 add-channel 建议', async () => {
    const text = '#EXTM3U\nhttps://cdn.example.com/live.m3u8';
    const preview = await importService.previewFromText(text, 'x.m3u8');
    const withUrl = attachSuggestions(preview, text, 'https://cdn.example.com/live.m3u8');
    expect(withUrl.suggestions?.[0]).toMatchObject({ kind: 'single-stream', action: 'add-channel' });
  });

  it('macCMS 采集响应：URL 导入产出 add-site 建议', async () => {
    const cms = JSON.stringify({ code: 1, class: [{ type_id: 1, type_name: '电影' }], list: [] });
    const preview = await importService.previewFromText(cms, 'api.json');
    const withUrl = attachSuggestions(preview, cms, 'https://api.example.com/api.php/provide/vod/at/json');
    expect(withUrl.suggestions?.[0]).toMatchObject({ kind: 'cms-api', action: 'add-site' });
  });

  it('多仓逐行 URL 文本（非直播）：仍是多仓识别，不产建议', async () => {
    const repos = 'https://a.example.com/1.json\nhttps://b.example.com/2.json';
    const preview = await importService.previewFromText(repos, 'dc.txt');
    expect(preview.repos).toHaveLength(2);
    expect(preview.suggestions ?? []).toEqual([]);
  });
});
