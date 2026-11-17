/**
 * F4/G7：预热降级的共享判据。
 *
 * 预热有两条独立入口（`libraryService.warmupSources` 全量扫描、`sourceStore.warmupSpiderSources`
 * 当前源+健康前 5），两条都必须在熔断期降级，否则单点串行防不住双路并发。
 * 熔断状态只由原生侧 `CrashNative` 判定，这里读结果；读不到一律按未熔断处理——
 * 降级不该成为新的失败点。
 */
import { Spider } from '@/native/spiderPlugin';
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';

/** F4：串行档（熔断 / 已知带原生库的 jar）每个源之间的间隔，给 ART/JNI 留恢复窗口 */
export const PREWARM_SERIAL_STEP_DELAY_MS = 2000;

/** 原生侧崩溃熔断是否生效（同签名原生崩溃 24h 内复发 ≥2 次） */
export async function isPrewarmThrottled(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const state = await Spider.getPrewarmState();
    return state.throttled === true;
  } catch (e) {
    logger.debug('读取预热熔断状态失败（按未熔断处理）', e);
    return false;
  }
}
