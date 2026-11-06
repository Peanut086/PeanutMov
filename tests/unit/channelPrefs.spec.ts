import { beforeEach, describe, expect, it } from 'vitest';

import {
  channelPrefsService,
  emptyPrefs,
  orderIndexMap,
  scopeKeyOf,
  sortByCustomOrder,
} from '@/services/channelPrefsService';
import { channelKeyOf } from '@/shared/channelKey';
import { CHANNEL_ORDER_MAX, LIVE_GROUP_MAX } from '@/shared/constants';

import { resetAll } from './helpers';

/**
 * EXT-06 / FR-69 / FR-70：频道分组与自定义排序（AC-165 / AC-166 / AC-167）
 * Q-19：分组仅本地（不随源同步）；Q-22：作用域按直播源隔离。
 */

const SOURCE_A = 'live-a';
const SOURCE_B = 'live-b';

describe('scopeKeyOf / orderIndexMap / sortByCustomOrder（纯函数 AC-167）', () => {
  it('scopeKey：all / 分组 / 源分组三种前缀', () => {
    expect(scopeKeyOf('all')).toBe('all');
    expect(scopeKeyOf('央视')).toBe('s:央视');
    expect(scopeKeyOf({ groupId: 'g1' })).toBe('g:g1');
  });

  it('orderIndexMap 保留首次出现下标（重复项不覆盖）', () => {
    const map = orderIndexMap(['a', 'b', 'a']);
    expect(map.get('a')).toBe(0);
    expect(map.get('b')).toBe(1);
    expect(map.size).toBe(2);
    expect(orderIndexMap(undefined).size).toBe(0);
  });

  it('已排序项按索引升序，未排序项保持原相对顺序追加末尾', () => {
    const items = ['c', 'a', 'd', 'b'];
    const sorted = sortByCustomOrder(items, (item) => item, ['b', 'a']);
    expect(sorted).toEqual(['b', 'a', 'c', 'd']);
  });

  it('无自定义序时原样返回（同一引用）', () => {
    const items = ['a', 'b'];
    expect(sortByCustomOrder(items, (item) => item, undefined)).toBe(items);
    expect(sortByCustomOrder(items, (item) => item, [])).toBe(items);
  });
});

describe('channelPrefsService（分组 CRUD）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('无记录时 get 返回空结构且不落库；ensure 落库', async () => {
    expect(await channelPrefsService.get(SOURCE_A)).toEqual(emptyPrefs(SOURCE_A));
    await channelPrefsService.ensure(SOURCE_A);
    const after = await channelPrefsService.get(SOURCE_A);
    expect(after.updatedAt).toBeGreaterThan(0);
  });

  it('创建分组：名称 trim、order 自 1 连续', async () => {
    const first = await channelPrefsService.createGroup(SOURCE_A, '  央视  ');
    const second = await channelPrefsService.createGroup(SOURCE_A, '卫视');
    expect(first.name).toBe('央视');
    expect(first.order).toBe(1);
    expect(second.order).toBe(2);
    const prefs = await channelPrefsService.get(SOURCE_A);
    expect(prefs.groups.map((g) => g.name)).toEqual(['央视', '卫视']);
  });

  it('分组名非法：空 / 超长 / 保留名 / 重名 全部拒绝', async () => {
    await channelPrefsService.createGroup(SOURCE_A, '央视');
    await expect(channelPrefsService.createGroup(SOURCE_A, '   ')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(
      channelPrefsService.createGroup(SOURCE_A, '一二三四五六七八九十一'),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(channelPrefsService.createGroup(SOURCE_A, '全部')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(channelPrefsService.createGroup(SOURCE_A, '未分组')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(channelPrefsService.createGroup(SOURCE_A, '央视')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });

  it(`分组数量上限 ${LIVE_GROUP_MAX}`, async () => {
    for (let i = 1; i <= LIVE_GROUP_MAX; i += 1) {
      await channelPrefsService.createGroup(SOURCE_A, `分组${i}`);
    }
    await expect(channelPrefsService.createGroup(SOURCE_A, '超限')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });

  it('重命名：不存在报 E_NOT_FOUND，重名被拒', async () => {
    const a = await channelPrefsService.createGroup(SOURCE_A, '央视');
    await channelPrefsService.createGroup(SOURCE_A, '卫视');
    const renamed = await channelPrefsService.renameGroup(SOURCE_A, a.id, '中央台');
    expect(renamed.name).toBe('中央台');
    await expect(
      channelPrefsService.renameGroup(SOURCE_A, a.id, '卫视'),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(
      channelPrefsService.renameGroup(SOURCE_A, 'g_missing', 'X'),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('删除分组：组内频道回到未分组、分组序重排、返回迁移数量', async () => {
    const a = await channelPrefsService.createGroup(SOURCE_A, '央视');
    const b = await channelPrefsService.createGroup(SOURCE_A, '卫视');
    await channelPrefsService.assign(SOURCE_A, 'nm:cctv1', a.id);
    await channelPrefsService.assign(SOURCE_A, 'nm:cctv2', a.id);
    await channelPrefsService.assign(SOURCE_A, 'nm:hunan', b.id);
    await channelPrefsService.setOrder(SOURCE_A, `g:${a.id}`, ['nm:cctv2', 'nm:cctv1']);

    const result = await channelPrefsService.removeGroup(SOURCE_A, a.id);
    expect(result.movedChannels).toBe(2);
    const prefs = await channelPrefsService.get(SOURCE_A);
    expect(prefs.groups).toEqual([expect.objectContaining({ id: b.id, order: 1 })]);
    expect(prefs.assignments).toEqual({ 'nm:hunan': b.id });
    expect(prefs.orders[`g:${a.id}`]).toBeUndefined();
  });

  it('分组排序必须包含全部分组', async () => {
    const a = await channelPrefsService.createGroup(SOURCE_A, '央视');
    const b = await channelPrefsService.createGroup(SOURCE_A, '卫视');
    await channelPrefsService.reorderGroups(SOURCE_A, [b.id, a.id]);
    expect((await channelPrefsService.get(SOURCE_A)).groups.map((g) => g.id)).toEqual([b.id, a.id]);
    await expect(
      channelPrefsService.reorderGroups(SOURCE_A, [a.id, a.id]),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(channelPrefsService.reorderGroups(SOURCE_A, [a.id])).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });

  it('频道归组：空键报错、目标分组不存在报 E_NOT_FOUND、null 表示移出', async () => {
    const a = await channelPrefsService.createGroup(SOURCE_A, '央视');
    await channelPrefsService.assign(SOURCE_A, 'nm:cctv1', a.id);
    expect((await channelPrefsService.get(SOURCE_A)).assignments['nm:cctv1']).toBe(a.id);
    await channelPrefsService.assign(SOURCE_A, 'nm:cctv1', null);
    expect((await channelPrefsService.get(SOURCE_A)).assignments['nm:cctv1']).toBeUndefined();
    await expect(channelPrefsService.assign(SOURCE_A, '', a.id)).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(
      channelPrefsService.assign(SOURCE_A, 'nm:cctv1', 'g_missing'),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('channelPrefsService（自定义排序与孤儿清理）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('setOrder 去重、按 scope 隔离、resetOrder 恢复源顺序', async () => {
    await channelPrefsService.setOrder(SOURCE_A, 'all', ['nm:b', 'nm:a', 'nm:b']);
    await channelPrefsService.setOrder(SOURCE_A, 's:央视', ['nm:c']);
    let prefs = await channelPrefsService.get(SOURCE_A);
    expect(prefs.orders.all).toEqual(['nm:b', 'nm:a']);
    expect(prefs.orders['s:央视']).toEqual(['nm:c']);

    await channelPrefsService.resetOrder(SOURCE_A, 'all');
    prefs = await channelPrefsService.get(SOURCE_A);
    expect(prefs.orders.all).toBeUndefined();
    expect(prefs.orders['s:央视']).toEqual(['nm:c']);
  });

  it('setOrder 空列表拒绝；超过 300 条拒绝', async () => {
    await expect(channelPrefsService.setOrder(SOURCE_A, 'all', [])).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    expect(CHANNEL_ORDER_MAX).toBe(300);
    const tooMany = Array.from({ length: CHANNEL_ORDER_MAX + 1 }, (_, i) => `nm:c${i}`);
    await expect(channelPrefsService.setOrder(SOURCE_A, 'all', tooMany)).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });

  it('prune 清掉不存在频道的排序项与归属，保留其余', async () => {
    const g = await channelPrefsService.createGroup(SOURCE_A, '央视');
    await channelPrefsService.assign(SOURCE_A, 'nm:cctv1', g.id);
    await channelPrefsService.assign(SOURCE_A, 'nm:cctv2', g.id);
    await channelPrefsService.setOrder(SOURCE_A, 'all', ['nm:cctv1', 'nm:cctv2']);

    expect(await channelPrefsService.countOrphans(SOURCE_A, ['nm:cctv1'])).toBe(2);
    const removed = await channelPrefsService.prune(SOURCE_A, ['nm:cctv1']);
    expect(removed).toEqual({ removedOrders: 1, removedAssignments: 1 });

    const prefs = await channelPrefsService.get(SOURCE_A);
    expect(prefs.orders.all).toEqual(['nm:cctv1']);
    expect(prefs.assignments).toEqual({ 'nm:cctv1': g.id });
    expect(prefs.groups).toHaveLength(1);
  });

  it('prune 无孤儿时不写库（updatedAt 不变）', async () => {
    await channelPrefsService.setOrder(SOURCE_A, 'all', ['nm:a']);
    const before = await channelPrefsService.get(SOURCE_A);
    await channelPrefsService.prune(SOURCE_A, ['nm:a']);
    const after = await channelPrefsService.get(SOURCE_A);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

describe('channelPrefsService（作用域隔离 AC-165）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('两个直播源的分组/归属/排序互不影响', async () => {
    await channelPrefsService.createGroup(SOURCE_A, '央视');
    await channelPrefsService.setOrder(SOURCE_A, 'all', ['nm:a']);

    expect((await channelPrefsService.get(SOURCE_B)).groups).toEqual([]);
    expect((await channelPrefsService.get(SOURCE_B)).orders).toEqual({});

    await channelPrefsService.remove(SOURCE_A);
    expect((await channelPrefsService.get(SOURCE_A)).groups).toEqual([]);
  });
});

describe('buildScopes（分组视图）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('全部 + 自定义分组 + 源分组，未归组频道落在源分组', async () => {
    const g = await channelPrefsService.createGroup(SOURCE_A, '我的收藏');
    const prefs = await channelPrefsService.get(SOURCE_A);
    const channels = [
      { name: 'CCTV1', sourceGroup: '央视' },
      { name: 'CCTV2', sourceGroup: '央视' },
      { name: '湖南卫视', sourceGroup: '卫视' },
      { name: '本地频道', sourceGroup: null },
    ];
    const withAssign = {
      ...prefs,
      assignments: { [channelKeyOf({ name: 'CCTV1' })]: g.id },
    };
    const scopes = channelPrefsService.buildScopes(channels, withAssign);

    expect(scopes.map((s) => s.key)).toEqual(['all', `g:${g.id}`, 's:央视', 's:卫视', 's:未分组']);
    expect(scopes[0]?.channelKeys).toHaveLength(4);
    expect(scopes[1]?.channelKeys).toEqual(['nm:cctv1']);
    expect(scopes[2]?.channelKeys).toEqual(['nm:cctv2']);
    expect(scopes[4]?.channelKeys).toEqual([channelKeyOf({ name: '本地频道' })]);
  });

  it('归属指向已删除分组时回落源分组（异常数据兜底）', async () => {
    const prefs = await channelPrefsService.get(SOURCE_A);
    const scopes = channelPrefsService.buildScopes(
      [{ name: 'CCTV1', sourceGroup: '央视' }],
      { ...prefs, assignments: { 'nm:cctv1': 'g_gone' } },
    );
    expect(scopes.map((s) => s.key)).toEqual(['all', 's:央视']);
  });
});
