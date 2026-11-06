/**
 * EPG 源管理（EXT-06 / FR-66，API-20 §3.1.1 ~ §3.1.4）
 *
 * 职责：源 CRUD、优先级整表重排、启停、探测（8s 单请求）。
 * 约束：
 * - 内置源（`epg-builtin`）不可删除；
 * - 用户源 ≤ `EPG_SOURCE_MAX`、启用 ≤ `EPG_SOURCE_ENABLED_MAX`（可被 `AppSettings.epg` 覆盖）；
 * - 探测失败不落库、不占优先级；
 * - 删除源 / 改协议 / 改匹配模式 → 清该源 EPG 缓存。
 */
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { epgService, parseEpgResponse } from '@/services/epgService';
import { settingsService } from '@/services/settingsService';
import { httpClient } from '@/sources/base/httpClient';
import {
  BUILTIN_EPG_SOURCE_ID,
  EPG_PROBE_TIMEOUT_MS,
  EPG_SOURCE_ENABLED_MAX,
  EPG_SOURCE_MAX,
} from '@/shared/constants';
import { localDateKey } from '@/shared/epgTime';
import { AppError, toAppError } from '@/shared/errors';
import { newId } from '@/shared/id';
import { logger } from '@/shared/logger';
import type { EpgMatchMode, EpgProtocol, EpgSource, EpgSourceInput, EpgSourceLimits } from '@/types';

/** 名称/地址校验结果（trim 后） */
function validateName(raw: string): string {
  const name = (raw ?? '').trim();
  if (name.length === 0) throw new AppError('E_INVALID_INPUT', '请填写 EPG 源名称');
  if (name.length > 20) throw new AppError('E_INVALID_INPUT', 'EPG 源名称不能超过 20 个字符');
  return name;
}

function validateEndpoint(raw: string): string {
  const endpoint = (raw ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(endpoint)) {
    throw new AppError('E_INVALID_INPUT', 'EPG 地址必须以 http(s):// 开头');
  }
  try {
    // 结构校验（域名/端口/路径），失败直接判非法
    void new URL(endpoint);
  } catch {
    throw new AppError('E_INVALID_INPUT', 'EPG 地址格式不正确');
  }
  return endpoint;
}

/** diyp 端点参数方言：`ch` + `date`（+ `xmltv_id`），与既有 `programmes()` 一致 */
function probeUrlOf(
  endpoint: string,
  protocol: EpgProtocol,
  sampleName: string,
  tvgId: string | null,
): string {
  if (protocol === 'xmltv') return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set('ch', sampleName);
  url.searchParams.set('date', localDateKey(new Date()));
  if (tvgId) url.searchParams.set('xmltv_id', tvgId);
  return url.toString();
}

function countXmltvChannels(text: string): number {
  const match = text.match(/<channel\b/gi);
  return match ? match.length : 0;
}

export interface EpgProbeResult {
  ok: boolean;
  /** 声明协议 */
  protocol: EpgProtocol;
  /** 实际识别到的协议 */
  detectedProtocol: 'diyp' | 'xmltv';
  programmeCount: number;
  channelCount: number;
  elapsedMs: number;
  sampleTitle: string | null;
  warning: string | null;
}

export const epgSourceService = {
  /** 全部源，按 priority 升序 */
  async list(): Promise<EpgSource[]> {
    return epgSourceRepo.list();
  },

  async get(id: string): Promise<EpgSource | null> {
    return epgSourceRepo.get(id);
  },

  /** 上限（可在设置中覆盖；缺省取常量；异常值回落常量，避免 0/负数冻结功能） */
  async limits(): Promise<EpgSourceLimits> {
    try {
      const settings = await settingsService.get();
      const configured = settings.epg;
      const positiveInt = (value: unknown, fallback: number): number => {
        const num = Number(value);
        return Number.isFinite(num) && num >= 1 ? Math.floor(num) : fallback;
      };
      return {
        maxSources: positiveInt(configured?.maxSources, EPG_SOURCE_MAX),
        maxEnabled: positiveInt(configured?.maxEnabled, EPG_SOURCE_ENABLED_MAX),
      };
    } catch (error) {
      logger.debug('读取 EPG 上限失败，使用默认值', error);
      return { maxSources: EPG_SOURCE_MAX, maxEnabled: EPG_SOURCE_ENABLED_MAX };
    }
  },

  /**
   * 探测（供「新增/测试连接」）：单请求 8s，解析出 ≥1 条节目才算成功。
   * 失败抛 `E_PARSE`/`E_TIMEOUT`/`E_NETWORK`/`E_NOT_FOUND`（不落库）。
   */
  async probe(input: {
    endpoint: string;
    protocol?: EpgProtocol;
    sampleChannel?: { name: string; tvgId?: string | null };
  }): Promise<EpgProbeResult> {
    const endpoint = validateEndpoint(input.endpoint);
    const protocol = input.protocol ?? 'auto';
    const sampleName = (input.sampleChannel?.name ?? 'CCTV1').trim() || 'CCTV1';
    const tvgId = input.sampleChannel?.tvgId ?? null;
    const startedAt = Date.now();

    let text: string;
    try {
      text = await httpClient.request<string>(probeUrlOf(endpoint, protocol, sampleName, tvgId), {
        responseType: 'text',
        timeoutMs: EPG_PROBE_TIMEOUT_MS,
        retries: 0,
        headers: { Accept: 'application/json, text/xml, */*' },
      });
    } catch (error) {
      throw toAppError(error);
    }

    const trimmed = (text ?? '').trim();
    if (!trimmed) throw new AppError('E_PARSE', '该地址没有可解析的节目单（响应为空）');
    const detectedProtocol: 'diyp' | 'xmltv' = trimmed.startsWith('<') ? 'xmltv' : 'diyp';
    const programmes = parseEpgResponse(trimmed);
    if (programmes.length === 0) {
      throw new AppError('E_PARSE', '该地址没有可解析的节目单（疑似返回了网页或空列表）');
    }
    const channelCount = detectedProtocol === 'xmltv' ? countXmltvChannels(trimmed) : 1;
    const warning =
      protocol !== 'auto' && protocol !== detectedProtocol
        ? `声明协议为 ${protocol}，实际响应更接近 ${detectedProtocol}`
        : null;
    return {
      ok: true,
      protocol,
      detectedProtocol,
      programmeCount: programmes.length,
      channelCount,
      elapsedMs: Date.now() - startedAt,
      sampleTitle: programmes[0]?.title ?? null,
      warning,
    };
  },

  /**
   * 新增源：校验 → 探测 → 落库（探测失败不落库、不占优先级）。
   * 上限校验全部在探测**之前**完成，避免无谓网络请求：
   * - 用户源数 ≥ `limits.maxSources` → 拒绝（AC-155「第 11 个用户源被拒绝」）；
   * - 启用源数 ≥ `limits.maxEnabled` → 拒绝（AC-155「第 6 个启用源被拒绝」，不静默降为停用）。
   */
  async add(input: EpgSourceInput): Promise<EpgSource> {
    const name = validateName(input.name);
    const endpoint = validateEndpoint(input.endpoint);
    const all = await epgSourceRepo.list();
    const limits = await epgSourceService.limits();

    const userCount = all.filter((source) => !source.builtin).length;
    if (userCount >= limits.maxSources) {
      throw new AppError('E_INVALID_STATE', `EPG 源已达上限（${limits.maxSources} 个）`);
    }
    if (all.some((source) => source.endpoint === endpoint)) {
      throw new AppError('E_INVALID_INPUT', '该 EPG 地址已存在');
    }
    const enabledCount = all.filter((source) => source.enabled).length;
    if (enabledCount >= limits.maxEnabled) {
      throw new AppError(
        'E_INVALID_STATE',
        `最多同时启用 ${limits.maxEnabled} 个 EPG 源，请先停用其他源`,
      );
    }

    const protocol: EpgProtocol = input.protocol ?? 'auto';
    const matchMode: EpgMatchMode = input.matchMode ?? 'auto';
    await epgSourceService.probe({ endpoint, protocol, sampleChannel: input.sampleChannel });

    const maxPriority = all.reduce((max, source) => Math.max(max, source.priority), 0);
    const now = Date.now();
    const record: EpgSource = {
      id: `epg_${newId()}`,
      name,
      endpoint,
      protocol,
      matchMode,
      priority: maxPriority + 1,
      enabled: true,
      builtin: false,
      lastProbeAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await epgSourceRepo.save(record);
    return record;
  },

  /** 更新：端点变更需重新探测成功才保存；协议/匹配模式变更清该源缓存 */
  async update(
    id: string,
    patch: Partial<Pick<EpgSource, 'name' | 'endpoint' | 'protocol' | 'matchMode' | 'enabled'>>,
  ): Promise<EpgSource> {
    const current = await epgSourceRepo.get(id);
    if (!current) throw new AppError('E_NOT_FOUND', 'EPG 源不存在');
    const next: EpgSource = { ...current };

    if (patch.name !== undefined) next.name = validateName(patch.name);

    if (patch.endpoint !== undefined) {
      const endpoint = validateEndpoint(patch.endpoint);
      if (endpoint !== current.endpoint) {
        const all = await epgSourceRepo.list();
        if (all.some((source) => source.id !== id && source.endpoint === endpoint)) {
          throw new AppError('E_INVALID_INPUT', '该 EPG 地址已存在');
        }
        const protocol = patch.protocol ?? current.protocol;
        await epgSourceService.probe({ endpoint, protocol });
        next.endpoint = endpoint;
        next.lastProbeAt = Date.now();
        next.lastError = null;
      }
    }

    if (patch.protocol !== undefined && patch.protocol !== current.protocol) {
      next.protocol = patch.protocol;
    }
    if (patch.matchMode !== undefined && patch.matchMode !== current.matchMode) {
      next.matchMode = patch.matchMode;
    }

    if (patch.enabled !== undefined && patch.enabled !== current.enabled && patch.enabled) {
      const limits = await epgSourceService.limits();
      const all = await epgSourceRepo.list();
      const enabledCount = all.filter((source) => source.enabled && source.id !== id).length;
      if (enabledCount >= limits.maxEnabled) {
        throw new AppError('E_INVALID_STATE', `最多同时启用 ${limits.maxEnabled} 个 EPG 源`);
      }
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;

    next.updatedAt = Date.now();
    await epgSourceRepo.save(next);

    const cacheInvalidated =
      next.protocol !== current.protocol || next.matchMode !== current.matchMode;
    if (cacheInvalidated) await epgService.clearSourceCache(id);
    return next;
  },

  /** 删除源（内置源不可删）；返回清理的缓存条数 */
  async remove(id: string): Promise<{ removed: boolean; clearedCacheKeys: number }> {
    const current = await epgSourceRepo.get(id);
    if (!current) throw new AppError('E_NOT_FOUND', 'EPG 源不存在');
    if (current.builtin) throw new AppError('E_INVALID_STATE', '内置默认源不可删除');
    await epgSourceRepo.remove(id);
    const clearedCacheKeys = await epgService.clearSourceCache(id);
    return { removed: true, clearedCacheKeys };
  },

  /** 整表重排优先级：ids 必须与现有 id 全集完全一致，按下标重写 priority = index + 1 */
  async reorder(ids: string[]): Promise<EpgSource[]> {
    const all = await epgSourceRepo.list();
    const currentIds = all.map((source) => source.id);
    const sameSet =
      ids.length === currentIds.length &&
      new Set(ids).size === ids.length &&
      ids.every((id) => currentIds.includes(id));
    if (!sameSet) throw new AppError('E_INVALID_INPUT', '优先级重排必须包含全部 EPG 源且不重复');

    const byId = new Map(all.map((source) => [source.id, source]));
    const now = Date.now();
    const next: EpgSource[] = ids.map((id, index) => {
      const source = byId.get(id)!;
      return { ...source, priority: index + 1, updatedAt: now };
    });
    await epgSourceRepo.saveMany(next);
    return next.sort((a, b) => a.priority - b.priority);
  },

  /** 记录探测失败原因（UI 展示"上次失败：…"），不改变 enabled */
  async markError(id: string, message: string | null): Promise<void> {
    const current = await epgSourceRepo.get(id);
    if (!current) return;
    await epgSourceRepo.save({ ...current, lastError: message, updatedAt: Date.now() });
  },

  /** 判断某个 id 是否为内置源（UI 禁删） */
  isBuiltin(id: string): boolean {
    return id === BUILTIN_EPG_SOURCE_ID;
  },
};

export type EpgSourceService = typeof epgSourceService;
