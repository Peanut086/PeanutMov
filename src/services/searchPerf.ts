/**
 * PERF-0：搜索性能埋点（第 0 步，纯观测、零行为变更）。
 *
 * 输出走 logger.info：生产构建关闭 debug（shared/logger.ts），真机 release 必须可见。
 * `window.__searchPerf` 是 CDP 读取脚手架，批次 E 诊断面板落地后移除。
 */
import { logger } from '@/shared/logger';

/** 单源一次搜索的分段耗时与结局（loadMs/searchMs 由适配器回填） */
export interface SearchPerfSource {
  id: string;
  name: string;
  ms: number;
  /** ok / empty / ignored / aborted / 错误码（E_TIMEOUT 等） */
  outcome: string;
  cold: boolean;
  loadMs?: number;
  searchMs?: number;
}

export interface SearchPerfRecord {
  at: number;
  keyword: string;
  /** full=全量扇出；subset=重试失败源/继续跳过源 */
  mode: 'full' | 'subset';
  forceAll: boolean;
  online: boolean;
  candidates: number;
  filteredOut: number;
  launched: number;
  skipped: number;
  failed: number;
  ignored: number;
  localMs: number;
  localCount: number;
  mediaCount?: number;
  /** submit → 首个非空远程 partial；无结果为 null */
  firstResultMs: number | null;
  totalMs: number;
  aborted: boolean;
  sources: SearchPerfSource[];
}

const MAX_RECORDS = 20;
const records: SearchPerfRecord[] = [];
const perfLogger = logger.scope('searchPerf');

export function recordSearchPerf(record: SearchPerfRecord): void {
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();
  perfLogger.info('search', record);
}

export function listSearchPerf(): readonly SearchPerfRecord[] {
  return records;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __searchPerf?: { list: () => readonly SearchPerfRecord[] } }).__searchPerf = {
    list: listSearchPerf,
  };
}