import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { importService } from '@/services/importService';
import { sourceService } from '@/services/sourceService';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import { subscriptionRepo, subscriptionIdOf } from '@/db/repositories/subscriptionRepo';
import { useSourceStore } from '@/stores/sourceStore';
import { resetAll } from './helpers';

/**
 * 订阅实体（P1-2 / DB v7）
 *
 * 覆盖三件事：
 * 1. 导入时点——解析器给出的订阅名称随源一起落进 `subscriptions`（同一事务）；
 * 2. 台账里只有来源标识的旧数据——`summarize()` 首次聚合时补建实体，且补名口径
 *    优先用导入记录里的名称，多次调用不重复插入；
 * 3. 删除时点——订阅不再贡献任何源时收掉实体，避免每换一批订阅就往表里堆孤儿。
 */

/** 有名称的干净订阅（两条源全部可导入） */
const CLEAN = JSON.stringify({
  name: '干净订阅',
  sources: [
    { key: 'alist-a', name: '家里 AList', type: 'alist', api: 'https://alist.example.com/' },
    { key: 'webdav-b', name: 'NAS', type: 'webdav', api: 'https://nas.example.com/dav' },
  ],
});

/** 没有订阅名称的一份（顶层缺 name）——用于「空名称不得擦掉已知名称」 */
const ANON = JSON.stringify({
  sources: [
    { key: 'alist-a', name: '家里 AList', type: 'alist', api: 'https://alist.example.com/' },
    { key: 'webdav-b', name: 'NAS', type: 'webdav', api: 'https://nas.example.com/dav' },
  ],
});

/** 另一份订阅：源 key 与上面完全不同，用来验证「删 A 不动 B」 */
const OTHER = JSON.stringify({
  name: '另一订阅',
  sources: [{ key: 'alist-c', name: '公司 AList', type: 'alist', api: 'https://c.example.com/' }],
});

const URL_KEY = 'https://sub.example.com/clean.json';

/** 按真实链路把预览改成「从地址导入」：sourceUrl 有值、fileName 清空 */
async function previewFromUrlText(text: string): Promise<Awaited<ReturnType<typeof importService.previewFromText>>> {
  const preview = await importService.previewFromText(text, 'clean.json');
  return { ...preview, sourceUrl: URL_KEY, fileName: null };
}

async function commitAll(preview: Awaited<ReturnType<typeof importService.previewFromText>>) {
  return importService.commit(preview, {
    selectedKeys: preview.entries.map((e) => e.key),
    onDuplicate: 'overwrite',
  });
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await resetAll();
});

describe('importService.commit 写订阅实体', () => {
  it('URL 形态：key 用完整地址，名称取解析结果', async () => {
    const preview = await previewFromUrlText(CLEAN);
    await commitAll(preview);

    const entity = await subscriptionRepo.findByKey(URL_KEY);
    expect(entity).not.toBeNull();
    expect(entity?.id).toBe(subscriptionIdOf(URL_KEY));
    expect(entity?.key).toBe(URL_KEY);
    expect(entity?.url).toBe(URL_KEY);
    expect(entity?.fileName).toBeNull();
    expect(entity?.name).toBe('干净订阅');
    expect(await subscriptionRepo.count()).toBe(1);
  });

  it('文件形态：key 用文件名，url 为 null', async () => {
    const preview = await importService.previewFromText(CLEAN, 'clean.json');
    await commitAll(preview);

    const entity = await subscriptionRepo.findByKey('clean.json');
    expect(entity?.key).toBe('clean.json');
    expect(entity?.url).toBeNull();
    expect(entity?.fileName).toBe('clean.json');
    expect(entity?.name).toBe('干净订阅');
  });

  it('同一来源标识重复导入只有一条：createdAt 保持，空名称不擦掉已知名称', async () => {
    const first = await commitAll(await previewFromUrlText(CLEAN));
    const created = await subscriptionRepo.findByKey(URL_KEY);
    expect(first.success).toBe(2);

    // 第二份订阅没有名称（顶层缺 name），落库后仍应叫「干净订阅」
    await new Promise((r) => setTimeout(r, 2));
    const second = await commitAll(await previewFromUrlText(ANON));
    expect(second.success).toBe(2);

    expect(await subscriptionRepo.count()).toBe(1);
    const after = await subscriptionRepo.findByKey(URL_KEY);
    expect(after?.name).toBe('干净订阅');
    expect(after?.createdAt).toBe(created?.createdAt);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(created?.updatedAt ?? 0);
  });
});

describe('subscriptionLifecycleService.summarize 懒式补建', () => {
  /** 走一遍真实导入拿到「源已带 subscriptionId」的状态，再抹掉实体模拟升级前的老库 */
  async function seedLegacySubscription(key: string, text: string, fromUrl: boolean) {
    const base = await importService.previewFromText(text, 'clean.json');
    const preview = fromUrl ? { ...base, sourceUrl: key, fileName: null } : base;
    await commitAll(preview);
    await subscriptionRepo.removeByKey(key);
    expect(await subscriptionRepo.count()).toBe(0);
  }

  it('名称优先从导入记录里捞；二次调用不再新增', async () => {
    await seedLegacySubscription(URL_KEY, CLEAN, true);

    const summaries = await subscriptionLifecycleService.summarize();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('干净订阅');

    const entity = await subscriptionRepo.findByKey(URL_KEY);
    expect(entity?.url).toBe(URL_KEY);
    expect(entity?.fileName).toBeNull();

    await subscriptionLifecycleService.summarize();
    expect(await subscriptionRepo.count()).toBe(1);
  });

  it('记录里也没有名称时补建空名称实体，摘要 name 为 null（界面据此回退主机名）', async () => {
    await seedLegacySubscription('clean.json', ANON, false);

    const summaries = await subscriptionLifecycleService.summarize();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBeNull();
    // 文件导入没有 ImportRecord，补出来的实体带文件名不带地址
    const entity = await subscriptionRepo.findByKey('clean.json');
    expect(entity?.fileName).toBe('clean.json');
    expect(entity?.url).toBeNull();
    expect(entity?.name).toBeNull();
  });

  it('已有实体的订阅不被覆盖：改名后再聚合仍读实体', async () => {
    await seedLegacySubscription(URL_KEY, CLEAN, true);
    await subscriptionLifecycleService.summarize();
    const existing = await subscriptionRepo.findByKey(URL_KEY);
    expect(existing?.name).toBe('干净订阅');

    await subscriptionRepo.save({ ...existing!, name: '我自己改的名' });
    const summaries = await subscriptionLifecycleService.summarize();
    expect(summaries[0].name).toBe('我自己改的名');
    expect(await subscriptionRepo.count()).toBe(1);
  });

  it('补建写库失败只退回无名称口径，摘要照常返回（读路径不因 P1-2 变脆）', async () => {
    await seedLegacySubscription(URL_KEY, CLEAN, true);
    const failed = vi
      .spyOn(subscriptionRepo, 'upsertKeyed')
      .mockRejectedValueOnce(new Error('quota exceeded'));

    const summaries = await subscriptionLifecycleService.summarize();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].sourceCount).toBe(2);
    expect(summaries[0].name).toBeNull();

    failed.mockRestore();
    // 下一次聚合仍会补建（失败不留下半成品记录）
    expect(await subscriptionRepo.count()).toBe(0);
    await subscriptionLifecycleService.summarize();
    expect((await subscriptionRepo.findByKey(URL_KEY))?.name).toBe('干净订阅');
  });
});

describe('删除订阅时收掉实体', () => {
  it('最后一条源删除后实体一起清掉；其它订阅的实体不动', async () => {
    const store = useSourceStore();
    const urlPreview = await previewFromUrlText(CLEAN);
    await commitAll(urlPreview);
    // 另一份订阅用不同的源 key，避免 overwrite 把上面两条源的 subscriptionId 改写走
    await commitAll(await importService.previewFromText(OTHER, 'other.json'));
    expect(await subscriptionRepo.count()).toBe(2);

    await store.load();
    await expect(store.removeBySubscription(URL_KEY)).resolves.toBe(2);

    expect(await subscriptionRepo.findByKey(URL_KEY)).toBeNull();
    expect(await subscriptionRepo.findByKey('other.json')).not.toBeNull();
    expect(await subscriptionRepo.count()).toBe(1);
  });

  it('源已被逐个删掉（本次 removed = 0）时同样收掉实体，不留孤儿', async () => {
    const store = useSourceStore();
    await commitAll(await previewFromUrlText(CLEAN));
    await store.load();
    for (const source of store.sources.filter((s) => s.subscriptionId === URL_KEY)) {
      await sourceService.remove(source.id);
    }

    await expect(store.removeBySubscription(URL_KEY)).resolves.toBe(0);
    expect(await subscriptionRepo.findByKey(URL_KEY)).toBeNull();
  });

  it('删除别的订阅标识不会动到这一份的实体', async () => {
    const store = useSourceStore();
    await commitAll(await previewFromUrlText(CLEAN));
    await store.load();

    await expect(store.removeBySubscription('other.json')).resolves.toBe(0);
    expect(await subscriptionRepo.findByKey(URL_KEY)).not.toBeNull();
  });
});
