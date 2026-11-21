/**
 * 设置服务（API-10）
 *
 * 存储：`kv` 表 key = `app-settings`（KV_KEY_SETTINGS）。
 * - `get()` 不存在时写入默认值（含 `complianceVersion = COMPLIANCE_VERSION`）；
 * - `update()` 深合并（仅 player.subtitle / player / gesture / download 走深合并，其余整体覆盖）；
 * - `schemaVersion` 禁止外部修改。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { blobRepo } from '@/db/repositories/blobRepo';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { withTx } from '@/db/index';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { appEvents } from '@/services/events';
import { COMPLIANCE_VERSION, KV_KEY_SETTINGS, SEARCH_HISTORY_MAX } from '@/shared/constants';
import { SEARCH_BUDGET_DEFAULT, isSearchBudgetPreset } from '@/shared/searchBudget';
import { AppError } from '@/shared/errors';
import type { AppSettings, BackupSettings, DanmakuSettings, DeepPartial, DownloadSettings, GestureSettings, PlayerSettings } from '@/types';

/**
 * v3：剔除废弃字段（见 `DROPPED_KEYS`）。
 * 旧库靠这里触发一次性重写落盘，v1→v2 的弹幕默认开启逻辑保留在 `load()` 的分支里。
 */
const SCHEMA_VERSION = 3;

/**
 * EXT-05：备份增强默认值。
 *
 * 故意不 import `backupService`（后者依赖本服务，反向引用会形成循环），
 * 数值口径与 `backupService.BACKUP_RETENTION_*` / `defaultBackupSettings()` 保持一致：
 * 保留 5 份、每天 03:00、周一。
 */
const BACKUP_DEFAULTS: BackupSettings = {
  scheduleMode: 'off',
  scheduleHour: 3,
  scheduleWeekday: 1,
  retentionCount: 5,
  encryptionEnabled: false,
  encryptionSalt: null,
  encryptionVerifier: null,
  lastScheduledAt: null,
  lastBackupAt: null,
  lastError: null,
};

const BACKUP_RETENTION_MIN = 1;
const BACKUP_RETENTION_MAX = 20;

/** 归一化备份设置（越界回落默认，避免脏数据让 UI/调度器崩） */
function sanitizeBackup(input: unknown): BackupSettings {
  const base = { ...BACKUP_DEFAULTS };
  if (!isRecord(input)) return base;
  const mode = input['scheduleMode'];
  base.scheduleMode = mode === 'daily' || mode === 'weekly' ? mode : 'off';

  const hour = Number(input['scheduleHour']);
  base.scheduleHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : BACKUP_DEFAULTS.scheduleHour;

  const weekday = Number(input['scheduleWeekday']);
  base.scheduleWeekday = Number.isFinite(weekday)
    ? Math.min(7, Math.max(1, Math.floor(weekday)))
    : BACKUP_DEFAULTS.scheduleWeekday;

  const retention = Number(input['retentionCount']);
  base.retentionCount = Number.isFinite(retention)
    ? Math.min(BACKUP_RETENTION_MAX, Math.max(BACKUP_RETENTION_MIN, Math.floor(retention)))
    : BACKUP_DEFAULTS.retentionCount;

  base.encryptionEnabled = Boolean(input['encryptionEnabled']);
  base.encryptionSalt = typeof input['encryptionSalt'] === 'string' && input['encryptionSalt'].length > 0
    ? input['encryptionSalt']
    : null;
  base.encryptionVerifier = typeof input['encryptionVerifier'] === 'string' && input['encryptionVerifier'].length > 0
    ? input['encryptionVerifier']
    : null;
  // 没有 salt/校验块就不认为"已开启加密"，防止 UI 显示开启但无法产出 .enc
  if (!base.encryptionSalt || !base.encryptionVerifier) base.encryptionEnabled = false;

  const lastScheduledAt = Number(input['lastScheduledAt']);
  base.lastScheduledAt = Number.isFinite(lastScheduledAt) && lastScheduledAt > 0 ? lastScheduledAt : null;
  const lastBackupAt = Number(input['lastBackupAt']);
  base.lastBackupAt = Number.isFinite(lastBackupAt) && lastBackupAt > 0 ? lastBackupAt : null;
  base.lastError = typeof input['lastError'] === 'string' && input['lastError'].length > 0 ? input['lastError'] : null;
  return base;
}

export function defaultSettings(now: number = Date.now()): AppSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: 'system',
    complianceVersion: COMPLIANCE_VERSION,
    complianceAcceptedAt: null,
    defaultSourceId: null,
    hideDemoContent: false,
    player: {
      defaultRate: 1,
      autoPlayNext: true,
      seekStepSec: 10,
      longPressRate: 2,
      subtitle: {
        size: 'medium',
        color: 'white',
        background: 'black',
        offsetSec: 0,
        preferredLang: null,
      },
      lastVolume: 100,
      resizeMode: 'contain',
      autoSkipIntro: true,
      /* G-A03：磁吸默认开一档（60）；0 = 完全关闭，与功能上线前一致 */
      seekDetent: 60,
      /* G-A09：捏合切画幅默认开；关掉后第二指回到不做任何事 */
      pinchResizeEnabled: true,
      ambilight: true,
      ambilightIntensity: 85,
      /* B2：后台播放默认关，保持既有「切后台即暂停」行为 */
      backgroundPlayback: false,
    },
    gesture: { sensitivity: 'medium', seekMaxSec: 90 },
    download: {
      concurrency: 2,
      wifiOnly: false,
      autoResume: true,
      speedLimit: 'unlimited',
      segmentConcurrency: 6,
      /* EXT-04：转封装 / 字幕随片 / 默认清晰度 / 队列上限（全部可选字段，老配置深合并即读） */
      remuxToMp4: true,
      attachSubtitles: 'preferred',
      hlsQuality: 'max',
      maxQueueTasks: 200,
    },
    searchHistory: [],
    /* v1.7 增量（CHG-22/24/21） */
    showRecommendedSubscriptions: true,
    experimentalNativePlayer: true,
    danmaku: {
      enabled: true,
      fontSize: 16,
      opacity: 0.8,
      speed: 1,
      areaPercent: 50,
      merge: true,
      safeBottomPercent: 15,
      bold: false,
      strokeStyle: 'shadow',
      density: 'normal',
      filterTop: false,
      filterBottom: false,
      interactive: true,
      autoContrast: true,
      rhythmBand: true,
    },
    /* v1.8/P4：网盘画质与线程配置 */
    netdisk: {
      quality: 'auto',
      threadCount: 4,
    },
    /* OPT-03：触觉反馈开关（默认开启） */
    hapticEnabled: true,
    /* 彩蛋池：趣味彩蛋总开关（默认开启） */
    easterEggsEnabled: true,
    /* OPT-06：自动进入画中画（默认关闭，避免用户误触） */
    pipAutoEnter: false,
    /* OPT-04：搜索超时预算（standard = 既有 5s/8s/20s 单源超时） */
    searchBudget: SEARCH_BUDGET_DEFAULT,
    /* OPT-15：智能预加载（默认关闭） */
    smartPreloadEnabled: false,
    /* OPT-15：预加载存储上限（默认 1GB = 1024MB） */
    preloadStorageLimitMb: 1024,
    /* 批次2-6：后台探测线路开关（默认开） */
    backgroundLineProbeEnabled: true,
    /* EXT-05 phase1：定时备份 / 版本保留 / 加密 */
    backup: { ...BACKUP_DEFAULTS },
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅对对象型字段做一层/多层深合并；数组与基本类型整体替换 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isRecord(base) || !isRecord(patch)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/** OPT-15: 校验预加载存储上限（合法值：0=无限制, 500, 1024, 2048, 5120） */
const PRELOAD_LIMITS = [0, 500, 1024, 2048, 5120] as const;
function validatePreloadLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return (PRELOAD_LIMITS as readonly number[]).includes(value) ? value : fallback;
}

/**
 * 已废弃的设置键：类型里删掉了，但老库与老备份里的残值会随 `{ ...defaults, ...input }`
 * 回流并重新落盘，所以每次 sanitize 主动剔除。
 *
 * - `locale`：项目无 i18n，此前被无条件归一成 'zh-CN'，等于一个永不可用的字段；
 * - `player.defaultQuality`：无 UI 无读取，起播档位恒为 auto、线路排序不看用户偏好；
 * - `player.subtitle.enabled`：零读取，字幕开关的真实载体是运行时的活动轨道 id。
 */
const DROPPED_KEYS = {
  root: ['locale'],
  player: ['defaultQuality'],
  subtitle: ['enabled'],
} as const;

function pruneDropped(target: object, keys: readonly string[]): void {
  for (const key of keys) delete (target as Record<string, unknown>)[key];
}

/** 校正设置的合法域（越界值回落到默认，避免 UI 崩溃） */
function sanitize(input: AppSettings): AppSettings {
  const defaults = defaultSettings(input.updatedAt);
  const playerPatch = input.player as Partial<PlayerSettings> | undefined;
  const gesturePatch = input.gesture as Partial<GestureSettings> | undefined;
  const downloadPatch = input.download as Partial<DownloadSettings> | undefined;

  const player: PlayerSettings = {
    ...defaults.player,
    ...(playerPatch ?? {}),
    subtitle: { ...defaults.player.subtitle, ...(playerPatch?.subtitle ?? {}) },
  };
  player.lastVolume = Math.max(0, Math.min(100, Number(player.lastVolume) || 0));
  player.subtitle.offsetSec = Math.max(-5, Math.min(5, Number(player.subtitle.offsetSec) || 0));
  // 画面比例模式：非法值回落默认
  const VALID_RESIZE_MODES = ['contain', 'cover', 'fill'] as const;
  player.resizeMode = VALID_RESIZE_MODES.includes(player.resizeMode as typeof player.resizeMode)
    ? player.resizeMode
    : 'contain';
  // 只有显式 false 才算关掉：旧设置库里没有这个字段，回落默认（开）
  player.autoSkipIntro = player.autoSkipIntro !== false;
  player.ambilight = player.ambilight !== false;
  const ambilightLevel = Number(player.ambilightIntensity);
  player.ambilightIntensity = Number.isFinite(ambilightLevel)
    ? Math.max(0, Math.min(100, ambilightLevel))
    : 85;
  // G-A03：越界/脏值回落默认档；显式的 0 是"用户主动关掉"，必须原样保留
  const detentLevel = Number(player.seekDetent);
  player.seekDetent = Number.isFinite(detentLevel)
    ? Math.max(0, Math.min(100, Math.round(detentLevel)))
    : 60;
  // G-A09：只有显式 false 才算关掉（旧设置库里没有这个字段，回落默认「开」）
  player.pinchResizeEnabled = player.pinchResizeEnabled !== false;
  // 只有显式 true 才算开启：旧设置库里没有这个字段
  player.backgroundPlayback = player.backgroundPlayback === true;
  pruneDropped(player.subtitle, DROPPED_KEYS.subtitle);
  pruneDropped(player, DROPPED_KEYS.player);

  const gesture: GestureSettings = { ...defaults.gesture, ...(gesturePatch ?? {}) };
  gesture.seekMaxSec = Math.max(30, Math.min(180, Number(gesture.seekMaxSec) || defaults.gesture.seekMaxSec));

  const download: DownloadSettings = { ...defaults.download, ...(downloadPatch ?? {}) };
  download.concurrency = ([1, 2, 3] as const).includes(download.concurrency) ? download.concurrency : 2;
  // P0-6: segmentConcurrency 合法值校验
  download.segmentConcurrency = ([3, 6, 8] as const).includes(download.segmentConcurrency as 3 | 6 | 8)
    ? download.segmentConcurrency
    : 6;
  // EXT-04：越界回落（AC-149 档位持久化、FR-62 清晰度、FR-61 队列上限、FR-60/64 开关）
  download.speedLimit = (['low', 'medium', 'high', 'unlimited'] as const).includes(
    download.speedLimit as 'low' | 'medium' | 'high' | 'unlimited',
  )
    ? download.speedLimit
    : 'unlimited';
  download.remuxToMp4 = typeof download.remuxToMp4 === 'boolean' ? download.remuxToMp4 : true;
  download.attachSubtitles = (['preferred', 'all', 'none'] as const).includes(
    download.attachSubtitles as 'preferred' | 'all' | 'none',
  )
    ? download.attachSubtitles
    : 'preferred';
  download.hlsQuality = (['max', '1080p', '720p'] as const).includes(
    download.hlsQuality as 'max' | '1080p' | '720p',
  )
    ? download.hlsQuality
    : 'max';
  download.maxQueueTasks = ([50, 100, 200, 500] as const).includes(
    download.maxQueueTasks as 50 | 100 | 200 | 500,
  )
    ? download.maxQueueTasks
    : 200;

  const danmakuPatch = input.danmaku as Partial<DanmakuSettings> | undefined;
  const danmaku: DanmakuSettings = { ...defaults.danmaku!, ...(danmakuPatch ?? {}) };
  danmaku.fontSize = Math.max(10, Math.min(36, Number(danmaku.fontSize) || 16));
  danmaku.opacity = Math.max(0.1, Math.min(1, Number(danmaku.opacity) || 0.8));
  danmaku.speed = Math.max(0.5, Math.min(3, Number(danmaku.speed) || 1));
  danmaku.areaPercent = Math.max(10, Math.min(100, Number(danmaku.areaPercent) || 50));
  danmaku.safeBottomPercent = Math.max(0, Math.min(50, Number(danmaku.safeBottomPercent) || 0));
  danmaku.merge = Boolean(danmaku.merge);
  danmaku.enabled = Boolean(danmaku.enabled);
  danmaku.bold = Boolean(danmaku.bold);
  if (!['none', 'shadow', 'outline'].includes(danmaku.strokeStyle)) danmaku.strokeStyle = 'shadow';
  if (!['sparse', 'normal', 'dense'].includes(danmaku.density)) danmaku.density = 'normal';
  danmaku.filterTop = Boolean(danmaku.filterTop);
  danmaku.filterBottom = Boolean(danmaku.filterBottom);
  danmaku.interactive = danmaku.interactive !== false;
  // 缺省即开：老设置里没有这个键，第一次读到也要带上（关掉它才会退回旧行为）
  danmaku.autoContrast = danmaku.autoContrast !== false;
  // 节奏带同样缺省即开；它没有独立取样路，取样关掉时 PlayerView 会把带子一起收掉
  danmaku.rhythmBand = danmaku.rhythmBand !== false;

  const merged: AppSettings = {
    ...defaults,
    ...input,
    schemaVersion: SCHEMA_VERSION,
    complianceVersion:
      typeof input.complianceVersion === 'number' && Number.isFinite(input.complianceVersion)
        ? input.complianceVersion
        : defaults.complianceVersion,
    complianceAcceptedAt:
      typeof input.complianceAcceptedAt === 'number' && input.complianceAcceptedAt > 0
        ? input.complianceAcceptedAt
        : null,
    hideDemoContent: Boolean(input.hideDemoContent),
    showRecommendedSubscriptions: input.showRecommendedSubscriptions === undefined ? true : Boolean(input.showRecommendedSubscriptions),
    experimentalNativePlayer: Boolean(input.experimentalNativePlayer),
    hapticEnabled: input.hapticEnabled === undefined ? true : Boolean(input.hapticEnabled),
    easterEggsEnabled: input.easterEggsEnabled === undefined ? true : Boolean(input.easterEggsEnabled),
    pipAutoEnter: input.pipAutoEnter === undefined ? false : Boolean(input.pipAutoEnter),
    // OPT-04：未知档位回落标准（旧设置/手改数据不会让搜索卡在非法预算上）
    searchBudget: isSearchBudgetPreset(input.searchBudget) ? input.searchBudget : SEARCH_BUDGET_DEFAULT,
    smartPreloadEnabled: input.smartPreloadEnabled === undefined ? false : Boolean(input.smartPreloadEnabled),
    preloadStorageLimitMb: validatePreloadLimit(input.preloadStorageLimitMb, defaults.preloadStorageLimitMb!),
    backgroundLineProbeEnabled: input.backgroundLineProbeEnabled === undefined ? true : Boolean(input.backgroundLineProbeEnabled),
    backup: sanitizeBackup(input.backup),
    danmaku,
    searchHistory: Array.isArray(input.searchHistory)
      ? input.searchHistory.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, SEARCH_HISTORY_MAX)
      : [],
    player,
    gesture,
    download,
  };
  pruneDropped(merged, DROPPED_KEYS.root);
  return merged;
}

/** 当前设置结构版本：备份写入与恢复校验都以此为唯一口径，避免两处各写一个数字 */
export const SETTINGS_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * 备份读写用的设置快照：走一遍 sanitize，顺手剔掉废弃字段的残值
 * （`locale` / `player.defaultQuality` / `player.subtitle.enabled`），
 * 免得旧备份把已删字段一路带回新库。
 */
export function settingsForBackup(settings: AppSettings): AppSettings {
  return sanitize(settings);
}

let cached: AppSettings | null = null;

/**
 * 写队列：所有改设置的调用串行执行。
 *
 * 每个写操作都是「读全量 → 合并 → 整份落库」，两次并发调用会读到同一份 `current`，
 * 后写的那次把先写的整份盖掉 —— 丢的不只是同一个字段，而是对方整轮改动。
 * 真实撞车点：连续敲搜索词（`pushSearchHistory`）、退出播放页时同时写音量与恢复位置、
 * 合规同意撞上主题切换、备份导入边写设置边写其它域。
 * IndexedDB 没有跨事务的字段级更新，只能在服务内排队。
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  // 队列本身必须对失败免疫，否则一次抛错会让后续所有写永久卡死
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function load(): Promise<AppSettings> {
  if (cached) return cached;
  const stored = await kvRepo.get<AppSettings>(KV_KEY_SETTINGS);
  if (!stored) {
    const fresh = defaultSettings();
    await kvRepo.set(KV_KEY_SETTINGS, fresh);
    cached = fresh;
    return fresh;
  }
  if (stored.schemaVersion !== SCHEMA_VERSION) {
    // 旧版本设置：代码层兼容（补默认值），不删数据
    const base = { ...defaultSettings(), ...stored };
    // v1 → v2：弹幕接入 B 站直连，旧默认「关闭」只是因为没有可用弹幕源，升级时开启一次
    if ((stored.schemaVersion ?? 0) < 2) {
      base.danmaku = { ...defaultSettings().danmaku!, ...stored.danmaku, enabled: true };
    }
    const migrated = sanitize(base);
    await kvRepo.set(KV_KEY_SETTINGS, migrated);
    cached = migrated;
    return migrated;
  }
  const normalized = sanitize(stored);
  cached = normalized;
  return normalized;
}

async function persist(next: AppSettings): Promise<AppSettings> {
  await kvRepo.set(KV_KEY_SETTINGS, next);
  cached = next;
  return next;
}

export const settingsService = {
  async get(): Promise<AppSettings> {
    return load();
  },

  async update(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
    if (isRecord(patch) && 'schemaVersion' in patch) {
      const incoming = (patch as { schemaVersion?: unknown }).schemaVersion;
      if (incoming !== undefined && incoming !== SCHEMA_VERSION) {
        throw new AppError('E_INVALID_INPUT', 'schemaVersion 不允许修改');
      }
    }
    return enqueue(async () => {
      const current = await load();
      const merged = sanitize(deepMerge(current, patch));
      merged.updatedAt = Date.now();
      const next = await persist(merged);
      appEvents.emit('settings:changed', { patch: (patch ?? {}) as Record<string, unknown> });
      return next;
    });
  },

  async reset(): Promise<AppSettings> {
    return enqueue(async () => {
      const fresh = defaultSettings();
      const next = await persist(fresh);
      appEvents.emit('settings:changed', { patch: {} });
      return next;
    });
  },

  async acceptCompliance(version: number): Promise<void> {
    await enqueue(async () => {
      const current = await load();
      const next: AppSettings = {
        ...current,
        complianceVersion: Math.max(current.complianceVersion, version),
        complianceAcceptedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await persist(next);
      appEvents.emit('settings:changed', { patch: { complianceVersion: next.complianceVersion } });
    });
  },

  async isComplianceAccepted(version: number): Promise<boolean> {
    const current = await load();
    return current.complianceAcceptedAt !== null && current.complianceVersion >= version;
  },

  async pushSearchHistory(keyword: string): Promise<string[]> {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) return (await load()).searchHistory;
    return enqueue(async () => {
      const current = await load();
      const next = [trimmed, ...current.searchHistory.filter((k) => k !== trimmed)].slice(0, SEARCH_HISTORY_MAX);
      const updated = await persist({ ...current, searchHistory: next, updatedAt: Date.now() });
      return updated.searchHistory;
    });
  },

  async clearSearchHistory(): Promise<void> {
    await enqueue(async () => {
      const current = await load();
      await persist({ ...current, searchHistory: [], updatedAt: Date.now() });
    });
  },

  /** OPT-07：删除单条搜索历史 */
  async removeSearchHistoryItem(keyword: string): Promise<string[]> {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) return (await load()).searchHistory;
    return enqueue(async () => {
      const current = await load();
      const next = current.searchHistory.filter((k) => k !== trimmed);
      const updated = await persist({ ...current, searchHistory: next, updatedAt: Date.now() });
      return updated.searchHistory;
    });
  },

  /**
   * 清空业务数据（源/媒体/线路/剧集/分类/历史/收藏/下载/Blob + 弹幕/EPG 缓存 + 节目提醒），
   * 可选保留演示源与演示条目。
   * 设置本身（主题、搜索历史、合规状态）保留；`keepDemo` 为 true 时重新种入演示数据。
   *
   * 「清空全部」语义（OPT-02）：连弹幕/EPG 缓存与节目提醒一并清除，避免旧源数据残留被新订阅误命中。
   * 直播清单（lives）、EPG 源配置（epgSources）、频道偏好（channelPrefs）属于用户配置，不在清空范围。
   *
   * 所有表在**同一个事务**内清空：所有 repo 必须传 `tx`，否则内部自开事务会让外层事务
   * 提前提交，后续写入抛 `InvalidStateError` 并留下"半清空"数据（REV-02）。
   */
  async resetAllData(opts: { keepDemo: boolean }): Promise<void> {
    await withTx(
      [
        'sources', 'media', 'lines', 'episodes', 'categories', 'history', 'favorites',
        'downloads', 'blobs', 'danmakuCache', 'epgCache', 'reminders',
      ],
      'readwrite',
      async (tx) => {
        await sourceRepo.clear(tx);
        await mediaRepo.clear(tx);
        await lineRepo.clear(tx);
        await episodeRepo.clear(tx);
        await categoryRepo.clear(tx);
        await historyRepo.clear(tx);
        await favoriteRepo.clear(tx);
        await downloadRepo.clear(tx);
        // blobs / 缓存 / 提醒也在此事务内（tx 已包含这些 store）
        await tx.objectStore('blobs').clear();
        await tx.objectStore('danmakuCache').clear();
        await tx.objectStore('epgCache').clear();
        await tx.objectStore('reminders').clear();
      },
    ).catch((e: unknown) => {
      throw e instanceof AppError ? e : new AppError('E_DB', undefined, { detail: String(e) });
    });

    if (opts.keepDemo) {
      // 重新种入演示源与演示条目（AC-99）：演示源、分类、12 条媒体、线路与剧集
      await seedDemoData({ sourceId: DEMO_SOURCE_ID, restore: true });
    }
    await enqueue(async () => {
      const current = await load();
      await persist({ ...current, defaultSourceId: null, updatedAt: Date.now() });
    });
    appEvents.emit('sources:changed', { reason: 'remove' });
    appEvents.emit('history:changed', { id: null });
    appEvents.emit('favorites:changed', { id: null });
    appEvents.emit('downloads:changed', { id: null });
  },

  /** 存储统计（设置页展示；Web 端 blobs + 下载任务记录） */
  async storageStats(): Promise<{ blobsBytes: number; blobCount: number; downloadBytes: number; itemCount: number }> {
    const [blobsBytes, blobCount, summary, itemCount] = await Promise.all([
      blobRepo.totalBytes(),
      blobRepo.count(),
      downloadRepo.summary(),
      mediaRepo.count(),
    ]);
    return { blobsBytes, blobCount, downloadBytes: summary.downloadedBytes, itemCount };
  },

  /** 测试辅助：清空内存缓存 */
  __resetCache(): void {
    cached = null;
  },
};

export type SettingsService = typeof settingsService;
