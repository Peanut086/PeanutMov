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
  // `dispose()` 只是 abort，进行中的 `downloadRepo.get/save` 仍可能在 closeDb 之后
  // 重新打开连接，导致 deleteDatabase 被 blocked（并行跑全量用例时偶发 hook 超时）。
  // 这里给中止链路一个宏任务窗口落地，纯测试基建，不改断言语义。
  await new Promise((resolve) => setTimeout(resolve, 20));
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

/* ---------- HLS 分片夹具（FIX-PLAY-A2） ----------
 * 下载器落盘前会对分片做 TS/fMP4 结构校验（screenSegmentBytes），
 * 测试数据必须长成真实分片的样子：TS 每 188 字节一个 0x47 同步头。 */

/** 构造 TS 形态分片：packets 个 188 字节包，同步字节 0x47 按位对齐 */
export function tsSegment(packets = 1, fill = 0): Uint8Array {
  const data = new Uint8Array(188 * packets).fill(fill);
  for (let i = 0; i < packets; i++) data[i * 188] = 0x47;
  return data;
}

/** 构造 fMP4 形态分片：合法 box 头（size + type）+ 指定长度的正文 */
export function fmp4Segment(type = 'moof', payloadBytes = 96): Uint8Array {
  const data = new Uint8Array(8 + payloadBytes);
  new DataView(data.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) data[4 + i] = type.charCodeAt(i);
  return data;
}
