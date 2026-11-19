/**
 * 确定性爬虫加载失败账本（P1-2）
 *
 * 日志里的形态：同一个坏规则/坏 jar 每轮冷启动都被重新下载、重新加载、重新失败一遍
 * （真机实测 `csp_PanWebShare` 抛 `IncompatibleClassChangeError`，解除隔离也救不活——
 * 它不是崩溃保护误伤，是 jar 与当前运行时二进制不兼容）。这类失败与网络无关：
 * 地址、类名、字节码兼容性没变，重跑一百次结果一样，只会占用爬虫池和搜索预算。
 *
 * 只记「同一输入必然同样失败」的三类：
 * - 类/方法缺失或二进制不兼容（缺类、缺方法、类型转换、校验期 `VerifyError`）；
 * - jar 完整性与体积（md5 校验不过、超过加载上限）——按 `jarUrl`（含 `;md5;` 后缀）记账，
 *   源站换文件即视为新版本；
 * - 规则脚本语法/引用错误（drpy 脚本自身写坏）。
 * 明确排除：401/403/404/5xx、DNS、连接与加载超时、源忙、HTML 伪响应，以及隔离/冷却/安全模式
 * 本身——那些是高波动或保护态，禁用它们就是把「临时不通」写成永久拉黑。
 *
 * 记账口径是 `源 key + 失败种类 + 规则或 jar 版本 + App 运行时版本`（见 fingerprintOf）。
 * 任一维度变化都自动失效，不需要过期时间：订阅更新、源站换文件、App 升级都会重跑一次，
 * 剩下的「显式复检」入口由健康中心提供。作用范围只到**跳过后台预热**——真实搜索照常发起，
 * 判错种类也不会让用户拿不到结果。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { APP_VERSION } from '@/shared/constants';
import { logger } from '@/shared/logger';
import type { Source } from '@/types';

/** `kv` store 中的键名 */
export const KV_KEY_SPIDER_LOAD_FAILURES = 'spider_load_failures';

/** 可确定的加载失败种类 */
export type DeterministicLoadKind = 'class_incompatible' | 'jar_integrity' | 'script_syntax';

export interface SpiderLoadFailure {
  /** `Source.key`（订阅里的稳定标识，重复导入不变）；无 key 时退回 `baseUrl` */
  sourceKey: string;
  kind: DeterministicLoadKind;
  /** 规则或 jar 的版本标识：jar 为 `jarUrl`（含 `;md5;` 后缀），drpy 为规则地址 */
  target: string;
  /** 记账时的 App 版本：升级后本条自然失效 */
  runtime: string;
  /** 原生侧原始 message（截断），只用于给用户看清"为什么跳过" */
  message: string;
  seenAt: number;
}

/** 账本上限：源数量级远小于这个数，纯粹防止异常堆积 */
const MAX_RECORDS = 300;
const MESSAGE_MAX_LENGTH = 220;

/**
 * 原生 message → 确定性失败种类；判不准就返回 null（宁可多跑一次，也不要把好源写死）。
 *
 * 顺序有讲究：先排掉高波动与保护态，再匹配确定性特征。
 */
export function classifyDeterministicLoadFailure(rawMessage: string): DeterministicLoadKind | null {
  const message = rawMessage || '';
  if (!message) return null;
  // 保护态与高波动一律不记账：这些恰恰是「下次可能就好了」
  if (/quarantined|cooling down|safe mode/i.test(message)) return null;
  if (/超时|timeout|源忙|busy/i.test(message)) return null;
  if (/HTTP\s*[45]\d\d/i.test(message)) return null;
  if (/HTML\s*页面/i.test(message)) return null;
  if (/UnknownHost|Connection (refused|reset|closed)|ECONN|ENETWORK|network/i.test(message)) return null;

  // jar 与当前运行时二进制不兼容 / 缺类缺方法：同一 jar + 同一 App 版本必然复现
  if (
    /ClassNotFound|NoClassDefFound|NoSuchMethod|NoSuchField|ClassCastException|IncompatibleClassChange|UnsupportedClassVersion|VerifyError|BadClassFile|ExceptionInInitializer/i.test(
      message,
    )
  ) {
    return 'class_incompatible';
  }
  // 只认「校验不过」这件事本身：jar 地址天然带 `;md5;串` 后缀，裸匹配会把
  // `FileNotFoundException: http://.../pro.jar;md5;xxx` 这类下载失败也记成完整性故障，
  // 于是好源被写死。原生侧的实文案是 `jar md5 mismatch`（SecurityException）。
  if (/md5\s*(mismatch|不匹配|校验失败|invalid|error|fail)|jar too large/i.test(message)) {
    return 'jar_integrity';
  }
  // drpy 脚本自身写坏：语法/引用错误与网络无关
  if (
    /SyntaxError|unexpected token|expecting|is not defined|Invalid language|JSON\.parse/i.test(message)
  ) {
    return 'script_syntax';
  }
  return null;
}

/** 记账/比对用的唯一键：任一维度（源、版本、运行时）变了就不算同一条 */
export function fingerprintOf(
  f: Pick<SpiderLoadFailure, 'sourceKey' | 'target' | 'runtime'>,
): string {
  return `${f.sourceKey}|${f.target}|${f.runtime}`;
}

/** 源的稳定标识：优先用订阅 key（重复导入不变），手工源没有 key 时退回根地址 */
export function sourceLedgerKey(
  source: Pick<Source, 'id' | 'key' | 'baseUrl'>,
): string {
  return source.key?.trim() || source.baseUrl?.trim() || source.id;
}

async function readAll(): Promise<SpiderLoadFailure[]> {
  try {
    const rows = await kvRepo.get<SpiderLoadFailure[]>(KV_KEY_SPIDER_LOAD_FAILURES);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    logger.debug('读取爬虫加载失败账本失败（按空账本处理）', e);
    return [];
  }
}

/**
 * 记下一条确定性失败。
 *
 * 跳过与否看的是「有没有」，不是「几次」，所以同一 `源 + 版本` 只留最新一条；
 * 同一源也只留最新那条版本（源站/订阅换了 jar 地址后，旧地址的记录既判不了死也没处可查）。
 */
export async function noteLoadFailure(
  source: Pick<Source, 'id' | 'key' | 'baseUrl'>,
  kind: DeterministicLoadKind,
  target: string,
  message: string,
): Promise<void> {
  const record: SpiderLoadFailure = {
    sourceKey: sourceLedgerKey(source),
    kind,
    target,
    runtime: APP_VERSION,
    message: (message || '').slice(0, MESSAGE_MAX_LENGTH),
    seenAt: Date.now(),
  };
  try {
    const rows = await readAll();
    const byFingerprint = new Map<string, SpiderLoadFailure>();
    for (const row of [...rows, record]) {
      // App 升级后旧运行时的记录没有判断力，直接丢，省得列表里堆一堆看不懂的历史
      if (row.runtime !== APP_VERSION) continue;
      const fp = fingerprintOf(row);
      const prev = byFingerprint.get(fp);
      if (!prev || prev.seenAt <= row.seenAt) byFingerprint.set(fp, row);
    }
    const newestPerSource = new Map<string, SpiderLoadFailure>();
    for (const row of byFingerprint.values()) {
      const prev = newestPerSource.get(row.sourceKey);
      if (!prev || prev.seenAt < row.seenAt) newestPerSource.set(row.sourceKey, row);
    }
    const next = [...newestPerSource.values()].sort((a, b) => a.seenAt - b.seenAt);
    await kvRepo.set(KV_KEY_SPIDER_LOAD_FAILURES, next.slice(-MAX_RECORDS));
  } catch (e) {
    logger.debug('写入爬虫加载失败账本失败（忽略）', e);
  }
}

/** 该源在这一版 jar/规则上是否已被判为确定性坏源；命中时返回记录供跳过决策与文案使用 */
export async function findSuppressedLoadFailure(
  source: Pick<Source, 'id' | 'key' | 'baseUrl'>,
  target: string,
): Promise<SpiderLoadFailure | null> {
  const rows = await readAll();
  const fp = fingerprintOf({ sourceKey: sourceLedgerKey(source), target, runtime: APP_VERSION });
  return rows.find((row) => fingerprintOf(row) === fp) ?? null;
}

/** 当前 App 版本下的全部账本条目（健康中心用） */
export async function listLoadFailures(): Promise<SpiderLoadFailure[]> {
  const rows = await readAll();
  return rows.filter((row) => row.runtime === APP_VERSION).sort((a, b) => b.seenAt - a.seenAt);
}

/**
 * 复检：清掉某个源的记录，让下一次预热重新真跑一遍。
 *
 * 只删账本，不动隔离名单——两者是独立的判据，一键全清会把崩溃保护一起关掉。
 */
export async function clearLoadFailure(sourceKey: string): Promise<number> {
  const rows = await readAll();
  const next = rows.filter((row) => row.sourceKey !== sourceKey);
  await kvRepo.set(KV_KEY_SPIDER_LOAD_FAILURES, next);
  return rows.length - next.length;
}

/** 账本种类的人话说明（健康中心与预热日志共用） */
export const LOAD_FAILURE_LABELS: Record<DeterministicLoadKind, string> = {
  class_incompatible: '爬虫类与当前运行人不兼容（缺类/缺方法/字节码冲突）',
  jar_integrity: 'jar 校验不通过或体积超限',
  script_syntax: '规则脚本语法错误',
};
