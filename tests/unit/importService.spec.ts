import { beforeEach, describe, expect, it } from 'vitest';

import { importService } from '@/services/importService';
import { sourceService } from '@/services/sourceService';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { resetAll } from './helpers';

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
