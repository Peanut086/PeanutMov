/**
 * 片头/片尾标记存储（B-06）
 *
 * 标记是「标一次、整季复用」的数据，标错会一路跳到不该跳的地方，所以最要紧的三条：
 * 1. 不合理的位置根本不入库；
 * 2. 两侧边界互相吃掉时宁可丢一侧，也不留一段永远跳不对的标记；
 * 3. 清一侧不能顺手清掉另一侧。
 *
 * 注：`entries` / `loadedKeys` 是模块级缓存，`resetAll()` 清不掉，故每个用例用独立 mediaId。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { skipMarkService } from '@/services/skipMarkService';
import type { SkipMarks } from '@/types';

import { readKv, resetAll } from './helpers';

const DURATION = 600;

let seq = 0;
function nextMediaId(): string {
  seq += 1;
  return `tb:skipmark-${seq}`;
}

async function stored(id: string): Promise<SkipMarks | null> {
  return readKv<SkipMarks>(`skipmark:${id}`);
}

beforeEach(async () => {
  await resetAll();
});

describe('skipMarkService · 校验', () => {
  it('合法片头：入库并立刻可读，秒数取整', async () => {
    const id = nextMediaId();
    expect(await skipMarkService.markIntroEnd(id, 85.4, DURATION)).toBe(true);

    expect(skipMarkService.marksRef(id).value?.introEndSec).toBe(85);
    expect((await stored(id))?.introEndSec).toBe(85);
  });

  it('片头太短 / 落在片尾之后 / 非有限数：一律拒绝，且不写任何数据', async () => {
    const id = nextMediaId();
    expect(await skipMarkService.markIntroEnd(id, 2, DURATION)).toBe(false);
    expect(await skipMarkService.markIntroEnd(id, 597, DURATION)).toBe(false);
    expect(await skipMarkService.markIntroEnd(id, Number.NaN, DURATION)).toBe(false);

    expect(skipMarkService.marksRef(id).value).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  it('片尾太靠近结尾 / 起点太早：同样拒绝', async () => {
    const id = nextMediaId();
    expect(await skipMarkService.markCreditsStart(id, 3, DURATION)).toBe(false);
    expect(await skipMarkService.markCreditsStart(id, 598, DURATION)).toBe(false);
    expect(await skipMarkService.markCreditsStart(id, 540, DURATION)).toBe(true);
  });
});

describe('skipMarkService · 两侧互斥', () => {
  it('新片头越过旧片尾时丢掉片尾，只留能跳的一侧', async () => {
    const id = nextMediaId();
    await skipMarkService.markCreditsStart(id, 540, DURATION);
    await skipMarkService.markIntroEnd(id, 560, DURATION);

    const marks = skipMarkService.marksRef(id).value;
    expect(marks?.introEndSec).toBe(560);
    expect(marks?.creditsStartSec).toBeNull();
    expect((await stored(id))?.creditsStartSec).toBeNull();
  });

  it('新片尾早于旧片头时丢掉旧片头', async () => {
    const id = nextMediaId();
    await skipMarkService.markIntroEnd(id, 540, DURATION);
    await skipMarkService.markCreditsStart(id, 500, DURATION);

    const marks = skipMarkService.marksRef(id).value;
    expect(marks?.introEndSec).toBeNull();
    expect(marks?.creditsStartSec).toBe(500);
  });

  it('两侧都标过则各自保留', async () => {
    const id = nextMediaId();
    await skipMarkService.markIntroEnd(id, 90, DURATION);
    await skipMarkService.markCreditsStart(id, 540, DURATION);

    expect(skipMarkService.marksRef(id).value).toMatchObject({ introEndSec: 90, creditsStartSec: 540 });
  });
});

describe('skipMarkService · 读取与清除', () => {
  it('无标记时读出 null（进度条据此退回原样）', async () => {
    const id = nextMediaId();
    expect(await skipMarkService.loadMarks(id)).toBeNull();
    expect(skipMarkService.marksRef(id).value).toBeNull();
  });

  it('已有数据重新读取：整季复用，重进播放页仍在', async () => {
    const id = nextMediaId();
    await kvRepo.set(`skipmark:${id}`, { introEndSec: 90, creditsStartSec: 540, updatedAt: 1 });

    expect(await skipMarkService.loadMarks(id)).toMatchObject({ introEndSec: 90, creditsStartSec: 540 });
  });

  it('重复 loadMarks 不覆盖刚标好的值', async () => {
    const id = nextMediaId();
    await skipMarkService.loadMarks(id);
    await skipMarkService.markIntroEnd(id, 90, DURATION);

    expect((await skipMarkService.loadMarks(id))?.introEndSec).toBe(90);
  });

  it('只清一侧时另一侧保留；两侧都空则整条删除', async () => {
    const id = nextMediaId();
    await skipMarkService.markIntroEnd(id, 90, DURATION);
    await skipMarkService.markCreditsStart(id, 540, DURATION);

    await skipMarkService.clearSide(id, 'intro');
    expect(skipMarkService.marksRef(id).value).toMatchObject({ introEndSec: null, creditsStartSec: 540 });
    expect(await stored(id)).not.toBeNull();

    await skipMarkService.clearSide(id, 'credits');
    expect(skipMarkService.marksRef(id).value).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  it('每个剧集一份标记：换剧不会残留上一部的区间', async () => {
    const a = nextMediaId();
    const b = nextMediaId();
    await skipMarkService.markIntroEnd(a, 90, DURATION);

    expect(skipMarkService.marksRef(b).value).toBeNull();
    expect(skipMarkService.marksRef(a).value?.introEndSec).toBe(90);
  });
});
