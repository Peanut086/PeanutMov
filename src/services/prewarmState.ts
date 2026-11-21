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

/**
 * P1-3：用户点播在途计数。
 *
 * 分类页/详情页/搜索扇出前的预热走的是同一批爬虫实例，而用户点「播放」时等的正是同一条
 * 原生串行闸门（`SpiderAdapter.reserveNativeCall`）。后台预热这时候插队，用户看到的就是
 * 「该源正忙（上一次调用约 N 秒后结束）」——N 往往就是刚被预热吃掉的那次加载。
 * 所以后台预热必须给点播让路：计数只由 `libraryService` 的播放解析路径增删。
 */
let playbackInFlight = 0;

/** 点播解析开始（必须与 `endPlaybackDemand` 成对，用 try/finally 包住） */
export function beginPlaybackDemand(): void {
  playbackInFlight += 1;
}

/** 点播解析结束（含失败与取消） */
export function endPlaybackDemand(): void {
  playbackInFlight = Math.max(0, playbackInFlight - 1);
}

/** 是否有用户点播正在等爬虫实例——后台预热据此收手 */
export function isPlaybackDemandInFlight(): boolean {
  return playbackInFlight > 0;
}
