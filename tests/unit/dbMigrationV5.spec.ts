import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { deleteDatabase, getDb, resetDbConnection } from '@/db/index';
import { upgrade } from '@/db/migrations';
import type { CinemaDB } from '@/db/schema';
import { historyRepo } from '@/db/repositories/historyRepo';
import { DB_NAME, DB_VERSION } from '@/shared/constants';
import type { HistoryRecord } from '@/types';

import { tick } from './helpers';

/**
 * DB v5（history.by-media）升级链路。
 *
 * 迁移写错会让真机打不开库（整 App 白屏），所以这里既验证「v4 库升到 v5 后索引存在」，
 * 也验证自愈读的是索引：`recoverItem` 此前用 `listAllRaw()` 把最多 500 条（每条都带
 * `mediaSnapshot`）读进内存再 find。
 */

function makeRecord(id: string, mediaId: string, updatedAt: number): HistoryRecord {
  return {
    id,
    sourceId: 's1',
    mediaId,
    episodeId: `${mediaId}:e1`,
    episodeNumber: 1,
    title: `影片 ${mediaId}`,
    posterUrl: null,
    positionSec: 30,
    durationSec: 100,
    progress: 0.3,
    finished: false,
    totalEpisodes: 1,
    createdAt: updatedAt,
    updatedAt,
    mediaSnapshot: {
      sourceItemId: mediaId,
      type: 'movie',
      year: null,
      episodeCount: null,
      originalTitle: null,
    },
  };
}

/**
 * 按 v4 建库，但还原成「真实老库」的形态。
 *
 * migrations 的 `if (oldVersion < N)` 是连续下掉的：全新建库时 oldVersion 是 0，
 * 即使只要求打开到 v4，v5 分支也会执行并建好 by-media。而真实老用户在 v4 时 v5 代码
 * 还不存在，所以要在同一个 versionchange 事务里把索引删掉（deleteIndex 只能在
 * versionchange 事务里调用），否则测出来的「升级」永远是 no-op。
 */
function upgradeToV4(
  ...args: Parameters<typeof upgrade>
): void {
  const [db, oldVersion, newVersion, tx] = args;
  upgrade(db, oldVersion, newVersion, tx);
  tx.objectStore('history').deleteIndex('by-media');
}

describe('DB v5：history.by-media', () => {
  beforeEach(async () => {
    await deleteDatabase();
    resetDbConnection();
  });

  it('v4 库升到 v5 后索引存在，getByMedia 命中该媒体的记录', async () => {
    // 先按 v4 建库并写入历史（模拟老用户）
    const db4 = await openDB<CinemaDB>(DB_NAME, 4, { upgrade: upgradeToV4 });
    await db4.put('history', makeRecord('s1:m-a', 'm-a', 100));
    await db4.put('history', makeRecord('s1:m-b', 'm-b', 200));
    expect([...db4.transaction('history', 'readonly').objectStore('history').indexNames]).not.toContain(
      'by-media',
    );
    db4.close();
    // 给 fake-indexeddb 一个宏任务把连接摘除，否则下一次升级会看到「仍有连接未关闭」而 abort
    await tick();

    const db5 = await openDB<CinemaDB>(DB_NAME, 5, { upgrade });
    const tx = db5.transaction('history', 'readonly');
    expect([...tx.objectStore('history').indexNames].sort()).toEqual(
      ['by-media', 'by-source', 'by-updated'].sort(),
    );
    await tx.done;
    db5.close();
    await tick();

    resetDbConnection();
    expect(DB_VERSION).toBe(5);
    expect((await historyRepo.getByMedia('m-a'))?.id).toBe('s1:m-a');
    expect((await historyRepo.getByMedia('m-b'))?.id).toBe('s1:m-b');
    expect(await historyRepo.getByMedia('m-none')).toBeNull();
  });

  it('全新建库（oldVersion 0）同样带 by-media', async () => {
    const db = await getDb();
    const tx = db.transaction('history', 'readonly');
    expect([...tx.objectStore('history').indexNames].sort()).toEqual(['by-media', 'by-source', 'by-updated']);
    await tx.done;
  });
});
