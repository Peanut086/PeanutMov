/**
 * 适配器基类（API-01）
 *
 * 提供：
 * - 统一的 `testConnection` 实现（按源类型分级的探活窗口、不抛错、错误进 `result.error`）；
 * - 源禁用检查（API-02 已在前置做，这里再兜一层，防止直接调用适配器）；
 * - 公共 header 拼装、媒体条目 ID 生成与基础字段填充。
 *
 * 子类需实现 `probe`（探活）与全部数据方法；`probe` 返回条目数时填入 `itemCount`。
 */
import { TIMEOUT_SEARCH_MS } from '@/shared/constants';
import { AppError, toErrorShape } from '@/shared/errors';
import { mediaIdOf } from '@/shared/id';
import { classifySourceFailure } from '@/shared/sourceFailure';
import { probeWindowMsFor } from '@/sources/probeWindow';
import type {
  BrowseParams,
  Category,
  ConnectionResult,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  MediaType,
  PageResult,
  PlaybackSource,
  ResolvePlayParams,
  SearchParams,
  Source,
  SourceAdapter,
  SourceHealth,
  SourceType,
} from '@/types';

/** 子类探活结果 */
export interface ProbeResult {
  /** 探测到的条目数（可选） */
  itemCount: number | null;
  /** 额外请求头（如登录后 token 缓存）——目前未使用，保留扩展点 */
  headers?: Record<string, string>;
}

export abstract class BaseAdapter implements SourceAdapter {
  abstract readonly type: SourceType;

  /** 单源搜索超时（CHG-15）；需更长链路的子类覆盖 */
  readonly searchTimeoutMs: number = TIMEOUT_SEARCH_MS;

  /** CHG-15：默认无预热；需预热的子类（spider/drpy）覆盖为加载句柄 */
  async warmup(_source: Source): Promise<void> {
    /* 无需预热 */
  }

  /**
   * F10：默认没有加载阶段（HTTP 类适配器请求即业务），搜索预算因此与既有行为完全一致。
   * 有 jar/规则加载开销的子类覆盖为「句柄未就绪即为冷」。
   */
  isSourceCold(_source: Source): boolean {
    return false;
  }

  /** 探活：成功返回条目数；失败 **抛 AppError**（由 testConnection 捕获并归类） */
  protected abstract probe(source: Source, signal?: AbortSignal): Promise<ProbeResult>;

  /**
   * 探活超时窗口（P0-3 → P1-7）：按源类型分级，口径与 `sourceService.probeTimeoutOf`
   * 同出一个模块，保证「`httpClient` 收窄层」与「适配器闸门层」两层窗口一致。
   * 需要按运行时状态再分级的子类（爬虫源的 jar 冷/热）覆盖本方法。
   */
  protected probeWindowMs(source: Source): number {
    return probeWindowMsFor(source);
  }

  abstract listCategories(source: Source, signal?: AbortSignal): Promise<Category[]>;
  abstract browse(params: BrowseParams): Promise<PageResult<MediaItem>>;
  abstract search(params: SearchParams): Promise<MediaItem[]>;
  abstract getDetail(params: GetDetailParams): Promise<MediaDetail>;
  abstract resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource>;

  /** API-01：本方法不抛错，错误放入 result.error */
  async testConnection(source: Source, signal?: AbortSignal): Promise<ConnectionResult> {
    const startedAt = Date.now();
    if (!source.enabled && source.type !== 'demo') {
      return {
        ok: false,
        latencyMs: 0,
        health: 'unknown',
        error: toErrorShape(new AppError('E_SOURCE_DISABLED')),
        itemCount: null,
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const windowMs = this.probeWindowMs(source);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, windowMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await this.probe(source, controller.signal);
      // 不响应 signal 的 probe（如原生调用）可能在超时后才成功，按超时处理
      if (timedOut) {
        throw new AppError('E_TIMEOUT');
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        health: 'ok',
        error: null,
        itemCount: result.itemCount,
      };
    } catch (e) {
      const latencyMs = Date.now() - startedAt;
      const error: AppError =
        timedOut || (e instanceof AppError && e.code === 'E_ABORTED')
          ? new AppError('E_TIMEOUT', undefined, { detail: `探测超过 ${windowMs}ms` })
          : e instanceof AppError
            ? e
            : new AppError('E_SOURCE_UNAVAILABLE', undefined, { detail: String(e) });
      return {
        ok: false,
        latencyMs,
        health: healthOfError(error),
        error: toErrorShape(error),
        itemCount: null,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 源禁用 → E_SOURCE_DISABLED（Service 层已校验，适配器自保） */
  protected assertEnabled(source: Source): void {
    if (!source.enabled && source.type !== 'demo') {
      throw new AppError('E_SOURCE_DISABLED');
    }
  }

  /** 合并源 headers（键名大小写不敏感，后者覆盖前者） */
  protected headersWith(source: Source, extra?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.headers ?? {})) out[key] = value;
    for (const [key, value] of Object.entries(extra ?? {})) {
      const existing = Object.keys(out).find((k) => k.toLowerCase() === key.toLowerCase());
      if (existing) delete out[existing];
      out[key] = value;
    }
    return out;
  }

  /** 构造基础 MediaItem（子类补 fields） */
  protected makeItem(
    source: Source,
    input: {
      sourceItemId: string;
      title: string;
      type: MediaType;
      originalTitle?: string | null;
      year?: number | null;
      area?: string | null;
      genres?: string[];
      tags?: string[];
      actors?: string[];
      rating?: number | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
      description?: string | null;
      durationSec?: number | null;
      episodeCount?: number | null;
      isDemo?: boolean;
      now?: number;
    },
  ): MediaItem {
    const now = input.now ?? Date.now();
    const title = input.title;
    return {
      id: mediaIdOf(source.id, input.sourceItemId),
      sourceId: source.id,
      sourceItemId: input.sourceItemId,
      title,
      originalTitle: input.originalTitle ?? null,
      type: input.type,
      year: input.year ?? null,
      area: input.area ?? null,
      genres: input.genres ?? [],
      tags: input.tags ?? [],
      actors: input.actors ?? [],
      rating: input.rating ?? null,
      posterUrl: input.posterUrl ?? null,
      backdropUrl: input.backdropUrl ?? null,
      description: input.description ?? null,
      durationSec: input.durationSec ?? null,
      episodeCount: input.episodeCount ?? null,
      titleLower: title.toLowerCase(),
      isDemo: input.isDemo ?? false,
      cachedAt: now,
      updatedAt: now,
    };
  }
}

/** 错误码 → 源健康状态（AC-15/AC-16） */
export function healthOfError(error: AppError): SourceHealth {
  // F9：jar 依赖冲突在进程内每次必现，属于配置级故障。按错误码它会落到 unreachable/unknown，
  // 于是永远进不了 bad_config、也就永远不会被 searchCandidate 排除——每次搜索都得重付一遍失败代价。
  if (classifySourceFailure(error.toShape()) === 'jar_conflict') return 'bad_config';
  switch (error.code) {
    case 'E_AUTH':
    case 'E_HTTP_401':
    case 'E_HTTP_403':
      return 'auth_failed';
    case 'E_TIMEOUT':
      return 'timeout';
    case 'E_NETWORK':
    case 'E_HTTP_5XX':
    case 'E_SOURCE_UNAVAILABLE':
    case 'E_HTTP_404':
      return 'unreachable';
    case 'E_INVALID_INPUT':
    case 'E_UNSUPPORTED_FORMAT':
    case 'E_PARSE':
      return 'bad_config';
    default:
      return 'unknown';
  }
}
