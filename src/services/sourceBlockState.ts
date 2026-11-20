/**
 * 爬虫源保护态的前端镜像（P0-1）
 *
 * 原生侧（CrashResponse + CrashSentinel）才是权威：崩过之后按单次弱归因给短冷却，
 * 同构件复发或有同现场 tombstone 时隔离整个 jar。JS 侧只负责把「现在别去敲这扇门」
 * 这件事同步给三个高频入口——自动预热、失败换线、自动换源。此前它们只认
 * `isLoadSuppressed`（确定性加载失败台账），对冷却/隔离一无所知，于是每轮启动、
 * 每一次换线都会重新去敲一扇原生已经明确拒绝的门。
 *
 * 判定口径：不猜订阅 api 与 jar 的对应关系（同类名在不同站点往往落在不同 jar 里，
 * 按类名反推会误杀健康站），只镜像**原生真实抛回来的拒绝**：哪个 sourceId 被拒，
 * 就记哪个 sourceId；调用成功即清除。真机日志里的 `pid/tid jarHash= api= phase=`
 * 归因行负责提供 jar 级细节。
 *
 * 时长是兜底值：与 CrashResponse 的冷却/隔离窗口对齐，让"原生已放行但前端还拦着"
 * 最多持续一个窗口；期间任何一次成功调用都会立刻解除。
 */
import { SPIDER_COOLDOWN_MS, SPIDER_QUARANTINE_MS } from '@/shared/constants';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { Spider, type SpiderExitEvidence } from '@/native/spiderPlugin';

export type SourceBlockKind = 'quarantined' | 'cooldown' | 'safe_mode';

export interface SourceBlock {
  kind: SourceBlockKind;
  /** 兜底放行时刻（epoch ms）；原生侧提前放行会在下一次成功调用时被清掉 */
  until: number;
  /** 记录原因（原生拒绝原文的关键片段） */
  note: string;
}

const BLOCK_MS: Record<SourceBlockKind, number> = {
  quarantined: SPIDER_QUARANTINE_MS,
  cooldown: SPIDER_COOLDOWN_MS,
  // 安全模式由原生按窗口自动退出，这里只镜像一个冷却时长，避免前端把保护做成永久
  safe_mode: SPIDER_COOLDOWN_MS,
};

/** sourceId → 保护态；进程级，跨页面与路由重建存活 */
const blocks = new Map<string, SourceBlock>();

/** 记录（或刷新）某个源的保护态 */
export function noteSourceBlocked(
  sourceId: string,
  kind: SourceBlockKind,
  note = '',
): void {
  if (!sourceId) return;
  const until = Date.now() + BLOCK_MS[kind];
  blocks.set(sourceId, { kind, until, note });
  logger.warn('爬虫保护态已镜像到前端', {
    sourceId,
    kind,
    until,
    note,
    blockedTotal: blocks.size,
  });
}

/** 调用成功 = 原生已放行，清掉镜像 */
export function clearSourceBlock(sourceId: string): void {
  if (!sourceId) return;
  const existing = blocks.get(sourceId);
  if (!existing) return;
  blocks.delete(sourceId);
  logger.info('爬虫保护态镜像已解除', { sourceId, wasKind: existing.kind });
}

/** 当前保护态；null = 没有记录或已到兜底放行时间 */
export function getSourceBlock(sourceId: string | null | undefined): SourceBlock | null {
  if (!sourceId) return null;
  const block = blocks.get(sourceId);
  if (!block) return null;
  if (block.until <= Date.now()) {
    blocks.delete(sourceId);
    return null;
  }
  return block;
}

export function isSourceBlocked(sourceId: string | null | undefined): boolean {
  return getSourceBlock(sourceId) !== null;
}

/** 全部保护态快照（健康中心/诊断用） */
export function sourceBlockSnapshot(): Array<{ sourceId: string } & SourceBlock> {
  const out: Array<{ sourceId: string } & SourceBlock> = [];
  for (const [sourceId, block] of blocks) {
    if (block.until > Date.now()) out.push({ sourceId, ...block });
    else blocks.delete(sourceId);
  }
  return out;
}

/**
 * 用户按下「恢复」之后清掉软档镜像（冷却 / 安全模式），保留 jar 级隔离。
 *
 * 安全模式在原生侧一刀切的瞬间，前端镜像里会积一批 `safe_mode` 记录；原生恢复后
 * 这些源立刻可用，但镜像若无挂钩就要等到兜底时长才放行——表现为"点了恢复，
 * 源还是不出"。jar 隔离不受影响：它只由 `unquarantine` 或到期解除（P0-1 红线）。
 * 返回清掉的条数，供调用方说明恢复范围。
 */
export function releaseBlocksAfterRestore(): number {
  let released = 0;
  for (const [sourceId, block] of [...blocks]) {
    if (block.kind === 'quarantined') continue;
    blocks.delete(sourceId);
    released += 1;
  }
  if (released > 0) {
    logger.info('恢复已解除前端保护态镜像', { released, keptQuarantined: blocks.size });
  }
  return released;
}

/** 测试辅助：清空镜像 */
export function __resetSourceBlockState(): void {
  blocks.clear();
  evidenceCache = null;
}

/* ---------- P0-1：被拦时能说出"依据哪条现场" ---------- */

/** 现场读数缓存有效期：诊断入口的读频很低，60s 足够新崩溃被归因进来 */
const EVIDENCE_TTL_MS = 60_000;
let evidenceCache: { at: number; items: SpiderExitEvidence[] } | null = null;

/**
 * 原生台账里的退出现场（本轮 + 上次进程写回的证据）。
 *
 * 拿不到（Web / 旧 APK / 插件未实现）时返回空数组：这是排查辅助信息，不能拦住恢复入口本身。
 */
export async function recentExitEvidence(force = false): Promise<SpiderExitEvidence[]> {
  if (!isNative()) return [];
  const now = Date.now();
  if (!force && evidenceCache && now - evidenceCache.at < EVIDENCE_TTL_MS) return evidenceCache.items;
  let items: SpiderExitEvidence[] = [];
  try {
    const result = await Spider.getRecentExits();
    items = Array.isArray(result?.items) ? result.items : [];
  } catch (e) {
    logger.debug('退出现场读数读取失败（忽略）', { error: (e as Error)?.message });
    return [];
  }
  evidenceCache = { at: now, items };
  return items;
}

function evidenceMatches(
  evidence: SpiderExitEvidence,
  jarHash: string | undefined,
  api: string | undefined,
): boolean {
  const hash = (evidence.jarHash ?? '').trim();
  if (!hash || hash !== (jarHash ?? '').trim()) return false;
  // 没有 api 时按构件指纹即可（jar 级隔离整包都算这个构件）
  if (!api) return true;
  const evidenceApi = (evidence.api ?? '').trim();
  return evidenceApi === api || evidenceApi === '*' || evidenceApi === '';
}

/**
 * 某个 jar（按构件指纹 + api）最近一次退出的现场读数，供隔离面板说明"根据什么拦的"。
 * 只按构件指纹匹配，不看 api 名字像不像——同类名分布在多个 jar，按类名找会张冠李戴。
 */
export async function evidenceForJar(
  jarHash: string | undefined,
  api?: string,
): Promise<SpiderExitEvidence | null> {
  if (!jarHash) return null;
  const items = await recentExitEvidence();
  for (const evidence of items) {
    if (evidenceMatches(evidence, jarHash, api)) return evidence;
  }
  return null;
}

/* ---------- P0-5：上次退出的归因（要不要重放现场，看这个） ---------- */

/**
 * 退出方式四档 + 一档 Java 级崩溃。
 *
 * 原生 `ExitAttribution` 只有「崩了 / 被杀了 / 无从判定」三档，那是给隔离用的；
 * 会话恢复要问的是另一个问题：**这次启动该不该把上次那个现场再跑一遍**。
 * 被系统回收（华为 `iAwareF[SystemManager]` force-stop、`AK-LowMem` SIGKILL）不是 App 的错，
 * 上一次"接着放"是用户想要的；反过来，进程自己倒下时那份现场就是刚把它打死的那一份。
 * 11-20 真机日志里"重开就在 ep1/ep2 之间来回跳、线路一直自动切到全废"，缺的正是这个区分。
 *
 * - `normal`：应用/用户自己结束（`REASON_EXIT_SELF`、主动 back 退出）；
 * - `system_reclaim`：后台清理、低内存、SIGKILL/SIGTERM、依赖进程死亡、冻结；
 * - `native`：原生层倒下（`REASON_CRASH_NATIVE`、tombstone、崩溃信号）；
 * - `java`：JVM 未捕获异常把进程带走（`REASON_CRASH` / 台账里的 `java:<异常>`）——
 *   与原生崩溃分档，因为隔离现场里两类证据的处理链路本来就不同；
 * - `unknown`：读不出原因（Web、旧 APK、AEI 没给描述）。按"不是崩溃"处理，照常续播。
 */
export type ExitKind = 'normal' | 'system_reclaim' | 'native' | 'java' | 'unknown';

/** 进程内部倒下的信号号（与原生 `ExitAttribution.isCrashSignal` 同一张表） */
const CRASH_SIGNALS = new Set([
  'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGSEGV', 'SIGSTKFLT', 'SIGXCPU', 'SIGXFSZ', 'SIGSYS',
]);

/** 外部终止的信号：被杀不等于崩了 */
const KILL_SIGNALS = new Set(['SIGKILL', 'SIGTERM']);

function reasonOf(evidence: SpiderExitEvidence): string {
  return (evidence.exitReason ?? '').trim();
}

/** 单条退出证据 → 归因档位；判不出就是 `unknown`，不猜 */
export function exitKindOf(evidence: SpiderExitEvidence): ExitKind {
  const reason = reasonOf(evidence);
  const signal = (evidence.signal ?? '').trim();
  if (reason.startsWith('native:')) return 'native';
  if (reason.startsWith('java:')) return 'java';
  if (KILL_SIGNALS.has(signal)) return 'system_reclaim';
  if (CRASH_SIGNALS.has(signal)) return 'native';
  if (reason.startsWith('aei:REASON_CRASH_NATIVE')) return 'native';
  if (reason.startsWith('aei:REASON_CRASH')) return 'java';
  if (reason.startsWith('aei:REASON_EXIT_SELF')) return 'normal';
  // 系统没给原因：JS 侧读不到 description，不能替原生那句 looksLikeSystemKill 猜
  if (reason.startsWith('aei:REASON_UNKNOWN')) return 'unknown';
  if (reason.startsWith('aei:REASON_')) return 'system_reclaim';
  return 'unknown';
}

/** 是否"进程自己倒下"——只有这一类才允许据此跳过源、不重放现场 */
export function isCrashExit(kind: ExitKind): boolean {
  return kind === 'native' || kind === 'java';
}

/**
 * 最近一次退出的归因。
 *
 * 取台账里时间戳最新的一条；读不到（Web / 旧 APK / 插件未实现）返回 `unknown`，
 * 调用方据此走"照常续播"——归因失败不能变成新的体验倒退。
 */
export async function lastExitKind(): Promise<{ kind: ExitKind; evidence: SpiderExitEvidence | null }> {
  const items = await recentExitEvidence();
  let latest: SpiderExitEvidence | null = null;
  for (const item of items) {
    if (!latest || (item.ts ?? 0) > (latest.ts ?? 0)) latest = item;
  }
  return { kind: latest ? exitKindOf(latest) : 'unknown', evidence: latest };
}

/**
 * 「高可信失败源」：原生把整个构件隔离掉了（jar 级），不是单次弱归因的短时冷却。
 *
 * P0-5 只在这一档上跳过源：冷却档是真机上一半的误判来源（低内存杀进程也会留下在途哨兵），
 * 拿它拦恢复会把"被系统清了"变成"这集打不开"。
 *
 * 命中时返回**镜像里那个真实 sourceId**：调用方手里可能只有 mediaId 推出来的小写线索，
 * 日志与提示要说清楚跳过的是哪个源，不能拿线索冒充真名。
 */
export function matchHighConfidenceBlockedSource(sourceId: string | null | undefined): string | null {
  if (!sourceId) return null;
  if (getSourceBlock(sourceId)?.kind === 'quarantined') return sourceId;
  // 只有 mediaId 线索时与真实 id 最多差在大小写：按整串不区分大小写比，不做前缀模糊比（会误杀同前缀的其它源）
  const lowered = sourceId.toLowerCase();
  for (const entry of sourceBlockSnapshot()) {
    if (entry.kind !== 'quarantined') continue;
    if (entry.sourceId.toLowerCase() === lowered) return entry.sourceId;
  }
  return null;
}

export function isHighConfidenceBlockedSource(sourceId: string | null | undefined): boolean {
  return matchHighConfidenceBlockedSource(sourceId) !== null;
}
