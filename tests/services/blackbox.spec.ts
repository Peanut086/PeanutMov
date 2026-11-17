/**
 * 播放黑匣子单测（BB-01）
 *
 * 覆盖：周期写节流与 force 补写、隐私开关双保险（写不进、读会清）、
 * mediaId 隔离、TTL、存储脏数据的形状校验。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import {
  __resetBlackbox,
  BLACKBOX_TTL_MS,
  clearBlackbox,
  notePlayback,
  peekBlackbox,
  type BlackboxSnapshot,
} from '@/services/blackboxService';
import { settingsService } from '@/services/settingsService';
import { KV_KEY_PLAYBACK_BLACKBOX } from '@/shared/constants';

import { readKv, resetAll } from '../unit/helpers';

function snap(overrides: Partial<Omit<BlackboxSnapshot, 'at'>> = {}): Omit<BlackboxSnapshot, 'at'> {
  return {
    mediaId: 'm1',
    episodeNumber: 5,
    lineId: 'L2',
    positionSec: 120,
    durationSec: 600,
    rate: 1.5,
    ...overrides,
  };
}

describe('blackboxService', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    __resetBlackbox();
  });

  it('30 秒内周期写被节流，越过后再次落盘', async () => {
    const t0 = Date.now();
    expect(await notePlayback(snap(), { now: t0 })).toBe(true);
    expect(await notePlayback(snap({ positionSec: 200 }), { now: t0 + 10_000 })).toBe(false);
    expect(await notePlayback(snap({ positionSec: 200 }), { now: t0 + 31_000 })).toBe(true);
    const stored = await readKv<Omit<BlackboxSnapshot, 'at'>>(KV_KEY_PLAYBACK_BLACKBOX);
    expect(stored!.positionSec).toBe(200);
  });

  it('force 写绕过节流（卸载补写用的就是它）', async () => {
    const t0 = Date.now() - 60_000;
    await notePlayback(snap(), { now: t0 });
    expect(await notePlayback(snap({ positionSec: 590 }), { now: t0 + 1_000, force: true })).toBe(true);
    expect(await peekBlackbox('m1')).toMatchObject({ positionSec: 590, rate: 1.5 });
  });

  it('隐私开关打开：写被拒，读还会顺带清掉旧快照', async () => {
    await notePlayback(snap(), { now: Date.now() });
    expect(await peekBlackbox('m1')).not.toBeNull();

    await settingsService.update({ pauseHistoryRecording: true });
    expect(await notePlayback(snap(), { now: Date.now() + 60_000, force: true })).toBe(false);
    expect(await peekBlackbox('m1')).toBeNull();
    expect(await readKv(KV_KEY_PLAYBACK_BLACKBOX)).toBeNull();
  });

  it('只认自己的媒体：另一个 mediaId 读不到', async () => {
    await notePlayback(snap(), { now: Date.now() });
    expect(await peekBlackbox('m2')).toBeNull();
    expect(await peekBlackbox('m1')).toMatchObject({ episodeNumber: 5 });
  });

  it('TTL 过期按没有快照处理', async () => {
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap(), at: Date.now() - BLACKBOX_TTL_MS - 60_000 });
    expect(await peekBlackbox('m1')).toBeNull();
  });

  it('存储脏数据逐项降级：坏字段作废或回默认，坏骨架整体作废', async () => {
    // 位置超过时长+容差 → 整体不可信
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap({ positionSec: 700, durationSec: 600 }), at: Date.now() });
    expect(await peekBlackbox('m1')).toBeNull();
    // 时长缺失 → 无法算比例，按没有快照
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap({ durationSec: 0 }), at: Date.now() });
    expect(await peekBlackbox('m1')).toBeNull();
    // 倍速不在档位表 → 回落 1，其余字段照常可用
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap({ rate: 9 as never }), at: Date.now() });
    expect(await peekBlackbox('m1')).toMatchObject({ rate: 1, positionSec: 120 });
    // 集号非正整数 → 降级为 null（位置仍按 mediaId 恢复）
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap({ episodeNumber: 2.5 }), at: Date.now() });
    expect(await peekBlackbox('m1')).toMatchObject({ episodeNumber: null });
    // 未来时间戳 → 不可信
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, { ...snap(), at: Date.now() + 60 * 60 * 1000 });
    expect(await peekBlackbox('m1')).toBeNull();
    // 连形状都不是
    await kvRepo.set(KV_KEY_PLAYBACK_BLACKBOX, 'oops');
    expect(await peekBlackbox('m1')).toBeNull();
  });

  it('clearBlackbox 抹掉存储并重置节流', async () => {
    await notePlayback(snap(), { now: Date.now() });
    await clearBlackbox();
    expect(await readKv(KV_KEY_PLAYBACK_BLACKBOX)).toBeNull();
    // 节流已重置：紧接着的周期写应当成功
    expect(await notePlayback(snap(), { now: Date.now() })).toBe(true);
  });
});
