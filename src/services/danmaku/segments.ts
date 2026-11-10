/**
 * 分片弹幕拉取的公共件
 *
 * 国产平台的弹幕都按固定时间窗切片（腾讯 30s、芒果/爱奇艺/优酷/搜狐 60s），
 * 一集 45 分钟就是 45~90 片；一次全 fan-out 会触发风控，故统一按小批次并发、
 * 单片失败只丢该片（返回已成功部分）。
 */

/** 分片并发上限：与腾讯源验证过的取值保持一致 */
export const SEGMENT_CONCURRENCY = 6;

/** 按并发上限分批执行 `worker` 并合并结果；单批内失败的任务静默跳过 */
export async function fetchInBatches<T, R>(items: T[], worker: (item: T) => Promise<R[]>): Promise<R[]> {
  const all: R[] = [];
  for (let start = 0; start < items.length; start += SEGMENT_CONCURRENCY) {
    const batch = items.slice(start, start + SEGMENT_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(worker));
    for (const result of results) {
      if (result.status === 'fulfilled') all.push(...result.value);
    }
  }
  return all;
}

/** 时长文本 `mm:ss` / `hh:mm:ss` / 秒或毫秒数值 → 秒；无法解析返回 null */
export function parseDurationSec(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return raw > 10_000 ? Math.round(raw / 1000) : raw;
  const text = (raw ?? '').trim();
  if (text.length === 0) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.reduce((acc, part) => acc * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

/**
 * 集号 → 数组下标：平台返回的分集顺序不保证与集号一致（花絮/预告/特别篇混排），
 * 故先按编号字段精确命中，命中失败才退回顺序位。
 */
export function indexByNumber<T>(items: T[], episode: number, readNumber: (item: T) => number | null): number {
  const exact = items.findIndex((item) => readNumber(item) === episode);
  return exact >= 0 ? exact : episode - 1;
}

/** 集号文本「1」/「第3集」→ 数字；无法解析返回 null */
export function episodeNumberOf(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  const digits = /(\d+)/.exec((raw ?? '').toString());
  const value = Number(digits?.[1] ?? '');
  return Number.isFinite(value) && value > 0 ? value : null;
}
