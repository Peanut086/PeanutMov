/**
 * 演示种子服务（AC-95 ~ AC-99）
 *
 * `main.ts` 启动时调用一次：`await seedService.ensureDemo()`。
 * 幂等：重复调用不会产生重复条目；已禁用演示源时保持禁用（除非 `restoreDemo`）。
 */
import { DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { DEMO_SOURCE_ID, isDemoSeeded } from '@/data/demo/demoSeed';
import { sourceService } from '@/services/sourceService';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { KV_KEY_DEMO_SEEDED } from '@/shared/constants';
import { logger } from '@/shared/logger';
import { isCanceled, toAppError } from '@/shared/errors';
import type { MediaItem, Source } from '@/types';

export interface SeedService {
  /** 幂等确保演示源与演示条目存在（启动钩子） */
  ensureDemo(): Promise<Source>;
  /** 恢复演示源（设置页"恢复演示源"，AC-97） */
  restoreDemo(): Promise<Source>;
  /** 是否已完整种子 */
  isSeeded(): Promise<boolean>;
  /** 当前演示条目（供首页兜底） */
  listDemoItems(limit?: number): Promise<MediaItem[]>;
}

let ensurePromise: Promise<Source> | null = null;

export const seedService: SeedService = {
  async ensureDemo(): Promise<Source> {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      try {
        const seededFlag = await kvRepo.get<boolean>(KV_KEY_DEMO_SEEDED);
        const source = await sourceService.ensureDemoSource();
        if (seededFlag !== true) {
          await kvRepo.set(KV_KEY_DEMO_SEEDED, true);
        }
        logger.info('演示数据就绪', { items: DEMO_ITEMS.length, sourceId: source.id });
        return source;
      } catch (e) {
        if (isCanceled(e)) throw e;
        const error = toAppError(e, 'E_DB');
        logger.error('演示数据初始化失败', error);
        throw error;
      }
    })();
    try {
      return await ensurePromise;
    } finally {
      ensurePromise = null;
    }
  },

  async restoreDemo(): Promise<Source> {
    const source = await sourceService.restoreDemo();
    await kvRepo.set(KV_KEY_DEMO_SEEDED, true);
    return source;
  },

  async isSeeded(): Promise<boolean> {
    return isDemoSeeded(DEMO_SOURCE_ID);
  },

  async listDemoItems(limit = DEMO_ITEMS.length): Promise<MediaItem[]> {
    const rows = await mediaRepo.listBySource(DEMO_SOURCE_ID, { limit, offset: 0 });
    return rows.filter((item) => item.isDemo);
  },
};

export type { SeedService as SeedServiceContract };
