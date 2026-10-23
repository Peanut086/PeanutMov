/**
 * 豆瓣源的跨源播放装配
 *
 * 豆瓣只有片单，播放地址要向 CMS 源借用。这里把「按片名搜其它源 →
 * 匹配 → 取候选源适配器」的流程装配进 `doubanRuntime`（registry 里的
 * `DoubanAdapter` 读的就是它），避免适配器反向依赖 libraryService 形成环。
 *
 * 匹配规则见 `playMatch.ts`：片名归一化后必须相等、年份必须一致，否则宁可播放失败。
 */
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { libraryService } from '@/services/libraryService';
import { doubanRuntime } from '@/sources/douban/DoubanAdapter';
import { pickPlayCandidate } from '@/sources/douban/playMatch';
import { sourceRegistry } from '@/sources/registry';
import { logger } from '@/shared/logger';

/** 在「自带片源的启用源」里按片名搜索，返回匹配的候选 */
const resolvePlayFrom = async (params: {
  title: string;
  year: number | null;
  signal?: AbortSignal;
}): ReturnType<NonNullable<typeof doubanRuntime.resolvePlayFrom>> => {
  const all = await sourceRepo.list();
  // 只向自带片源的源借地址（与 playMatch.pickPlayCandidate 的口径一致）：
  // 同为发现源的豆瓣源没有播放能力，jellyfin/alist/webdav 搜了也会在匹配时被丢弃
  const providers = all.filter(
    (source) => source.enabled && (source.type === 'site' || source.type === 'spider'),
  );
  if (providers.length === 0) return null;

  const result = await libraryService.search({
    keyword: params.title,
    sourceIds: providers.map((source) => source.id),
    signal: params.signal,
  });
  if (result.items.length === 0) return null;

  const byId = new Map(providers.map((source) => [source.id, source]));
  return pickPlayCandidate(params.title, params.year, result.items, byId);
};

const adapterGetter = (source: Parameters<typeof sourceRegistry.forSource>[0]) =>
  sourceRegistry.forSource(source);

let configured = false;

/** 装配豆瓣跨源播放（幂等）；在应用启动时调用 */
export function configureDoubanRuntime(): void {
  if (configured) return;
  configured = true;
  doubanRuntime.resolvePlayFrom = resolvePlayFrom;
  doubanRuntime.adapterGetter = adapterGetter;
  logger.debug('豆瓣跨源播放已装配');
}
