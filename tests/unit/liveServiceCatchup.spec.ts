/**
 * EXT-06 / FR-68（P1-01）：直播源级回看设置的写入通路
 *
 * - 合法模板落库到 `LiveRecord.catchup`，天数收敛到 1~7；
 * - 未知占位符 → `E_INVALID_INPUT`，错误文案带非法占位符与合法清单（AC-163 ④）；
 * - 变更后清该源的 `live-catchup-probes` 探测缓存，其它源不受影响；
 * - `null` 清除设置；记录不存在 → `E_NOT_FOUND`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { liveRepo } from '@/db/repositories/liveRepo';
import { liveService, resetLiveCacheForTest } from '@/services/liveService';
import { replayService } from '@/services/replayService';
import { CATCHUP_MAX_DAYS, KV_KEY_CATCHUP_PROBES } from '@/shared/constants';
import type { LiveCatchupSettings, LiveRecord } from '@/types';

import { resetAll } from './helpers';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: {
    request: vi.fn(),
    requestWithMeta: vi.fn(async () => ({ status: 200 })),
    requestBase: vi.fn(),
  },
}));

const TEMPLATE = 'https://cdn.example.com/{channelId}/{dateDash}/{start}-{end}.m3u8';

function liveRecord(over: Partial<LiveRecord> = {}): LiveRecord {
  const now = Date.now();
  return {
    id: 'live-a',
    name: '我的直播源',
    url: 'https://cdn.example.com/live.m3u8',
    format: 'm3u',
    channelCount: 10,
    subscriptionId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const CHANNEL = {
  name: 'CCTV-1 综合',
  tvgId: 'cctv1',
  url: 'https://cdn.example.com/live/cctv1.m3u8',
};

function probeEntry(checkedAt: number) {
  return { state: 'available' as const, checkedAt, status: 200, reason: null, days: 1 };
}

describe('liveService.updateCatchup（P1-01：源级回看设置写入）', () => {
  beforeEach(async () => {
    await resetAll();
    resetLiveCacheForTest();
  });

  it('保存合法模板 → 落库 catchup，且 days 收敛到 1~CATCHUP_MAX_DAYS', async () => {
    await liveRepo.save(liveRecord());

    const saved = await liveService.updateCatchup('live-a', {
      enabled: true,
      template: TEMPLATE,
      days: 99,
    });

    const stored = await liveRepo.get('live-a');
    expect(stored?.catchup).toEqual({ enabled: true, template: TEMPLATE, days: CATCHUP_MAX_DAYS });
    expect(saved.updatedAt).toBeGreaterThan(0);

    // 天数 <1 / NaN 回落 1 天
    await liveService.updateCatchup('live-a', { enabled: true, template: TEMPLATE, days: 0 });
    expect((await liveRepo.get('live-a'))?.catchup?.days).toBe(1);
    await liveService.updateCatchup('live-a', {
      enabled: true,
      template: TEMPLATE,
      days: Number.NaN,
    });
    expect((await liveRepo.get('live-a'))?.catchup?.days).toBe(1);
  });

  it('保存后回看 plan 立即生效（模板来源 = 源级）', async () => {
    await liveRepo.save(liveRecord());
    await liveService.updateCatchup('live-a', { enabled: true, template: TEMPLATE, days: 3 });

    const plan = await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL });
    expect(plan.supported).toBe(true);
    expect(plan.template).toBe(TEMPLATE);
    expect(plan.templateSource).toBe('source');
    expect(plan.days).toBe(3);
  });

  it('停用后 plan 不支持回看（enabled=false 仍保留模板）', async () => {
    await liveRepo.save(liveRecord());
    await liveService.updateCatchup('live-a', { enabled: false, template: TEMPLATE, days: 2 });

    const stored = await liveRepo.get('live-a');
    expect(stored?.catchup).toEqual({ enabled: false, template: TEMPLATE, days: 2 });
    const plan = await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL });
    expect(plan.supported).toBe(false);
  });

  it('未知占位符被拒绝，错误文案含非法占位符与合法清单，且不落库', async () => {
    await liveRepo.save(liveRecord());

    await expect(
      liveService.updateCatchup('live-a', {
        enabled: true,
        template: 'https://cdn.example.com/{base}/{foo}/{startSec}',
        days: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT', message: expect.stringContaining('{foo}') });

    let error: (Error & { code?: string }) | null = null;
    try {
      await liveService.updateCatchup('live-a', {
        enabled: true,
        template: 'https://x.com/{foo}',
        days: 1,
      });
    } catch (e) {
      error = e as Error & { code?: string };
    }
    expect(error?.code).toBe('E_INVALID_INPUT');
    expect(error?.message).toContain('{base}');
    expect(error?.message).toContain('{durationSec}');

    expect((await liveRepo.get('live-a'))?.catchup).toBeUndefined();
  });

  it('空模板 / 非 http(s) 模板被拒绝', async () => {
    await liveRepo.save(liveRecord());

    await expect(
      liveService.updateCatchup('live-a', { enabled: true, template: '   ', days: 1 }),
    ).rejects.toMatchObject({ message: '回看模板不能为空' });
    await expect(
      liveService.updateCatchup('live-a', { enabled: true, template: 'rtmp://x.com/{date}', days: 1 }),
    ).rejects.toMatchObject({ message: expect.stringContaining('http(s)') });
  });

  it('清除设置后 catchup 字段消失，plan 回落为不支持', async () => {
    const withCatchup = liveRecord({
      catchup: { enabled: true, template: TEMPLATE, days: 2 } as LiveCatchupSettings,
    });
    await liveRepo.save(withCatchup);

    await liveService.updateCatchup('live-a', null);

    expect((await liveRepo.get('live-a'))?.catchup).toBeUndefined();
    const plan = await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL });
    expect(plan.supported).toBe(false);
    expect(plan.template).toBeNull();
  });

  it('记录不存在 → E_NOT_FOUND', async () => {
    await expect(
      liveService.updateCatchup('missing', { enabled: true, template: TEMPLATE, days: 1 }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('replayService.invalidateSourceCapabilities（P1-01：模板变更后清探测缓存）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('只清目标源前缀的探测键，其它源保留', async () => {
    const now = Date.now();
    await kvRepo.set(KV_KEY_CATCHUP_PROBES, {
      'live-a:cctv1': probeEntry(now),
      'live-a:cctv2': probeEntry(now),
      'live-b:cctv1': probeEntry(now),
    });

    await replayService.invalidateSourceCapabilities('live-a');

    const cache = (await kvRepo.get<Record<string, unknown>>(KV_KEY_CATCHUP_PROBES)) ?? {};
    expect(Object.keys(cache)).toEqual(['live-b:cctv1']);
  });

  it('无匹配键时不改动缓存（不写空对象）', async () => {
    const now = Date.now();
    await kvRepo.set(KV_KEY_CATCHUP_PROBES, { 'live-b:cctv1': probeEntry(now) });

    await replayService.invalidateSourceCapabilities('live-a');

    const cache = (await kvRepo.get<Record<string, unknown>>(KV_KEY_CATCHUP_PROBES)) ?? {};
    expect(Object.keys(cache)).toEqual(['live-b:cctv1']);
  });
});
