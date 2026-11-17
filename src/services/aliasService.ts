/**
 * 本地别名表（SO-ALIAS 存储层）
 *
 * 学习信号只有一个且完全本地：**用户搜 A、点了片名 B** —— 这是"这两个形态指同一部片"
 * 的最强证据（点击即确认）。豆瓣详情不带别名字段，本批次不引入任何新的网络来源，
 * 别名只在设备上生长、随备份一起留在设备上，不上传。
 *
 * 结构：`normalizeTitleKey(片名根) → { canonical, titles[], updatedAt }`，双向写入
 * （搜简称得全称、搜全称得简称）。桶数与每桶形态数都有硬上限，按最久未学淘汰；
 * `pauseHistoryRecording`（隐私总开关）打开时既学也不读。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { settingsService } from '@/services/settingsService';
import { normalizeTitleKey, titleMatchScore } from '@/sources/mapping/TitleNormalizer';
import { canonicalizeQuery } from '@/services/queryExpansion';
import { KV_KEY_SEARCH_ALIASES } from '@/shared/constants';
import { logger } from '@/shared/logger';

interface AliasBucket {
  /** 首次写入时的片面（仅用于展示与调试） */
  canonical: string;
  /** 已学习的片面形态（含 canonical 自身之外的替代写法） */
  titles: string[];
  updatedAt: number;
}

type AliasTable = Record<string, AliasBucket>;

/** 桶总数上限：按编辑成本取 300，覆盖重度用户全部在追的片绰绰有余 */
const MAX_BUCKETS = 300;
/** 单桶形态数上限 */
const MAX_TITLES_PER_BUCKET = 6;
/** 关键词/片面的长度围栏，脏数据不进表 */
const SURFACE_MIN = 2;
const SURFACE_MAX = 40;

function putTitle(bucket: AliasBucket, surface: string): void {
  const key = normalizeTitleKey(surface);
  if (bucket.titles.some((t) => normalizeTitleKey(t) === key)) return;
  bucket.titles.push(surface);
  if (bucket.titles.length > MAX_TITLES_PER_BUCKET) bucket.titles.shift();
}

function prune(table: AliasTable): void {
  const keys = Object.keys(table);
  if (keys.length <= MAX_BUCKETS) return;
  keys
    .sort((a, b) => (table[a]?.updatedAt ?? 0) - (table[b]?.updatedAt ?? 0))
    .slice(0, keys.length - MAX_BUCKETS)
    .forEach((k) => delete table[k]);
}

async function readTable(): Promise<AliasTable> {
  const raw = await kvRepo.get<unknown>(KV_KEY_SEARCH_ALIASES);
  if (!raw || typeof raw !== 'object') return {};
  const table: AliasTable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const bucket = value as Partial<AliasBucket>;
    if (typeof bucket.canonical !== 'string') continue;
    const titles = Array.isArray(bucket.titles)
      ? bucket.titles.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];
    table[key] = {
      canonical: bucket.canonical,
      titles: titles.slice(0, MAX_TITLES_PER_BUCKET),
      updatedAt: typeof bucket.updatedAt === 'number' ? bucket.updatedAt : 0,
    };
  }
  return table;
}

/**
 * 学习一对「搜索词 → 点击片名」。
 * 返回是否写入（等价形态/越界/隐私开启都静默跳过）。
 */
export async function learnPair(query: string, clickedTitle: string): Promise<boolean> {
  try {
    const settings = await settingsService.get();
    if (settings.pauseHistoryRecording) return false;
    const q = canonicalizeQuery(query);
    const t = canonicalizeQuery(clickedTitle);
    if (q.length < SURFACE_MIN || q.length > SURFACE_MAX) return false;
    if (t.length < SURFACE_MIN || t.length > SURFACE_MAX) return false;
    const keyQ = normalizeTitleKey(q);
    const keyT = normalizeTitleKey(t);
    if (keyQ.length === 0 || keyT.length === 0 || keyQ === keyT) return false;
    // 防呆：完全不像的形态不学（如误点到推荐位别的片）
    if (titleMatchScore(q, t) < 0.3) return false;
    const table = await readTable();
    const now = Date.now();
    const bucketT = table[keyT] ?? { canonical: t, titles: [], updatedAt: 0 };
    putTitle(bucketT, q);
    table[keyT] = { ...bucketT, updatedAt: now };
    const bucketQ = table[keyQ] ?? { canonical: q, titles: [], updatedAt: 0 };
    putTitle(bucketQ, t);
    table[keyQ] = { ...bucketQ, updatedAt: now };
    prune(table);
    await kvRepo.set(KV_KEY_SEARCH_ALIASES, table);
    return true;
  } catch (e) {
    logger.debug('别名学习失败（不影响搜索）', { error: (e as Error)?.message });
    return false;
  }
}

/**
 * 查询关键词的已学别名形态（不含与关键词自身等价者，由调用方再去重）。
 * 命中口径：关键词片名根 == 桶键，或等于桶内某形态（反查该桶全部形态）。
 */
export async function lookupAliases(keyword: string, limit = 2): Promise<string[]> {
  try {
    const settings = await settingsService.get();
    if (settings.pauseHistoryRecording) return [];
    const base = normalizeTitleKey(canonicalizeQuery(keyword));
    if (base.length === 0) return [];
    const table = await readTable();
    const out: string[] = [];
    const seen = new Set<string>([base]);
    const collect = (bucket: AliasBucket): void => {
      for (const surface of [bucket.canonical, ...bucket.titles]) {
        const key = normalizeTitleKey(surface);
        if (key.length === 0 || seen.has(key)) continue;
        seen.add(key);
        out.push(surface);
        if (out.length >= limit) return;
      }
    };
    const direct = table[base];
    if (direct) collect(direct);
    if (out.length < limit) {
      for (const bucket of Object.values(table)) {
        if (bucket.titles.some((t) => normalizeTitleKey(t) === base) || normalizeTitleKey(bucket.canonical) === base) {
          collect(bucket);
          if (out.length >= limit) break;
        }
      }
    }
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

/** 清空别名表（隐私操作 / 测试） */
export async function clearAliases(): Promise<void> {
  await kvRepo.delete(KV_KEY_SEARCH_ALIASES);
}
