import { beforeEach, describe, expect, it, vi } from 'vitest';

import { liveRepo } from '@/db/repositories/liveRepo';
import { replayService } from '@/services/replayService';
import { CATCHUP_PROBE_TTL_MS } from '@/shared/constants';
import type { LiveRecord } from '@/types';

import { resetAll } from './helpers';

/**
 * EXT-06 / FR-68：回看服务（AC-161 / AC-162）
 * - 窗口判定：节目已结束且在 `days` 天内；
 * - 模板取「频道级 catchup-source」优先，其次直播源设置；
 * - 探测 HEAD → Range GET，结果缓存 6h（期间不再发请求）；
 * - 失败文案区分 403 鉴权 / 404 不存在 / 不可达。
 */

const { requestWithMetaMock } = vi.hoisted(() => ({
  requestWithMetaMock: vi.fn(async (_url: string, _options?: unknown) => ({ status: 200 })),
}));

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: {
    request: vi.fn(),
    requestWithMeta: requestWithMetaMock,
    requestBase: vi.fn(),
  },
}));

const CHANNEL = {
  name: 'CCTV-1 综合',
  tvgId: 'cctv1',
  url: 'https://cdn.example.com/live/cctv1.m3u8',
};

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

describe('replayService.withinWindow（窗口判定，不发网络）', () => {
  it('已结束且在窗口内 → true；未结束 → false；超窗 → false', () => {
    const now = Date.now();
    const day = 86_400_000;
    const hour = 3_600_000;
    // 20 小时前开始、19 小时前结束：1 天窗口内
    expect(replayService.withinWindow(now - 20 * hour, now - 19 * hour, 1, now)).toBe(true);
    // 未结束（endAt 在未来）
    expect(replayService.withinWindow(now - 2 * hour, now + hour, 1, now)).toBe(false);
    // 起点超出 1 天窗口
    expect(replayService.withinWindow(now - 2 * day, now - 25 * hour, 1, now)).toBe(false);
    // 同一条节目在 7 天窗口内
    expect(replayService.withinWindow(now - 2 * day, now - 25 * hour, 7, now)).toBe(true);
  });

  it('天数非法回落 1 天（Q-17）', () => {
    const now = Date.now();
    const hour = 3_600_000;
    expect(replayService.withinWindow(now - 10 * hour, now - 9 * hour, 0, now)).toBe(true);
    expect(
      replayService.withinWindow(now - 30 * hour, now - 29 * hour, Number.NaN, now),
    ).toBe(false);
  });
});

describe('replayService.plan（模板来源与开关）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('未配置模板 → 不支持回看（不展示入口）', async () => {
    await liveRepo.save(liveRecord());
    const plan = await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL });
    expect(plan).toMatchObject({ supported: false, template: null, days: 1 });
  });

  it('源级模板生效；频道级 catchup-source 优先', async () => {
    await liveRepo.save(
      liveRecord({
        catchup: { enabled: true, template: 'https://a.example.com/{channelId}/{date}', days: 3 },
      }),
    );
    const fromSource = await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL });
    expect(fromSource).toMatchObject({
      supported: true,
      templateSource: 'source',
      days: 3,
    });

    const fromChannel = await replayService.plan({
      liveSourceId: 'live-a',
      channel: CHANNEL,
      extrasTemplate: 'https://b.example.com/{dateDash}/{start}',
      extrasDays: 5,
    });
    expect(fromChannel).toMatchObject({ templateSource: 'channel', days: 5 });
    expect(fromChannel.template).toContain('b.example.com');
  });

  it('源级回看开关关闭时即使有模板也不支持', async () => {
    await liveRepo.save(
      liveRecord({ catchup: { enabled: false, template: 'https://a.example.com/{date}', days: 1 } }),
    );
    const plan = await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL });
    expect(plan.supported).toBe(false);
  });

  it('直播源不存在时返回不支持（不抛错）', async () => {
    const plan = await replayService.plan({ liveSourceId: 'live_missing', channel: CHANNEL });
    expect(plan.supported).toBe(false);
  });

  it('REV-07：天数取源级与频道级的较大值（不是频道级覆盖源级）', async () => {
    await liveRepo.save(
      liveRecord({
        catchup: { enabled: true, template: 'https://a.example.com/{date}', days: 5 },
      }),
    );
    // 频道声明 2 天 < 源级 5 天 → 5（旧实现返回 2，窗口被错误收窄）
    expect(
      (await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL, extrasDays: 2 })).days,
    ).toBe(5);
    // 频道声明 6 天 > 源级 5 天 → 6
    expect(
      (await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL, extrasDays: 6 })).days,
    ).toBe(6);
    // 上限 7 天
    expect(
      (await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL, extrasDays: 99 })).days,
    ).toBe(7);
    // 源级 3 天 + 频道未声明 → 3
    await liveRepo.save(
      liveRecord({ catchup: { enabled: true, template: 'https://a.example.com/{date}', days: 3 } }),
    );
    expect((await replayService.plan({ liveSourceId: 'live-a', channel: CHANNEL })).days).toBe(3);
  });
});

describe('replayService.resolve（渲染编排）', () => {
  beforeEach(async () => {
    await resetAll();
    await liveRepo.save(
      liveRecord({ catchup: { enabled: true, template: 'https://cdn.example.com/{channelId}/{date}', days: 1 } }),
    );
  });

  it('窗口内渲染成功，返回地址与 token', async () => {
    const now = Date.now();
    const result = await replayService.resolve({
      liveSourceId: 'live-a',
      channel: CHANNEL,
      programme: { startAt: now - 90 * 60_000, endAt: now - 60 * 60_000 },
    });
    expect(result.url).toMatch(/^https:\/\/cdn\.example\.com\/cctv1\/\d{8}$/);
    expect(result.withinWindow).toBe(true);
    expect(result.tokens.channelId).toBe('cctv1');
  });

  it('超出窗口 / 已结束但太旧 → E_INVALID_STATE', async () => {
    const now = Date.now();
    await expect(
      replayService.resolve({
        liveSourceId: 'live-a',
        channel: CHANNEL,
        programme: { startAt: now - 5 * 86_400_000, endAt: now - 4 * 86_400_000 },
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' });
  });

  it('未配置模板 → E_NOT_IMPLEMENTED', async () => {
    await liveRepo.save(liveRecord({ id: 'live-b' }));
    const now = Date.now();
    await expect(
      replayService.resolve({
        liveSourceId: 'live-b',
        channel: CHANNEL,
        programme: { startAt: now - 60 * 60_000, endAt: now - 30 * 60_000 },
      }),
    ).rejects.toMatchObject({ code: 'E_NOT_IMPLEMENTED' });
  });

  it('REV-07：源级 5 天 + 频道级 2 天 → 4 天前的节目仍可回看', async () => {
    await liveRepo.save(
      liveRecord({
        catchup: { enabled: true, template: 'https://cdn.example.com/{channelId}/{date}', days: 5 },
      }),
    );
    const now = Date.now();
    const startAt = now - 4 * 86_400_000;
    const endAt = startAt + 3_600_000;
    const result = await replayService.resolve({
      liveSourceId: 'live-a',
      channel: CHANNEL,
      programme: { startAt, endAt },
      overrideDays: 2,
    });
    expect(result).toMatchObject({ days: 5, withinWindow: true });
  });
});

describe('replayService.capabilityOf（探测 + 6h 缓存，AC-162）', () => {
  beforeEach(async () => {
    await resetAll();
    requestWithMetaMock.mockReset();
  });

  it('2xx/3xx → available', async () => {
    requestWithMetaMock.mockResolvedValue({ status: 302 });
    const cap = await replayService.capabilityOf({
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    });
    expect(cap.state).toBe('available');
    expect(requestWithMetaMock).toHaveBeenCalledTimes(1);
  });

  it('403 → auth_required，且文案提示补齐鉴权地址', async () => {
    requestWithMetaMock.mockResolvedValue({ status: 403 });
    const cap = await replayService.capabilityOf({
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    });
    expect(cap.state).toBe('auth_required');
    expect(replayService.describeFailure(cap)).toContain('可能需要鉴权');
  });

  it('404 → not_found，文案为「该源可能不支持回看」', async () => {
    requestWithMetaMock.mockResolvedValue({ status: 404 });
    const cap = await replayService.capabilityOf({
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    });
    expect(cap.state).toBe('not_found');
    expect(replayService.describeFailure(cap)).toContain('不支持回看');
  });

  it('HEAD 失败时改用 Range GET；两次都失败 → unreachable', async () => {
    requestWithMetaMock.mockRejectedValueOnce(new Error('head timeout'));
    requestWithMetaMock.mockResolvedValueOnce({ status: 500 });
    const cap = await replayService.capabilityOf({
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    });
    expect(cap.state).toBe('unreachable');
    expect(requestWithMetaMock).toHaveBeenCalledTimes(2);
  });

  it('结果缓存 6h：期间再次调用不再发请求；force 可穿透', async () => {
    requestWithMetaMock.mockResolvedValue({ status: 200 });
    const input = {
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    };
    await replayService.capabilityOf(input);
    expect(CATCHUP_PROBE_TTL_MS).toBe(6 * 60 * 60 * 1000);
    await replayService.capabilityOf(input);
    expect(requestWithMetaMock).toHaveBeenCalledTimes(1);

    await replayService.capabilityOf({ ...input, force: true });
    expect(requestWithMetaMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateCapability 后重新探测', async () => {
    requestWithMetaMock.mockResolvedValue({ status: 200 });
    const input = {
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    };
    await replayService.capabilityOf(input);
    await replayService.invalidateCapability('live-a', 'id:cctv1');
    await replayService.capabilityOf(input);
    expect(requestWithMetaMock).toHaveBeenCalledTimes(2);
  });

  it('同 key 并发探测共享同一请求（并发闸门 ≤2）', async () => {
    requestWithMetaMock.mockResolvedValue({ status: 200 });
    const input = {
      liveSourceId: 'live-a',
      channelKey: 'id:cctv1',
      url: 'https://cdn.example.com/live/cctv1.m3u8',
    };
    const [a, b] = await Promise.all([
      replayService.capabilityOf(input),
      replayService.capabilityOf(input),
    ]);
    expect(a.state).toBe('available');
    expect(b.state).toBe('available');
    expect(requestWithMetaMock).toHaveBeenCalledTimes(1);
  });
});
