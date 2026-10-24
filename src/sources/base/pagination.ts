/**
 * 分页 hasMore 推导（CHG-14）
 *
 * 服务端每页行数与前端 pageSize（30）不一致是常态（CMS/jar 多为 20~25 条/页），
 * 用 `page * 前端pageSize < total` 会系统性提前判"没有更多"。
 * 因此以服务端信号为准，优先级：
 * 1. pagecount：页码语义最准确，`page < pagecount`；
 * 2. total：用**本页实际返回行数**（未按筛选过滤）估算。短末页会低估（如 3×5<45），
 *    多探测一页后由空页守卫终止——宁可多请求一页，也不能像旧推导（page×前端pageSize）
 *    那样提前停止；
 * 3. 都没有：本页有数据就继续，靠"下一条重复返回 0 条"兜底停止
 *    （libraryStore.loadNextPage 去重后新增 0 条会强制置 hasMore=false）。
 */
export interface HasMoreInput {
  page: number;
  /** 本页未过滤的原始行数（response.list.length） */
  rawCount: number;
  total: number | null;
  pageCount: number | null;
}

export function deriveHasMore({ page, rawCount, total, pageCount }: HasMoreInput): boolean {
  if (pageCount !== null) return page < pageCount;
  if (total !== null) return rawCount > 0 && page * rawCount < total;
  return rawCount > 0;
}
