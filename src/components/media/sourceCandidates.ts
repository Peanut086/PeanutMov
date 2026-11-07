/**
 * 来源候选视图模型（详情页切换来源 / 搜索页选择来源共用）
 *
 * 把 MediaItem[] 变成 UI 可直接渲染的候选列表：
 * - 当前源固定第一行；
 * - 其余按可播性 → 健康 tier → 源名排序；
 * - 标记 recommended（非当前、第一个可播候选）。
 */
import type { MediaItem, Source, SourceHealth } from '@/types';
import type { PlayabilityStatus } from '@/services/playabilityService';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';

export interface SourceCandidate {
  mediaId: string;
  sourceId: string;
  sourceName: string;
  title: string;
  year: number | null;
  episodeCount: number | null;
  health: SourceHealth;
  playability: PlayabilityStatus;
  isCurrent: boolean;
  recommended: boolean;
}

export interface BuildSourceCandidatesContext {
  currentMediaId?: string;
  currentItem?: MediaItem | null;
  sources: Source[];
  playabilityOf: (mediaId: string) => PlayabilityStatus;
  latencyOf?: (sourceId: string) => number | null;
}

export function buildSourceCandidates(
  items: MediaItem[],
  ctx: BuildSourceCandidatesContext,
): SourceCandidate[] {
  const sourceById = new Map(ctx.sources.map((s) => [s.id, s]));
  const candidates: SourceCandidate[] = [];

  for (const item of items) {
    const source = sourceById.get(item.sourceId);
    if (!source) continue;
    const isCurrent =
      item.id === ctx.currentMediaId ||
      (ctx.currentItem != null &&
        item.sourceId === ctx.currentItem.sourceId &&
        item.sourceItemId === ctx.currentItem.sourceItemId);
    candidates.push({
      mediaId: item.id,
      sourceId: item.sourceId,
      sourceName: source.name,
      title: item.title,
      year: item.year,
      episodeCount: item.episodeCount,
      health: source.health,
      playability: ctx.playabilityOf(item.id),
      isCurrent: Boolean(isCurrent),
      recommended: false,
    });
  }

  // 排序：当前源固定第一 → 可播优先 → 健康 tier → 延迟 → 源名
  candidates.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const playRank = (status: PlayabilityStatus): number => {
      if (status === 'playable') return 0;
      if (status === 'verifying' || status === 'unknown') return 1;
      return 2;
    };
    const pDiff = playRank(a.playability) - playRank(b.playability);
    if (pDiff !== 0) return pDiff;
    const tierA = HEALTH_TIER_ORDER[healthTierOf(a.health, ctx.latencyOf?.(a.sourceId) ?? null)];
    const tierB = HEALTH_TIER_ORDER[healthTierOf(b.health, ctx.latencyOf?.(b.sourceId) ?? null)];
    if (tierA !== tierB) return tierA - tierB;
    const latA = ctx.latencyOf?.(a.sourceId) ?? Number.POSITIVE_INFINITY;
    const latB = ctx.latencyOf?.(b.sourceId) ?? Number.POSITIVE_INFINITY;
    if (latA !== latB) return latA - latB;
    return a.sourceName.localeCompare(b.sourceName);
  });

  // 标记 recommended：非当前、第一个可播候选
  for (const c of candidates) {
    if (!c.isCurrent && c.playability === 'playable') {
      c.recommended = true;
      break;
    }
  }

  return candidates;
}

export function healthLabel(health: SourceHealth): string {
  switch (health) {
    case 'ok':
      return '正常';
    case 'timeout':
      return '慢';
    case 'unreachable':
      return '不可达';
    case 'auth_failed':
      return '需登录';
    case 'bad_config':
      return '配置错误';
    case 'empty':
      return '无内容';
    default:
      return '未知';
  }
}

export function playabilityLabel(status: PlayabilityStatus): string {
  switch (status) {
    case 'playable':
      return '可播';
    case 'verifying':
      return '检测中';
    case 'empty':
      return '无剧集';
    case 'error':
      return '加载失败';
    default:
      return '未检测';
  }
}
