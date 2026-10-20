/**
 * 数据层测试公共工具（非 spec 文件，不被 vitest 作为用例收集）
 */
import { closeDb, deleteDatabase, resetDbConnection } from '@/db/index';
import { kvRepo } from '@/db/repositories/kvRepo';
import { settingsService } from '@/services/settingsService';
import { downloadService } from '@/services/downloadService';
import { appEvents } from '@/services/events';
import { healthService } from '@/services/healthService';
import { sourceRegistry, resetRegistryToDefaults } from '@/sources/registry';

/** 清空数据库并重置所有模块级缓存（每个用例前调用） */
export async function resetAll(): Promise<void> {
  downloadService.__resetQueue();
  settingsService.__resetCache();
  healthService.__reset();
  appEvents.clear();
  resetRegistryToDefaults();
  // 先关闭已缓存的连接（否则 deleteDatabase 会被 blocked 卡住）
  await closeDb();
  await deleteDatabase();
  resetDbConnection();
}

/** 读取 kv 值（断言语义用） */
export async function readKv<T>(key: string): Promise<T | null> {
  return kvRepo.get<T>(key);
}

export { sourceRegistry };

/** 构造一个最小可用的 alist 源（避免各 spec 重复） */
export const FIXED_NOW = 1_700_000_000_000;

export function tick(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
