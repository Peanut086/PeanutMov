/**
 * 弹幕点赞存储（B-04）
 *
 * 源站弹幕没有可靠 id，身份全靠「秒 + 文本哈希」自己算，所以最要紧的是键稳不稳：
 * 1. 同一条弹幕反复拉取（尾数抖动、顺序变化）都落到同一个键；
 * 2. 换集 / 换剧各算各的，不会把上一部的赞带过来；
 * 3. 点赞状态立刻可读、刷新后仍在，且读取不能盖掉刚点下去的赞。
 *
 * 注：`entries` / `loadedKeys` 是模块级缓存，`resetAll()` 清不掉，故每个用例用独立 mediaId。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { danmakuLikeService } from '@/services/danmakuLikeService';
import type { DanmakuComment } from '@/types';

import { readKv, resetAll } from './helpers';

let seq = 0;
function nextMediaId(): string {
  seq += 1;
  return `tb:dlikes-${seq}`;
}

function comment(time: number, text: string): DanmakuComment {
  return { text, time, mode: 'scroll', color: 0xffffff };
}

function book(mediaId: string, ep: number | string): Record<string, number> {
  return danmakuLikeService.countsRef(mediaId, ep).value;
}

beforeEach(async () => {
  await resetAll();
});

describe('danmakuLikeService · 身份键', () => {
  it('同一条弹幕无论取多少次都是同一个键', () => {
    expect(danmakuLikeService.likeKey(comment(5.5, '名场面')))
      .toBe(danmakuLikeService.likeKey(comment(5.5, '名场面')));
  });

  it('时间抹到 0.1s：各源解析出的尾数抖动不算两条', () => {
    expect(danmakuLikeService.likeKey(comment(5.51, 'a')))
      .toBe(danmakuLikeService.likeKey(comment(5.5, 'a')));
  });

  it('同秒不同句、同句不同秒都分开', () => {
    expect(danmakuLikeService.likeKey(comment(5.5, 'a')))
      .not.toBe(danmakuLikeService.likeKey(comment(5.5, 'b')));
    expect(danmakuLikeService.likeKey(comment(5.5, 'a')))
      .not.toBe(danmakuLikeService.likeKey(comment(6.5, 'a')));
  });
});

describe('danmakuLikeService · 点赞与持久化', () => {
  it('点赞立刻生效并落库，再点取消', async () => {
    const id = nextMediaId();
    const c = comment(12.3, '高能');

    expect(await danmakuLikeService.toggleLike(id, 1, c)).toBe(true);
    expect(book(id, 1)[danmakuLikeService.likeKey(c)]).toBe(1);
    expect((await readKv<Record<string, number>>(`danmakuLikes:${id}#1`))?.[danmakuLikeService.likeKey(c)]).toBe(1);

    expect(await danmakuLikeService.toggleLike(id, 1, c)).toBe(false);
    expect(book(id, 1)[danmakuLikeService.likeKey(c)]).toBeUndefined();
    expect(await readKv<Record<string, number>>(`danmakuLikes:${id}#1`)).toEqual({});
  });

  it('库里已有的赞：loadLikes 读回来，重进播放页仍在', async () => {
    const id = nextMediaId();
    const c = comment(12.3, '高能');
    const key = danmakuLikeService.likeKey(c);
    await kvRepo.set(`danmakuLikes:${id}#1`, { [key]: 1 });

    expect(Object.keys(book(id, 1))).toHaveLength(0);
    expect(await danmakuLikeService.loadLikes(id, 1)).toEqual({ [key]: 1 });
    expect(book(id, 1)[key]).toBe(1);
  });

  it('先点过赞再进这一集：loadLikes 不盖掉刚点下去的赞', async () => {
    const id = nextMediaId();
    const c = comment(9.9, '先点再说');
    await kvRepo.set(`danmakuLikes:${id}#7`, {});

    expect(await danmakuLikeService.toggleLike(id, 7, c)).toBe(true);
    expect(await danmakuLikeService.loadLikes(id, 7)).toEqual({ [danmakuLikeService.likeKey(c)]: 1 });
  });

  it('重复 loadLikes 只读一次库', async () => {
    const id = nextMediaId();
    const c = comment(3.2, '第一遍');
    await danmakuLikeService.toggleLike(id, 1, c);

    await kvRepo.set(`danmakuLikes:${id}#1`, { 干扰: 9 });
    expect(await danmakuLikeService.loadLikes(id, 1)).toEqual({ [danmakuLikeService.likeKey(c)]: 1 });
  });
});

describe('danmakuLikeService · 分桶', () => {
  it('换集各算各的，换剧也各算各的', async () => {
    const id = nextMediaId();
    const other = nextMediaId();
    const c = comment(1.1, '同一句');

    await danmakuLikeService.toggleLike(id, 1, c);

    expect(book(id, 2)[danmakuLikeService.likeKey(c)]).toBeUndefined();
    expect(book(other, 1)[danmakuLikeService.likeKey(c)]).toBeUndefined();
    expect(await readKv<Record<string, number>>(`danmakuLikes:${id}#2`)).toBeNull();
  });

  it('同一分桶拿到同一个 ref', () => {
    const id = nextMediaId();
    expect(danmakuLikeService.countsRef(id, 3)).toBe(danmakuLikeService.countsRef(id, 3));
    expect(danmakuLikeService.countsRef(id, 3)).not.toBe(danmakuLikeService.countsRef(id, 4));
  });
});
