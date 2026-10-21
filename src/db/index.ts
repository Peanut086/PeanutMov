/**
 * IndexedDB 连接与事务封装（技术方案 5 章）
 *
 * 约定：
 * - 所有 DB 访问只能经 repositories；repositories 内部使用 `getDb()` / `withTx()`。
 * - `withTx` 内的回调**只能 await IDB 相关 Promise**（idb 事务在等待非 IDB Promise 时会自动提交）；
 *   需要"分批 + 让出事件循环"的批量写请拆成多个事务（见 mediaRepo.upsertMany）。
 * - 任何 IDB 异常统一映射：配额 → `E_STORAGE_QUOTA`，版本 → `E_VERSION_UNSUPPORTED`，其余 → `E_DB`；
 *   已经是 `AppError` 的原样透传。
 */
import { deleteDB, openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';

import { DB_NAME, DB_VERSION } from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

import type { CinemaDB, StoreName } from '@/db/schema';
import { upgrade } from '@/db/migrations';

let dbPromise: Promise<IDBPDatabase<CinemaDB>> | null = null;
/** 升级被其它窗口阻塞时置位，UI 可据此提示"请关闭其它窗口后重试" */
let blockedByOtherVersion = false;

export function isDbBlocked(): boolean {
  return blockedByOtherVersion;
}

/** 映射任意 DB 异常为 AppError；已是 AppError 时原样返回 */
export function mapDbError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (typeof e === 'object' && e !== null) {
    const name = (e as { name?: unknown }).name;
    if (name === 'QuotaExceededError') {
      return new AppError('E_STORAGE_QUOTA', undefined, { cause: e });
    }
    if (name === 'VersionError') {
      return new AppError('E_VERSION_UNSUPPORTED', undefined, { cause: e });
    }
  }
  const base = toAppError(e, 'E_DB');
  if (base.code === 'E_UNKNOWN' || base.code === 'E_STORAGE_QUOTA' || base.code === 'E_ABORTED') {
    return base;
  }
  return new AppError('E_DB', undefined, { detail: base.message, cause: e });
}

/**
 * 打开（或复用）数据库连接。
 * - 数据库版本高于客户端（VersionError）→ `E_VERSION_UNSUPPORTED`，不调用 deleteDatabase。
 * - 其它失败 → `E_DB`。
 */
export function getDb(): Promise<IDBPDatabase<CinemaDB>> {
  if (dbPromise) return dbPromise;
  dbPromise = openDB<CinemaDB>(DB_NAME, DB_VERSION, {
    upgrade,
    blocked(currentVersion, blockedVersion) {
      blockedByOtherVersion = true;
      logger.warn('数据库升级被其它窗口阻塞', { currentVersion, blockedVersion });
    },
    blocking() {
      // 其它标签页请求升级：主动关闭连接，避免永久阻塞
      void dbPromise?.then((db) => db.close()).catch(() => undefined);
      dbPromise = null;
    },
    terminated() {
      logger.warn('数据库连接被浏览器异常终止，下次访问将重连');
      dbPromise = null;
    },
  }).catch((error: unknown) => {
    dbPromise = null;
    throw mapDbError(error);
  });
  return dbPromise;
}

/** 是否开发期构建（用于事务诊断日志；生产构建不产生额外副作用） */
function isDevBuild(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

/**
 * 事务提前结束诊断（REV-01 / REV-02）。
 *
 * 回调里只要 await 了"非本事务"的 Promise（最典型：调用未传 `tx` 的 repository 方法，
 * 内部又自开了一个事务），浏览器会在 await 期间把本事务自动提交；此后本事务的写入
 * 会抛 `InvalidStateError`，且已写入的数据无法回滚。这里在**回调返回时**检查
 * `tx.done` 是否已经 settle，命中即记录错误日志（只在开发期输出，不抛异常影响功能）。
 */
function reportPrematureSettle(
  stores: StoreName[],
  mode: IDBTransactionMode,
  outcome: 'commit' | 'abort',
): void {
  if (!isDevBuild()) return;
  logger.error(
    'withTx 回调结束时事务已提前结束，原子性可能已丢失：请在回调内把 tx 传给 repository，避免嵌套自开事务',
    { stores, mode, outcome },
  );
}

/**
 * 事务封装：成功提交后返回结果；失败时回滚并抛出映射后的 AppError。
 *
 * 返回的事务类型固定为"全部 store"的宽类型，便于把同一个事务传给多个 repository。
 */
export async function withTx<Mode extends IDBTransactionMode, Result>(
  stores: StoreName[],
  mode: Mode,
  fn: (tx: IDBPTransaction<CinemaDB, StoreName[], Mode>) => Promise<Result> | Result,
): Promise<Result> {
  const db = await getDb();
  let tx: IDBPTransaction<CinemaDB, StoreName[], Mode>;
  try {
    tx = db.transaction(stores, mode);
  } catch (e) {
    throw mapDbError(e);
  }
  // 记录事务结束时机：若回调返回前就已 settle，说明回调 await 了非本事务的 Promise
  let settleOutcome: 'commit' | 'abort' | null = null;
  const done = tx.done.then(
    () => {
      settleOutcome = 'commit';
    },
    () => {
      settleOutcome = 'abort';
    },
  );
  try {
    const result = await fn(tx);
    if (settleOutcome !== null) reportPrematureSettle(stores, mode, settleOutcome);
    await tx.done;
    return result;
  } catch (e) {
    if (settleOutcome === 'commit') reportPrematureSettle(stores, mode, 'commit');
    try {
      tx.abort();
    } catch {
      // 事务已结束（自动提交/已回滚），忽略
    }
    await done;
    throw mapDbError(e);
  }
}

/** 关闭连接（清空数据后或测试使用） */
export async function closeDb(): Promise<void> {
  const current = dbPromise;
  dbPromise = null;
  blockedByOtherVersion = false;
  if (!current) return;
  try {
    const db = await current;
    db.close();
  } catch {
    // 连接本身失败时无需关闭
  }
}

/** 删除整个数据库（仅测试/彻底重置使用；业务层用各 repo 的 clear） */
export async function deleteDatabase(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME, {
    blocked() {
      logger.warn('删除数据库被其它连接阻塞');
    },
  });
}

/** 测试辅助：重置连接缓存（不删除数据） */
export function resetDbConnection(): void {
  dbPromise = null;
  blockedByOtherVersion = false;
}
