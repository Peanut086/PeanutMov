/**
 * 直播播放列表旁路属性（EXT-06 / FR-68，D-08）
 *
 * 硬约束：**不修改** `liveParsers.parseM3u`（`tests/unit/liveParsers.spec.ts` 整对象断言）。
 * 因此 `tvg-id` / `tvg-name` / `catchup-*` 由本模块独立二次扫描，
 * 以「频道 URL」为键产出 `LiveChannelExtrasMap`，由上层按 URL 关联到 `LiveChannel`。
 */
import type { LiveChannelExtras, LiveChannelExtrasMap } from '@/types';
import { catchupDaysOf } from '@/shared/catchupTemplate';

/** `key="value"` / `key='value'` 属性对（m3u 属性值通常带引号） */
const ATTR_RE = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"|([A-Za-z0-9_-]+)\s*=\s*'([^']*)'/g;

function emptyExtras(): LiveChannelExtras {
  return {
    tvgId: null,
    tvgName: null,
    catchupTemplate: null,
    catchupDays: null,
    catchupCorrectionSec: null,
  };
}

/** 空属性（供 UI/服务层在无扩展数据时兜底，避免到处判空） */
export const EMPTY_EXTRAS: LiveChannelExtras = emptyExtras();

function parseAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(line))) {
    const key = (match[1] ?? match[3] ?? '').toLowerCase();
    if (!key) continue;
    attrs[key] = match[2] ?? match[4] ?? '';
  }
  return attrs;
}

/**
 * 解析 m3u 文本，返回「频道 URL → 扩展属性」映射。
 * - 只读 `#EXTINF` 行与紧随其后的地址行，其余行忽略（不改变 `parseM3u` 的取值规则）；
 * - 非 m3u 文本（txt 列表等）返回空对象，调用方按「无扩展属性」处理。
 */
export function parseLiveExtras(text: string | null | undefined): LiveChannelExtrasMap {
  const map: LiveChannelExtrasMap = {};
  const content = text ?? '';
  if (!content.includes('#EXTINF')) return map;

  const lines = content.split(/\r?\n/);
  let pending: LiveChannelExtras | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttrs(line);
      pending = {
        tvgId: attrs['tvg-id']?.trim() || null,
        tvgName: attrs['tvg-name']?.trim() || null,
        catchupTemplate: attrs['catchup-source']?.trim() || null,
        catchupDays: catchupDaysOf(attrs['catchup-days']),
        catchupCorrectionSec: attrs['catchup-correction']
          ? Number(attrs['catchup-correction']) || null
          : null,
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) {
      map[line] = pending;
      pending = null;
    }
  }
  return map;
}

/** 按频道 URL 取扩展属性（无则返回共享空对象） */
export function extrasOf(map: LiveChannelExtrasMap | null | undefined, url: string): LiveChannelExtras {
  return map?.[url] ?? EMPTY_EXTRAS;
}

/** 反查：某 tvg-id 在列表中的首个 URL（L1 匹配辅助） */
export function urlOfTvgId(map: LiveChannelExtrasMap, tvgId: string): string | null {
  const target = tvgId.trim().toLowerCase();
  for (const [url, extras] of Object.entries(map)) {
    if ((extras.tvgId ?? '').trim().toLowerCase() === target) return url;
  }
  return null;
}
