/**
 * 频道分组与自定义排序（EXT-06 / FR-69 / FR-70，API-21）
 *
 * 作用域隔离：一条 `channelPrefs` 记录对应一个直播源（keyPath = `liveSourceId`），
 * 不同直播源的分组、归属、排序互不影响（Q-22 默认 A）。
 *
 * 排序语义（AC-166/167）：失效沉底 > 收藏置顶 > 自定义序 > 源分组原始顺序；
 * 排序写入为「整表覆盖」，新增频道追加末尾、被删频道顺序项保留但不渲染（可一键清理）。
 */
import { channelPrefsRepo } from '@/db/repositories/channelPrefsRepo';
import { channelKeyOf, normalizeChannelName } from '@/shared/channelKey';
import { CHANNEL_ORDER_MAX, LIVE_GROUP_MAX, LIVE_GROUP_NAME_MAX } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import { newId } from '@/shared/id';
import type { ChannelGroupDef, ChannelPrefs } from '@/types';

/** 保留分组名（不可新建/重命名） */
const RESERVED_NAMES = ['全部', '未分组'];

/** 空结构（不写库） */
export function emptyPrefs(liveSourceId: string): ChannelPrefs {
  return { liveSourceId, groups: [], assignments: {}, orders: {}, updatedAt: 0 };
}

function validateGroupName(raw: string, groups: ChannelGroupDef[], excludeId?: string): string {
  const name = (raw ?? '').trim();
  if (name.length === 0) throw new AppError('E_INVALID_INPUT', '请填写分组名称');
  if (name.length > LIVE_GROUP_NAME_MAX) {
    throw new AppError('E_INVALID_INPUT', `分组名称不能超过 ${LIVE_GROUP_NAME_MAX} 个字符`);
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new AppError('E_INVALID_INPUT', `“${name}”是保留名称，请换一个`);
  }
  const duplicated = groups.some(
    (group) => group.id !== excludeId && group.name.trim() === name,
  );
  if (duplicated) throw new AppError('E_INVALID_INPUT', `分组“${name}”已存在`);
  return name;
}

function sortGroups(groups: ChannelGroupDef[]): ChannelGroupDef[] {
  return [...groups].sort((a, b) => a.order - b.order);
}

/** scopeKey：`all` | `g:<groupId>` | `s:<源分组名>` */
export function scopeKeyOf(target: string | { groupId: string }): string {
  if (typeof target === 'string') return target === 'all' ? 'all' : `s:${target}`;
  return `g:${target.groupId}`;
}

/**
 * 自定义排序索引表（未出现在 order 中的频道得到 `undefined`，排在已排序频道之后）。
 * 供 LiveView 与单测复用，避免各处各写一套比较逻辑。
 */
export function orderIndexMap(order: string[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!order) return map;
  order.forEach((key, index) => {
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

/**
 * 按自定义序稳定排序：已排序项按索引升序，未排序项保持原相对顺序追加在末尾（AC-167）。
 * `keysOf` 返回频道身份键（`channelKeyOf`）。
 */
export function sortByCustomOrder<T>(
  items: T[],
  keysOf: (item: T) => string,
  order: string[] | undefined,
): T[] {
  const indexMap = orderIndexMap(order);
  if (indexMap.size === 0) return items;
  const indexed: Array<{ item: T; index: number; seq: number }> = [];
  const appended: Array<{ item: T; seq: number }> = [];
  items.forEach((item, seq) => {
    const index = indexMap.get(keysOf(item));
    if (index === undefined) appended.push({ item, seq });
    else indexed.push({ item, index, seq });
  });
  indexed.sort((a, b) => (a.index !== b.index ? a.index - b.index : a.seq - b.seq));
  return [...indexed.map((entry) => entry.item), ...appended.map((entry) => entry.item)];
}

export const channelPrefsService = {
  /** 读取偏好（无记录返回空结构，不写库） */
  async get(liveSourceId: string): Promise<ChannelPrefs> {
    const record = await channelPrefsRepo.get(liveSourceId);
    if (!record) return emptyPrefs(liveSourceId);
    return {
      liveSourceId: record.liveSourceId,
      groups: sortGroups(record.groups ?? []),
      assignments: record.assignments ?? {},
      orders: record.orders ?? {},
      updatedAt: record.updatedAt ?? 0,
    };
  },

  /** 读取偏好（无记录则落库默认结构） */
  async ensure(liveSourceId: string): Promise<ChannelPrefs> {
    const existing = await channelPrefsRepo.get(liveSourceId);
    if (existing) return channelPrefsService.get(liveSourceId);
    const prefs = emptyPrefs(liveSourceId);
    await channelPrefsRepo.save({ ...prefs, updatedAt: Date.now() });
    return prefs;
  },

  async createGroup(liveSourceId: string, name: string): Promise<ChannelGroupDef> {
    const prefs = await channelPrefsService.get(liveSourceId);
    if (prefs.groups.length >= LIVE_GROUP_MAX) {
      throw new AppError('E_INVALID_INPUT', `分组数量已达上限（${LIVE_GROUP_MAX} 个）`);
    }
    const validName = validateGroupName(name, prefs.groups);
    const group: ChannelGroupDef = {
      id: `g_${newId()}`,
      name: validName,
      order: prefs.groups.length + 1,
      createdAt: Date.now(),
    };
    await channelPrefsRepo.save({
      liveSourceId,
      groups: [...prefs.groups, group],
      assignments: prefs.assignments,
      orders: prefs.orders,
      updatedAt: Date.now(),
    });
    return group;
  },

  async renameGroup(
    liveSourceId: string,
    groupId: string,
    name: string,
  ): Promise<ChannelGroupDef> {
    const prefs = await channelPrefsService.get(liveSourceId);
    const target = prefs.groups.find((group) => group.id === groupId);
    if (!target) throw new AppError('E_NOT_FOUND', '分组不存在');
    const validName = validateGroupName(name, prefs.groups, groupId);
    const next: ChannelGroupDef = { ...target, name: validName };
    await channelPrefsRepo.save({
      liveSourceId,
      groups: prefs.groups.map((group) => (group.id === groupId ? next : group)),
      assignments: prefs.assignments,
      orders: prefs.orders,
      updatedAt: Date.now(),
    });
    return next;
  },

  /** 删除分组：组内频道回到「未分组」（原源分组），返回迁移数量 */
  async removeGroup(
    liveSourceId: string,
    groupId: string,
  ): Promise<{ removedGroupId: string; movedChannels: number }> {
    const prefs = await channelPrefsService.get(liveSourceId);
    if (!prefs.groups.some((group) => group.id === groupId)) {
      throw new AppError('E_NOT_FOUND', '分组不存在');
    }
    let movedChannels = 0;
    const assignments: Record<string, string> = {};
    for (const [channelKey, value] of Object.entries(prefs.assignments)) {
      if (value === groupId) movedChannels += 1;
      else assignments[channelKey] = value;
    }
    const orders = { ...prefs.orders };
    delete orders[`g:${groupId}`];
    const groups = prefs.groups
      .filter((group) => group.id !== groupId)
      .sort((a, b) => a.order - b.order)
      .map((group, index) => ({ ...group, order: index + 1 }));
    await channelPrefsRepo.save({
      liveSourceId,
      groups,
      assignments,
      orders,
      updatedAt: Date.now(),
    });
    return { removedGroupId: groupId, movedChannels };
  },

  /** 分组排序（整表覆盖） */
  async reorderGroups(liveSourceId: string, groupIds: string[]): Promise<{ order: string[] }> {
    const prefs = await channelPrefsService.get(liveSourceId);
    const current = prefs.groups.map((group) => group.id);
    const sameSet =
      groupIds.length === current.length &&
      new Set(groupIds).size === groupIds.length &&
      groupIds.every((id) => current.includes(id));
    if (!sameSet) throw new AppError('E_INVALID_INPUT', '分组排序必须包含全部分组且不重复');
    const byId = new Map(prefs.groups.map((group) => [group.id, group]));
    const groups = groupIds.map((id, index) => ({ ...byId.get(id)!, order: index + 1 }));
    await channelPrefsRepo.save({
      liveSourceId,
      groups,
      assignments: prefs.assignments,
      orders: prefs.orders,
      updatedAt: Date.now(),
    });
    return { order: groupIds };
  },

  /** 频道归组（groupId=null 表示移出分组） */
  async assign(
    liveSourceId: string,
    channelKey: string,
    groupId: string | null,
  ): Promise<{ channelKey: string; groupId: string | null }> {
    if (!channelKey) throw new AppError('E_INVALID_INPUT', '缺少频道标识');
    const prefs = await channelPrefsService.get(liveSourceId);
    if (groupId && !prefs.groups.some((group) => group.id === groupId)) {
      throw new AppError('E_NOT_FOUND', '分组不存在');
    }
    const assignments = { ...prefs.assignments };
    if (groupId) assignments[channelKey] = groupId;
    else delete assignments[channelKey];
    await channelPrefsRepo.save({
      liveSourceId,
      groups: prefs.groups,
      assignments,
      orders: prefs.orders,
      updatedAt: Date.now(),
    });
    return { channelKey, groupId };
  },

  /** 写入自定义排序（整表覆盖、去重、≤300） */
  async setOrder(
    liveSourceId: string,
    scopeKey: string,
    channelKeys: string[],
  ): Promise<{ scopeKey: string; count: number }> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const key of channelKeys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(key);
    }
    if (unique.length === 0) throw new AppError('E_INVALID_INPUT', '排序列表不能为空');
    if (unique.length > CHANNEL_ORDER_MAX) {
      throw new AppError(
        'E_INVALID_INPUT',
        `单次排序最多 ${CHANNEL_ORDER_MAX} 个频道（当前 ${unique.length} 个）`,
      );
    }
    const prefs = await channelPrefsService.get(liveSourceId);
    await channelPrefsRepo.save({
      liveSourceId,
      groups: prefs.groups,
      assignments: prefs.assignments,
      orders: { ...prefs.orders, [scopeKey]: unique },
      updatedAt: Date.now(),
    });
    return { scopeKey, count: unique.length };
  },

  /** 恢复源顺序（删除该 scope 的自定义序） */
  async resetOrder(liveSourceId: string, scopeKey: string): Promise<{ scopeKey: string; reset: true }> {
    const prefs = await channelPrefsService.get(liveSourceId);
    const orders = { ...prefs.orders };
    delete orders[scopeKey];
    await channelPrefsRepo.save({
      liveSourceId,
      groups: prefs.groups,
      assignments: prefs.assignments,
      orders,
      updatedAt: Date.now(),
    });
    return { scopeKey, reset: true };
  },

  /**
   * 清理孤儿项（AC-167）：删除已不存在的频道的排序项与归属，
   * 分组顺序保持不变；返回清理数量。
   */
  async prune(
    liveSourceId: string,
    existingKeys: string[],
  ): Promise<{ removedOrders: number; removedAssignments: number }> {
    const prefs = await channelPrefsService.get(liveSourceId);
    const exist = new Set(existingKeys);
    let removedOrders = 0;
    let removedAssignments = 0;

    const orders: Record<string, string[]> = {};
    for (const [scopeKey, keys] of Object.entries(prefs.orders)) {
      const kept = keys.filter((key) => exist.has(key));
      removedOrders += keys.length - kept.length;
      if (kept.length > 0) orders[scopeKey] = kept;
    }
    const assignments: Record<string, string> = {};
    for (const [channelKey, groupId] of Object.entries(prefs.assignments)) {
      if (exist.has(channelKey)) assignments[channelKey] = groupId;
      else removedAssignments += 1;
    }

    if (removedOrders > 0 || removedAssignments > 0) {
      await channelPrefsRepo.save({
        liveSourceId,
        groups: prefs.groups,
        assignments,
        orders,
        updatedAt: Date.now(),
      });
    }
    return { removedOrders, removedAssignments };
  },

  /** 统计孤儿排序项数量（UI「清理失效排序项（n）」） */
  async countOrphans(liveSourceId: string, existingKeys: string[]): Promise<number> {
    const prefs = await channelPrefsService.get(liveSourceId);
    const exist = new Set(existingKeys);
    let count = 0;
    for (const keys of Object.values(prefs.orders)) {
      count += keys.filter((key) => !exist.has(key)).length;
    }
    for (const channelKey of Object.keys(prefs.assignments)) {
      if (!exist.has(channelKey)) count += 1;
    }
    return count;
  },

  /** 直播源删除时级联清理 */
  async remove(liveSourceId: string): Promise<void> {
    await channelPrefsRepo.remove(liveSourceId);
  },

  /**
   * 分组视图：把频道按键分配到「全部 / 自定义分组 / 源分组」。
   * `sourceGroup` 为频道在 m3u 中的 `group-title`（无则「未分组」）。
   */
  buildScopes(
    channels: Array<{ name: string; sourceGroup: string | null }>,
    prefs: ChannelPrefs,
  ): Array<{ key: string; title: string; channelKeys: string[] }> {
    const all: string[] = [];
    const byGroup = new Map<string, string[]>();
    const bySource = new Map<string, string[]>();
    for (const channel of channels) {
      const key = channelKeyOf({ name: channel.name });
      all.push(key);
      const groupId = prefs.assignments[key];
      if (groupId && prefs.groups.some((group) => group.id === groupId)) {
        const list = byGroup.get(groupId) ?? [];
        list.push(key);
        byGroup.set(groupId, list);
        continue;
      }
      const sourceName = (channel.sourceGroup ?? '').trim() || '未分组';
      const list = bySource.get(sourceName) ?? [];
      list.push(key);
      bySource.set(sourceName, list);
    }
    const scopes = [{ key: 'all', title: '全部', channelKeys: all }];
    for (const group of prefs.groups) {
      scopes.push({
        key: `g:${group.id}`,
        title: group.name,
        channelKeys: byGroup.get(group.id) ?? [],
      });
    }
    for (const [name, keys] of bySource) {
      scopes.push({ key: `s:${name}`, title: name, channelKeys: keys });
    }
    return scopes;
  },

  /** 分组名归一化（源分组名去空白比较用） */
  normalizeGroupName(name: string): string {
    return normalizeChannelName(name);
  },
};

export type ChannelPrefsService = typeof channelPrefsService;
