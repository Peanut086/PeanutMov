/**
 * 冷启动会话恢复（G3）
 *
 * 国产 ROM 会在 App 切后台后把进程整个杀掉（华为真机实证：`iAwareF[SystemManager]`
 * force-stop + `AK-LowMem` SIGKILL），用户看到的"闪退"其实是进程没了。原生侧已按
 * 退出原因归因（G1/G2），前端再补一刀体验：重新打开时直接回到上次那集，
 * 把"闪退了"变成"接着放"。
 *
 * 规则：
 * - 只记播放/详情/回看三类页面，且必须带齐拼出 URL 所需的路径参数；
 * - `?restart=1`（从头播放）不落盘——恢复的语义是"接着放"，不是"重播开头"，
 *   去掉后 PlayerView 自然按 history 里的 `positionSec` 续播；
 * - 离开可恢复页面即删除，所以「看完退回首页再重开」不会被塞回播放页；
 * - 只在「首帧落在首页」时接管一次，带 hash 的深链/提醒跳转等有明确目标的启动不动它；
 * - `pauseHistoryRecording`（隐私开关）打开时完全不写；
 * - 超过 TTL 的陈旧快照丢弃（读到时判定，不常驻定时器）。
 */
import type { Router } from 'vue-router';

import { kvRepo } from '@/db/repositories/kvRepo';
import { onAppStateChange } from '@/native/appLifecycle';
import { KV_KEY_LAST_SESSION } from '@/shared/constants';
import { logger } from '@/shared/logger';
import { settingsService } from '@/services/settingsService';

export interface SessionSnapshot {
  name: string;
  params: Record<string, string>;
  query: Record<string, string>;
  at: number;
}

/** 快照只消费 name/params/query，窄类型让单测能直接喂普通对象 */
interface RouteLike {
  name?: unknown;
  params?: unknown;
  query?: unknown;
}

/** 可恢复的页面 → 拼出该页 URL 必填的路径参数 */
const RESTORABLE_ROUTES: Record<string, string[]> = {
  player: ['mediaId'],
  detail: ['mediaId'],
  replay: ['sourceId', 'programId'],
};

/** 恢复时丢弃的 query 键 */
const DROP_QUERY_KEYS = new Set(['restart']);

/** 快照有效期：跨一夜就不再是"刚才那集"了 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 冷启动落点：只有首帧停在首页才接管 */
const COLD_START_ROUTE = 'home';

function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : '';
  return '';
}

function flatten(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const value = textOf(raw);
    if (value) out[key] = value;
  }
  return out;
}

/** 路由 → 快照；不可恢复的页面或缺必填参数时返回 null */
export function sessionSnapshotOf(route: RouteLike): SessionSnapshot | null {
  const name = typeof route.name === 'string' ? route.name : '';
  const required = RESTORABLE_ROUTES[name];
  if (!required) return null;

  const params = flatten(route.params);
  if (required.some((key) => !params[key])) return null;

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(flatten(route.query))) {
    if (!DROP_QUERY_KEYS.has(key)) query[key] = value;
  }

  return { name, params, query, at: Date.now() };
}

/** 存储里读回来的东西是不可信输入：形状不合或过期都按"没有快照"处理 */
export function normalizeSessionSnapshot(raw: unknown): SessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const at = typeof candidate.at === 'number' ? candidate.at : 0;
  if (!at || at > Date.now() || Date.now() - at > SESSION_TTL_MS) return null;
  const snapshot = sessionSnapshotOf({
    name: candidate.name,
    params: candidate.params,
    query: candidate.query,
  });
  return snapshot ? { ...snapshot, at } : null;
}

/** 已落盘的快照（内存镜像），用于避免同一路由重复读写 */
let persisted: SessionSnapshot | null = null;
/** 待接管的冷启动快照；读库时已一次性删除 */
let pending: SessionSnapshot | null = null;
let detachLifecycle: (() => void) | null = null;

function samePlace(a: SessionSnapshot | null, b: SessionSnapshot | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.name === b.name &&
    JSON.stringify(a.params) === JSON.stringify(b.params) &&
    JSON.stringify(a.query) === JSON.stringify(b.query)
  );
}

/** 写入或删除当前快照；`force` 用于切后台时刷新时间戳 */
async function record(route: RouteLike, force = false): Promise<void> {
  try {
    const settings = await settingsService.get();
    const next = settings.pauseHistoryRecording ? null : sessionSnapshotOf(route);
    if (!next && !persisted) return;
    if (!force && samePlace(persisted, next)) return;
    persisted = next;
    if (next) await kvRepo.set(KV_KEY_LAST_SESSION, next);
    else await kvRepo.delete(KV_KEY_LAST_SESSION);
  } catch (e) {
    logger.debug('会话快照写入失败', { error: (e as Error)?.message });
  }
}

/** 读出并一次性消费冷启动快照（含 TTL 与形状校验） */
export async function takeSessionSnapshot(): Promise<SessionSnapshot | null> {
  const stored = await kvRepo.get<unknown>(KV_KEY_LAST_SESSION);
  if (stored === null) return null;
  await kvRepo.delete(KV_KEY_LAST_SESSION);
  persisted = null;
  return normalizeSessionSnapshot(stored);
}

/**
 * 接线：必须在 `app.use(router)` 之前调用，首帧导航才会被接管。
 *
 * 恢复由一次性 `beforeEach` 完成（不是安装后再 `replace`）——那样首页会先挂载、
 * 播放页再盖上去，用户看得见一次闪跳。
 */
export async function bindSessionRestore(router: Router): Promise<void> {
  // 隐私开关可能是后打开的：先擦掉此前留下的快照，避免关了历史记录还能"接着放"
  const settings = await settingsService.get();
  if (settings.pauseHistoryRecording) await clearSessionSnapshot();
  else pending = await takeSessionSnapshot();
  let first = true;

  router.beforeEach((to) => {
    if (!first) return true;
    first = false;
    const snapshot = pending;
    pending = null;
    if (!snapshot || to.name !== COLD_START_ROUTE) return true;
    return { name: snapshot.name, params: snapshot.params, query: snapshot.query, replace: true };
  });

  router.afterEach((to) => {
    void record(to);
  });

  // 切后台补写一次：进程随时可能被清掉，此刻的 `at` 才是"用户最后停留时间"
  detachLifecycle?.();
  detachLifecycle = onAppStateChange((state) => {
    if (state === 'background') void record(router.currentRoute.value, true);
  });
}

/** 清除快照（隐私开关切换 / 测试） */
export async function clearSessionSnapshot(): Promise<void> {
  persisted = null;
  pending = null;
  await kvRepo.delete(KV_KEY_LAST_SESSION);
}

/** 测试辅助：重置内部状态 */
export function __resetSessionRestore(): void {
  persisted = null;
  pending = null;
  detachLifecycle?.();
  detachLifecycle = null;
}
