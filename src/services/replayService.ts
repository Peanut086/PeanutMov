/**
 * 回看（EXT-06 / FR-68，API-23）
 *
 * - 地址 = 声明式模板 + 12 token（`shared/catchupTemplate`），无表达式求值；
 * - 能力探测：`HEAD`（3s）→ 失败再 `GET` + `Range: bytes=0-1023`；结果进 kv，6h TTL；
 * - 探测请求优先走 LocalProxy（CapacitorHttp 拒 3xx），失败回退直连；
 * - 不跨源回退：模板只取「频道级 catchup-source」或「该直播源级设置」；
 * - 302 落地地址只用于判定状态，不返回给 UI。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { liveRepo } from '@/db/repositories/liveRepo';
import { httpClient } from '@/sources/base/httpClient';
import { LocalProxy } from '@/native/localProxy';
import { clampCatchupDays, renderCatchupUrl } from '@/shared/catchupTemplate';
import {
  CATCHUP_PROBE_TIMEOUT_MS,
  CATCHUP_PROBE_TTL_MS,
  KV_KEY_CATCHUP_PROBES,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import type { CatchupCapability, CatchupProbeState } from '@/types';

export { renderCatchupUrl } from '@/shared/catchupTemplate';

interface ProbeCacheEntry {
  state: CatchupProbeState;
  checkedAt: number;
  status: number | null;
  reason: string | null;
  days: number;
}

type ProbeCache = Record<string, ProbeCacheEntry>;

/** 探测并发闸门（≤2） */
const CATCHUP_PROBE_CONCURRENCY = 2;
let activeProbes = 0;
const probeQueue: Array<() => void> = [];

async function acquireProbeSlot(): Promise<void> {
  if (activeProbes < CATCHUP_PROBE_CONCURRENCY) {
    activeProbes += 1;
    return;
  }
  await new Promise<void>((resolve) => probeQueue.push(resolve));
  activeProbes += 1;
}

function releaseProbeSlot(): void {
  activeProbes = Math.max(0, activeProbes - 1);
  const next = probeQueue.shift();
  if (next) next();
}

/** 同 key 并发探测共享同一 Promise */
const probeInFlight = new Map<string, Promise<CatchupCapability>>();

function mapStatus(status: number | null, reason: string | null): {
  state: CatchupProbeState;
  status: number | null;
  reason: string | null;
} {
  if (status === null) return { state: 'unreachable', status: null, reason };
  if (status >= 200 && status < 300) return { state: 'available', status, reason: null };
  if (status >= 300 && status < 400) return { state: 'available', status, reason: null };
  if (status === 401 || status === 403) {
    return { state: 'auth_required', status, reason: '可能需要鉴权，请在模板中补齐地址' };
  }
  if (status === 404 || status === 410) return { state: 'not_found', status, reason: '地址不存在' };
  return { state: 'unreachable', status, reason: `HTTP ${status}` };
}

/** 原生环境优先经 LocalProxy 转发（CapacitorHttp 拒 3xx） */
async function targetOf(url: string): Promise<string> {
  if (!isNative()) return url;
  try {
    const result = await LocalProxy.proxy({ url });
    return result.url || url;
  } catch (error) {
    logger.debug('回看探测代理不可用，回退直连', error);
    return url;
  }
}

async function probeOnce(url: string): Promise<{
  state: CatchupProbeState;
  status: number | null;
  reason: string | null;
}> {
  const target = await targetOf(url);
  try {
    const head = await httpClient.requestWithMeta(target, {
      method: 'HEAD',
      responseType: 'none',
      timeoutMs: CATCHUP_PROBE_TIMEOUT_MS,
      retries: 0,
      throwOnHttpError: false,
    });
    const mapped = mapStatus(head.status, null);
    if (mapped.state === 'available' || mapped.state === 'auth_required' || mapped.state === 'not_found') {
      return mapped;
    }
  } catch (error) {
    logger.debug('回看 HEAD 探测失败，改用 Range GET', error);
  }

  try {
    const ranged = await httpClient.requestWithMeta(target, {
      method: 'GET',
      responseType: 'none',
      timeoutMs: CATCHUP_PROBE_TIMEOUT_MS,
      retries: 0,
      throwOnHttpError: false,
      headers: { Range: 'bytes=0-1023' },
    });
    return mapStatus(ranged.status, null);
  } catch (error) {
    const appError = toAppError(error);
    return { state: 'unreachable', status: appError.httpStatus ?? null, reason: appError.message };
  }
}

async function readProbeCache(): Promise<ProbeCache> {
  try {
    return (await kvRepo.get<ProbeCache>(KV_KEY_CATCHUP_PROBES)) ?? {};
  } catch (error) {
    logger.debug('读取回看探测缓存失败', error);
    return {};
  }
}

async function writeProbeCache(key: string, entry: ProbeCacheEntry): Promise<void> {
  try {
    const cache = await readProbeCache();
    const now = Date.now();
    // 顺带清理过期项，避免 kv 无限增长
    const next: ProbeCache = {};
    for (const [entryKey, value] of Object.entries(cache)) {
      if (now - value.checkedAt <= CATCHUP_PROBE_TTL_MS) next[entryKey] = value;
    }
    next[key] = entry;
    await kvRepo.set(KV_KEY_CATCHUP_PROBES, next);
  } catch (error) {
    logger.debug('写入回看探测缓存失败', error);
  }
}

export interface CatchupPlan {
  supported: boolean;
  template: string | null;
  templateSource: 'channel' | 'source';
  days: number;
}

export interface CatchupResolveResult {
  url: string;
  template: string;
  templateSource: 'channel' | 'source';
  days: number;
  withinWindow: boolean;
  tokens: Record<string, string>;
}

export const replayService = {
  /** 回看窗口判定（纯函数，不发网络）：节目已结束且在 days 天内 */
  withinWindow(startAt: number, endAt: number, days: number, now: number = Date.now()): boolean {
    const limit = clampCatchupDays(days) * 86_400_000;
    return now >= endAt && now - startAt <= limit;
  },

  /**
   * 回看可用性「模板侧」判定（不发网络）：
   * 频道级 `catchup-source` 优先，其次直播源设置；未配置 / 已关闭 → supported=false。
   */
  async plan(input: {
    liveSourceId: string;
    channel: { name: string; tvgId: string | null; url: string };
    extrasTemplate?: string | null;
    extrasDays?: number | null;
  }): Promise<CatchupPlan> {
    const record = await liveRepo.get(input.liveSourceId).catch(() => null);
    const catchup = record?.catchup ?? null;
    const channelTemplate = (input.extrasTemplate ?? '').trim();
    const sourceTemplate = (catchup?.template ?? '').trim();
    const template = channelTemplate || sourceTemplate;
    const templateSource: 'channel' | 'source' = channelTemplate ? 'channel' : 'source';
    const enabled = catchup?.enabled !== false;
    // FR-68：回看天数取「源级设置」与「频道级 catchup-days」中较大者（上限 7 天），
    // 而不是频道级简单覆盖源级——否则源声明 5 天、频道声明 2 天时窗口会被错误收窄（REV-07）。
    const days = Math.max(
      clampCatchupDays(input.extrasDays ?? 1),
      clampCatchupDays(catchup?.days ?? 1),
    );
    return {
      supported: Boolean(template) && enabled,
      template: template || null,
      templateSource,
      days,
    };
  },

  /** 渲染回看地址（模板存在性与窗口校验后调用） */
  async resolve(input: {
    liveSourceId: string;
    channel: { name: string; tvgId: string | null; url: string };
    programme: { startAt: number; endAt: number };
    overrideTemplate?: string | null;
    overrideDays?: number | null;
  }): Promise<CatchupResolveResult> {
    const plan = await replayService.plan({
      liveSourceId: input.liveSourceId,
      channel: input.channel,
      extrasTemplate: input.overrideTemplate ?? null,
      extrasDays: input.overrideDays ?? null,
    });
    if (!plan.supported || !plan.template) {
      throw new AppError('E_NOT_IMPLEMENTED', '该源不支持回看（未配置回看模板）');
    }
    if (!replayService.withinWindow(input.programme.startAt, input.programme.endAt, plan.days)) {
      throw new AppError('E_INVALID_STATE', '超出回看窗口，无法回看该节目');
    }
    const rendered = renderCatchupUrl(plan.template, {
      channel: input.channel,
      programme: input.programme,
    });
    return {
      url: rendered.url,
      template: plan.template,
      templateSource: plan.templateSource,
      days: plan.days,
      withinWindow: true,
      tokens: rendered.tokens,
    };
  },

  /** 读取探测缓存（6h TTL）；`force` 时跳过缓存 */
  async capabilityOf(input: {
    liveSourceId: string;
    channelKey: string;
    url: string;
    days?: number;
    force?: boolean;
  }): Promise<CatchupCapability> {
    const key = `${input.liveSourceId}:${input.channelKey}`;
    const days = clampCatchupDays(input.days ?? 1);
    if (!input.force) {
      const cache = await readProbeCache();
      const cached = cache[key];
      if (cached && Date.now() - cached.checkedAt <= CATCHUP_PROBE_TTL_MS) {
        return { key, ...cached, days: cached.days ?? days };
      }
      const running = probeInFlight.get(key);
      if (running) return running;
    }

    const task = (async (): Promise<CatchupCapability> => {
      await acquireProbeSlot();
      let result: { state: CatchupProbeState; status: number | null; reason: string | null };
      try {
        result = await probeOnce(input.url);
      } finally {
        releaseProbeSlot();
      }
      const entry: ProbeCacheEntry = {
        state: result.state,
        checkedAt: Date.now(),
        status: result.status,
        reason: result.reason,
        days,
      };
      await writeProbeCache(key, entry);
      return { key, ...entry };
    })();

    probeInFlight.set(key, task);
    task.finally(() => probeInFlight.delete(key)).catch(() => undefined);
    return task;
  },

  /** 主动失效某频道探测结果（模板变更后调用） */
  async invalidateCapability(liveSourceId: string, channelKey: string): Promise<void> {
    const key = `${liveSourceId}:${channelKey}`;
    try {
      const cache = await readProbeCache();
      if (!(key in cache)) return;
      const next: ProbeCache = { ...cache };
      delete next[key];
      await kvRepo.set(KV_KEY_CATCHUP_PROBES, next);
    } catch (error) {
      logger.debug('失效回看探测缓存失败', error);
    }
  },

  /**
   * 失效某个直播源下全部频道的探测结果（P1-01：源级回看设置变更后调用）。
   * 模板/天数变了，旧探测结论不再可信，必须让节目单重新探测。
   */
  async invalidateSourceCapabilities(liveSourceId: string): Promise<void> {
    if (!liveSourceId) return;
    const prefix = `${liveSourceId}:`;
    try {
      const cache = await readProbeCache();
      const next: ProbeCache = {};
      let changed = false;
      for (const [key, value] of Object.entries(cache)) {
        if (key.startsWith(prefix)) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      if (!changed) return;
      await kvRepo.set(KV_KEY_CATCHUP_PROBES, next);
    } catch (error) {
      logger.debug('失效回看探测缓存失败', error);
    }
  },

  /** 探测失败原因文案（AC-162：403 额外提示鉴权） */
  describeFailure(capability: CatchupCapability): string {
    if (capability.state === 'auth_required') {
      return '可能需要鉴权，请在模板中补齐地址';
    }
    if (capability.state === 'not_found') return '该源可能不支持回看（地址不存在）';
    if (capability.state === 'unreachable') return '该源可能不支持回看（地址不可达）';
    return '该源可能不支持回看';
  },
};

export type ReplayService = typeof replayService;
