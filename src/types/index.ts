/* =========================================================
 * 全局类型契约 —— 冻结版本 v1.0
 * 约定：所有时间戳为毫秒 Date.now()；可空字段显式 null
 * =======================================================*/

/** EPG 节目条目定义在 `epgService`（既有契约）；此处仅做类型引用（type-only，无运行时循环依赖） */
import type { EpgProgramme } from '@/services/epgService';

export type Timestamp = number;

/* ---------- 错误 ---------- */
export type ErrorCode =
  | 'E_UNKNOWN'
  | 'E_NETWORK'
  | 'E_TIMEOUT'
  | 'E_ABORTED'
  | 'E_HTTP_400'
  | 'E_HTTP_401'
  | 'E_HTTP_403'
  | 'E_HTTP_404'
  | 'E_HTTP_429'
  | 'E_HTTP_5XX'
  | 'E_AUTH'
  | 'E_PARSE'
  | 'E_INVALID_INPUT'
  | 'E_NOT_FOUND'
  | 'E_NOT_IMPLEMENTED'
  | 'E_SOURCE_DISABLED'
  | 'E_SOURCE_UNAVAILABLE'
  | 'E_NO_PLAY_URL'
  | 'E_NETDISK_LOGIN_REQUIRED'
  | 'E_UNSUPPORTED_FORMAT'
  | 'E_DRM_PROTECTED'
  | 'E_DECODE'
  | 'E_INVALID_STATE'
  | 'E_STORAGE_QUOTA'
  | 'E_FILE_MISSING'
  | 'E_DB'
  | 'E_VERSION_UNSUPPORTED'
  | 'E_CANCELED';

export interface AppErrorShape {
  code: ErrorCode;
  message: string;
  detail: string | null;
  retryable: boolean;
  httpStatus: number | null;
}

/* ---------- 源 ---------- */
export type SourceType = 'demo' | 'alist' | 'webdav' | 'jellyfin' | 'site' | 'spider' | 'douban';

export type SourceHealth =
  | 'ok'
  | 'auth_failed'
  | 'timeout'
  | 'unreachable'
  | 'bad_config'
  | 'unknown';

export type AuthMode = 'none' | 'basic' | 'token';

export interface SourceAuth {
  mode: AuthMode;
  username: string | null;
  password: string | null;
  token: string | null;
}

export interface Source {
  /** 内部唯一 ID：demo 固定为 'demo'，其余为 uuid */
  id: string;
  /** 订阅/配置中的稳定 key，用于去重与覆盖导入 */
  key: string;
  name: string;
  type: SourceType;
  enabled: boolean;
  /** 内置源（演示源）不可删除，只能禁用 */
  builtin: boolean;
  /** 升序排序；演示源恒为 9999 */
  sort: number;
  /** 归一化后的根地址，无尾斜杠；演示源为空串 */
  baseUrl: string;
  /** 站点/媒体库的子路径，如 '/movies' */
  pathPrefix: string | null;
  auth: SourceAuth;
  /** 附加请求头，键名大小写不敏感 */
  headers: Record<string, string>;
  /** 订阅中的原始 ext 字段（已 JSON.parse）；无则 null */
  ext: Record<string, unknown> | null;
  /** 来源订阅标识（导入时生成），手工新增为 null */
  subscriptionId: string | null;
  /** 合规警示文案（命中敏感关键词时），无则 null */
  warning: string | null;
  /** v1.7/FR-51：因连续体检失败被自动禁用的时间；null/undefined = 非自动禁用 */
  autoDisabledAt?: Timestamp | null;
  health: SourceHealth;
  healthCheckedAt: Timestamp | null;
  lastErrorCode: ErrorCode | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SourceInput {
  name: string;
  type: SourceType;
  baseUrl: string;
  pathPrefix?: string | null;
  auth?: Partial<SourceAuth> | null;
  headers?: Record<string, string> | null;
  ext?: Record<string, unknown> | null;
  enabled?: boolean;
  sort?: number;
  key?: string;
}

export interface ConnectionResult {
  ok: boolean;
  latencyMs: number;
  health: SourceHealth;
  error: AppErrorShape | null;
  /** 探测到的条目数（能便宜获得时） */
  itemCount: number | null;
}

export interface HealthCheckResult {
  sourceId: string;
  health: SourceHealth;
  checkedAt: Timestamp;
  latencyMs: number;
  error: AppErrorShape | null;
}

/* ---------- 媒体 ---------- */
export type MediaType = 'movie' | 'series' | 'anime' | 'variety' | 'other';

export type MediaFormat = 'mp4' | 'hls' | 'webm' | 'ts' | 'other';

export interface MediaItem {
  /** 全局唯一：`${sourceId}:${sourceItemId}` 的 stableId */
  id: string;
  sourceId: string;
  /** 源内条目 ID */
  sourceItemId: string;
  title: string;
  originalTitle: string | null;
  type: MediaType;
  year: number | null;
  area: string | null;
  genres: string[];
  tags: string[];
  rating: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  description: string | null;
  durationSec: number | null;
  episodeCount: number | null;
  /** 搜索/筛选用小写标题 */
  titleLower: string;
  isDemo: boolean;
  cachedAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Category {
  /** `${sourceId}:${value}` */
  id: string;
  sourceId: string;
  name: string;
  /** 适配器内部值，如 'movie'、'/movies/动作' */
  value: string;
  order: number;
  /**
   * 该分类支持的服务端筛选维度（TVBox `filters` 字段解析结果）。
   * 无配置的源为 null/undefined，UI 回退到通用本地筛选（类型/年代/地区）。
   */
  filters?: FilterDimension[] | null;
}

/** 服务端筛选维度（TVBox `filters` 中一个分类的一组选项） */
export interface FilterDimension {
  /** 请求参数名，如 class / area / year / by */
  key: string;
  /** 显示名，如 类型 / 地区 / 年份 / 排序 */
  name: string;
  options: Array<{ value: string; label: string }>;
}

export interface PlayLine {
  /** `${mediaId}:${index}` */
  id: string;
  mediaId: string;
  sourceId: string;
  name: string;
  quality: string | null;
  format: MediaFormat;
  index: number;
}

export interface SubtitleTrack {
  /** 会话内唯一，如 `remote:0` / `local:1699...` */
  id: string;
  label: string;
  lang: string;
  url: string;
  format: 'vtt' | 'srt';
  source: 'remote' | 'local' | 'downloaded';
}

export interface Episode {
  /** `${mediaId}:${lineId}:${number}` 的 stableId */
  id: string;
  mediaId: string;
  sourceId: string;
  lineId: string;
  number: number;
  title: string;
  durationSec: number | null;
  subtitles: SubtitleTrack[];
  /** 原始播放地址（未解析），用于缓存避免重复 detailContent */
  rawUrl?: string;
  updatedAt: Timestamp;
}

export interface MediaDetail {
  item: MediaItem;
  lines: PlayLine[];
  /** 按 lineId 分组的全部剧集，按 number 升序 */
  episodes: Episode[];
}

export interface PlaybackSource {
  url: string;
  format: MediaFormat;
  headers: Record<string, string>;
  subtitles: SubtitleTrack[];
  lineId: string;
  quality: string | null;
  /** 直链过期时间；null 表示未知/不过期 */
  expiresAt: Timestamp | null;
  /** url 是否已指向本地文件/Blob URL */
  isLocal: boolean;
  /** v1.7/CHG-21：直播流（启用 hls.js 低延迟模式与追帧） */
  isLive?: boolean;
  /** P0-7: 续播起始位置（毫秒），0 或 undefined 表示从头播放 */
  startPositionMs?: number;
}

/* ---------- 列表查询 ---------- */
export type LibraryFilterType = 'type' | 'year' | 'area';

export interface LibraryFilters {
  type: MediaType | null;
  yearFrom: number | null;
  yearTo: number | null;
  area: string | null;
  /**
   * 服务端筛选选中值（维度 key → 选项 value），仅在当前分类带 `Category.filters`
   * 配置时由 UI 生成，site/spider 适配器透传给源；其余维度为本地筛选。
   */
  ext?: Record<string, string> | null;
}

export interface PageQuery {
  page: number;
  pageSize: number;
  signal?: AbortSignal;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number | null;
  hasMore: boolean;
}

export interface BrowseParams extends PageQuery {
  source: Source;
  categoryId: string | null;
  filters: LibraryFilters;
}

export interface SearchParams extends PageQuery {
  source: Source;
  keyword: string;
}

export interface GetDetailParams {
  source: Source;
  sourceItemId: string;
  signal?: AbortSignal;
}

export interface ResolvePlayParams {
  source: Source;
  mediaId: string;
  sourceItemId: string;
  episodeId: string;
  lineId: string;
  signal?: AbortSignal;
}

export interface SearchResult {
  items: MediaItem[];
  /** 返回结果的源 ID 列表 */
  sourceIds: string[];
  failed: Array<{ sourceId: string; error: AppErrorShape }>;
  /** CHG-15：实际参与远程搜索的源数量；0 时结果不可信，UI 需给出诊断 */
  candidates: number;
  /** 因体检失效/类型不支持/关闭搜索被过滤掉的启用源数量 */
  filteredOut: number;
  /** v1.7/CHG-20：按「归一化片名+年份」聚合的分组视图（items 为组内按源质量排序的条目） */
  groups?: SearchResultGroup[];
}

/** v1.7/CHG-20 聚合检索：检索范围 */
export type SearchScope = 'all' | 'site' | 'spider' | 'douban' | 'selected';

/** 跨源聚合分组（同一部片在不同源的结果归并） */
export interface SearchResultGroup {
  /** 归一化片名 + `:`` + 年份（缺失为 unknown） */
  key: string;
  title: string;
  year: number | null;
  /** 组内条目，按源健康 tier → 延迟 → sort 排序 */
  items: MediaItem[];
}

/* ---------- 历史 / 收藏 ---------- */
/** REV-24：历史快照，用于缓存清理后自愈（可选字段，兼容旧记录） */
export interface MediaSnapshot {
  /** 源内条目 ID（自愈必需，adapter 用它重新拉详情） */
  sourceItemId: string;
  type: MediaType;
  year: number | null;
  episodeCount: number | null;
  originalTitle: string | null;
}

export interface HistoryRecord {
  /** `${sourceId}:${mediaId}`，同一影片同源只保留一条 */
  id: string;
  sourceId: string;
  mediaId: string;
  episodeId: string | null;
  episodeNumber: number | null;
  title: string;
  posterUrl: string | null;
  positionSec: number;
  durationSec: number;
  /** 0~1 */
  progress: number;
  finished: boolean;
  totalEpisodes: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** REV-24：媒体快照，缓存清理后用于自愈（旧记录无此字段） */
  mediaSnapshot?: MediaSnapshot;
}

export interface SaveProgressInput {
  sourceId: string;
  mediaId: string;
  episodeId: string | null;
  episodeNumber: number | null;
  title: string;
  posterUrl: string | null;
  positionSec: number;
  durationSec: number;
  totalEpisodes: number | null;
  /** REV-24：媒体快照 */
  mediaSnapshot?: MediaSnapshot;
}

export interface FavoriteRecord {
  /** `${sourceId}:${mediaId}` */
  id: string;
  sourceId: string;
  mediaId: string;
  title: string;
  posterUrl: string | null;
  type: MediaType;
  year: number | null;
  /** 源已被删除时为 true */
  sourceRemoved: boolean;
  createdAt: Timestamp;
}

export interface FavoriteInput {
  sourceId: string;
  mediaId: string;
  title: string;
  posterUrl: string | null;
  type: MediaType;
  year: number | null;
}

/* ---------- 下载 ---------- */
export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type DownloadSinkKind = 'filesystem' | 'idb-blob';

/* ---------- 功能扩展-4：下载增强（EXT-04） ---------- */

/** 下载清晰度档位（FR-62；`max` 取最高变体，其余按 RESOLUTION 高度封顶） */
export type HlsQuality = 'max' | '1080p' | '720p';

/** 产物容器（FR-60） */
export type DownloadContainer = 'ts' | 'mp4' | 'fmp4' | 'other';

/** 字幕随片下载策略（FR-64） */
export type DownloadSubtitlePolicy = 'preferred' | 'all' | 'none';

/** 转封装结果（FR-60，后端原生执行，前端只读） */
export interface DownloadRemuxInfo {
  status: 'none' | 'done' | 'skipped' | 'failed';
  reason?: string;
  durationMs?: number;
}

/** 预检摘要（FR-65） */
export interface DownloadPreflightDigest {
  at: number;
  drmProtected: boolean;
  latencyMs: number | null;
  notes: string[];
}

export interface DownloadTask {
  /** uuid */
  id: string;
  sourceId: string;
  mediaId: string;
  episodeId: string;
  episodeNumber: number | null;
  title: string;
  episodeTitle: string | null;
  posterUrl: string | null;
  url: string;
  headers: Record<string, string>;
  format: MediaFormat;
  quality: string | null;
  status: DownloadStatus;
  /** 队列优先级，值小优先；默认 createdAt */
  priority: number;
  totalBytes: number | null;
  downloadedBytes: number;
  /** 字节/秒，非下载中为 0 */
  speedBps: number;
  retries: number;
  maxRetries: number;
  /** 支持 Range 续传 */
  resumable: boolean;
  sink: DownloadSinkKind;
  /** Android 相对 Data 目录的路径；Web 为 null */
  filePath: string | null;
  /** IndexedDB blobs 的 key；Android 为 null */
  blobKey: string | null;
  /** 字幕文件本地路径列表（Android 相对 Data 目录；Web 为 blob key） */
  subtitlePaths?: Array<{ path: string; lang: string; format: 'vtt' | 'srt' }> | null;
  /** 封面图本地路径（Android 相对 Data 目录；Web 为 blob key） */
  coverPath?: string | null;
  /** 待下载的字幕 URL 列表（创建时传入，下载完成后清空） */
  pendingSubtitleUrls?: Array<{ url: string; lang: string; format: 'vtt' | 'srt' }>;
  /** 待下载的封面 URL（创建时传入，下载完成后清空） */
  pendingCoverUrl?: string;
  /* ---------- 功能扩展-4：下载增强（EXT-04，全部可选，老数据兼容） ---------- */
  /** 批量分组标识；单集创建为 null（FR-61） */
  batchId?: string | null;
  /** 本次任务选定的清晰度档位；直链为 null（FR-62） */
  hlsQuality?: HlsQuality | null;
  /** 实际选中变体高度（变体无 RESOLUTION 时为 null）（FR-62） */
  selectedHeight?: number | null;
  /** 产物容器；null 表示尚未判定（FR-60） */
  container?: DownloadContainer | null;
  /** 转封装结果（FR-60；前端只读展示） */
  remux?: DownloadRemuxInfo | null;
  /** 预检估算体积（FR-65，仅展示与空间预留） */
  estimatedBytes?: number | null;
  /** 预检摘要（FR-65，任务详情与问题定位用） */
  preflight?: DownloadPreflightDigest | null;
  /** 创建时的字幕随片策略快照（FR-64） */
  subtitleSelection?: DownloadSubtitlePolicy | null;
  errorCode: ErrorCode | null;
  /** P0-3: HLS 下载已完成的分片序号列表（用于暂停续传） */
  completedSegments?: number[];
  errorMessage: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt: Timestamp | null;
}

export interface CreateDownloadInput {
  sourceId: string;
  mediaId: string;
  episodeId: string;
  episodeNumber: number | null;
  title: string;
  episodeTitle: string | null;
  posterUrl: string | null;
  url: string;
  headers?: Record<string, string>;
  format: MediaFormat;
  quality?: string | null;
  /** 字幕文件 URL 列表（随视频一起下载） */
  subtitleUrls?: Array<{ url: string; lang: string; format: 'vtt' | 'srt' }>;
  /** 封面图 URL（随视频一起下载） */
  coverUrl?: string;
  /** 单次覆盖设置的清晰度档位（FR-62；直链忽略） */
  hlsQuality?: HlsQuality;
  /** 由 `createBatch` 注入的批次标识（FR-61；单集创建不传） */
  batchId?: string;
}

export interface DownloadSummary {
  total: number;
  queued: number;
  downloading: number;
  paused: number;
  completed: number;
  failed: number;
  totalBytes: number;
  downloadedBytes: number;
}

/* ---------- 设置 ---------- */
export type PlaybackRate = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2 | 2.5 | 3;
export type ThemeMode = 'dark' | 'light' | 'system';
export type Sensitivity = 'low' | 'medium' | 'high';

export interface SubtitleSettings {
  enabled: boolean;
  size: 'small' | 'medium' | 'large';
  color: 'white' | 'yellow';
  background: 'black' | 'none';
  /** 秒，-5 ~ +5 */
  offsetSec: number;
  preferredLang: string | null;
}

/**
 * 画面比例模式（P1 画面比例配置）
 * - contain：适应画面，完整显示，留黑边（默认）
 * - cover：裁剪铺满，不变形，裁掉部分边缘
 * - fill：拉伸铺满，填满屏幕但会变形
 */
export type ResizeMode = 'contain' | 'cover' | 'fill';

export interface PlayerSettings {
  defaultRate: PlaybackRate;
  /** 'auto' 或具体档位标签，如 '720p' */
  defaultQuality: string;
  autoPlayNext: boolean;
  seekStepSec: number;
  longPressRate: number;
  subtitle: SubtitleSettings;
  rememberVolumeBrightness: boolean;
  lastVolume: number;
  lastBrightness: number;
  /** 画面比例模式（P1 新增） */
  resizeMode: ResizeMode;
}

export interface GestureSettings {
  sensitivity: Sensitivity;
  /** 水平满屏拖动映射的最长秒数 */
  seekMaxSec: number;
}

export type DownloadSpeedLimit = 'low' | 'medium' | 'high' | 'unlimited';

export interface DownloadSettings {
  concurrency: 1 | 2 | 3;
  wifiOnly: boolean;
  autoResume: boolean;
  /** 下载限速档位（low=512KB/s, medium=2MB/s, high=5MB/s, unlimited=不限速） */
  speedLimit: DownloadSpeedLimit;
  /** P0-6: HLS 分片并发下载数（3/6/8） */
  segmentConcurrency?: 3 | 6 | 8;
  /** EXT-04/FR-60：完成后是否转封装为 MP4（仅 Android 生效，默认开） */
  remuxToMp4?: boolean;
  /** EXT-04/FR-64：字幕随片下载策略（默认 preferred） */
  attachSubtitles?: DownloadSubtitlePolicy;
  /** EXT-04/FR-62：默认下载清晰度（默认 max；直链不受影响） */
  hlsQuality?: HlsQuality;
  /** EXT-04/FR-61：队列非终态任务上限（默认 200） */
  maxQueueTasks?: 50 | 100 | 200 | 500;
}

export interface AppSettings {
  schemaVersion: number;
  theme: ThemeMode;
  locale: 'zh-CN';
  complianceVersion: number;
  complianceAcceptedAt: Timestamp | null;
  defaultSourceId: string | null;
  hideDemoContent: boolean;
  player: PlayerSettings;
  gesture: GestureSettings;
  download: DownloadSettings;
  searchHistory: string[];
  /** v1.7/CHG-24：内置推荐订阅清单可见性（默认开，见 settingsService 默认值） */
  showRecommendedSubscriptions?: boolean;
  /** v1.7/CHG-21 PoC：实验性原生播放引擎（ExoPlayer），默认关 */
  experimentalNativePlayer?: boolean;
  /** v1.7/CHG-22：弹幕设置（只读展示） */
  danmaku?: DanmakuSettings;
  /** v1.8/P4：网盘画质与线程配置 */
  netdisk?: NetdiskSettings;
  /** 功能扩展-4：WebDAV 云备份配置 */
  webdav?: WebDAVSettings;
  /** EXT-05 phase1：定时备份 / 版本保留 / 加密配置 */
  backup?: BackupSettings;
  /** 功能扩展-9：暂停历史记录（隐私开关，默认关） */
  pauseHistoryRecording?: boolean;
  /** OPT-03：触觉反馈开关（默认开） */
  hapticEnabled?: boolean;
  /** OPT-06：自动进入画中画（页面不可见且正在播放时，默认关） */
  pipAutoEnter?: boolean;
  /**
   * OPT-04：搜索超时预算档位（缩放单源超时；缺省 = 'standard'，即既有
   * 站点 8s / 爬虫 20s / 其它 5s 的行为不变）。文案与倍率见 `@/shared/searchBudget`。
   */
  searchBudget?: 'fast' | 'standard' | 'patient';
  /** OPT-15：智能预加载开关（WiFi 环境下提示预加载内容，默认关） */
  smartPreloadEnabled?: boolean;
  /** OPT-15：预加载存储上限（MB），0 表示无限制 */
  preloadStorageLimitMb?: number;
  /** EXT-06/FR-66：EPG 源上限（缺省取 constants 默认值） */
  epg?: EpgSourceLimits;
  updatedAt: Timestamp;
}

/** P4: 网盘画质与线程配置 */
export interface NetdiskSettings {
  /** 画质：auto/4K/1080P/720P/480P */
  quality: 'auto' | '4K' | '1080P' | '720P' | '480P';
  /** 下载线程数：1-8 */
  threadCount: number;
}

/** 功能扩展-4: WebDAV 云备份配置 */
export interface WebDAVSettings {
  /** WebDAV 服务器地址 */
  serverUrl: string;
  /** 用户名 */
  username: string;
  /** 密码/应用密钥 */
  password: string;
  /** 远程备份目录路径 */
  backupPath: string;
}

/* ---------- EXT-05 phase1：定时备份 / 版本保留 / 加密 ---------- */

/** 定时模式：关闭 / 每天 / 每周 */
export type BackupScheduleMode = 'off' | 'daily' | 'weekly';

/** 备份来源：手动 / 定时 */
export type BackupSource = 'manual' | 'scheduled';

/** 备份存放位置：本机 / WebDAV */
export type BackupLocation = 'local' | 'webdav';

/**
 * 备份增强设置（落在 `AppSettings.backup`）。
 *
 * 安全约束：**不存密码明文**。只落 PBKDF2 的 salt 与"校验块"（verifier），
 * 派生密钥单独缓存在 kv（见 `backupService` 的 `BACKUP_KEY_KV_KEY`）。
 */
export interface BackupSettings {
  /** 定时模式 */
  scheduleMode: BackupScheduleMode;
  /** 触发小时（0-23，本地时区） */
  scheduleHour: number;
  /** 触发星期（1=周一 … 7=周日，仅 weekly 生效） */
  scheduleWeekday: number;
  /** 版本保留数量（1-20） */
  retentionCount: number;
  /** 是否加密备份 */
  encryptionEnabled: boolean;
  /** PBKDF2 salt（base64），未加密时为 null */
  encryptionSalt: string | null;
  /** 密码校验块（base64，固定明文 "peanutmov-backup-key-check" 的 AES-GCM 密文），用于校验用户输入 */
  encryptionVerifier: string | null;
  /** 上次定时备份成功时间（用于「补执行」判定与 UI 展示） */
  lastScheduledAt: Timestamp | null;
  /** 上次任意备份成功时间 */
  lastBackupAt: Timestamp | null;
  /** 最近一次定时备份失败原因（成功即清空） */
  lastError: string | null;
}

/**
 * 备份索引条目（kv `backup-index`）。
 *
 * 只存元数据，正文在原生文件系统（`backups/`）或 kv（Web 无文件系统时）。
 */
export interface BackupRecord {
  /** 稳定 id（`{timestamp}-{source}` 派生，便于同日多次区分） */
  id: string;
  /** 备份生成时间 */
  timestamp: Timestamp;
  /** 字节数 */
  size: number;
  /** 手动 / 定时 */
  source: BackupSource;
  /** 是否加密（.enc） */
  encrypted: boolean;
  /** 本机相对路径或 WebDAV 远程路径 */
  path: string;
  /** 存放位置 */
  location: BackupLocation;
  /** 文件名（列表展示用） */
  fileName: string;
}

/* ---------- v1.7 增量（CHG-19 / CHG-22） ---------- */

/** 订阅健康摘要（CHG-19，按 subscriptionId 聚合） */
export interface SubscriptionSummary {
  subscriptionId: string;
  sourceCount: number;
  alive: number;
  dead: number;
  jarDead: number;
  lastRefreshAt: number | null;
}

/* ---------- 弹幕（CHG-22，只读不发） ---------- */

export type DanmakuProviderId = 'bilibili' | 'tencent' | 'dandanplay' | 'local-xml';

export interface DanmakuComment {
  /** 相对视频起点的秒数 */
  time: number;
  mode: 'scroll' | 'top' | 'bottom';
  /** RGB 整数值（B 站 xml 惯例） */
  color: number;
  text: string;
}

export interface DanmakuMatch {
  provider: DanmakuProviderId;
  matchedTitle: string | null;
  /** 时间轴偏移（秒），播放时加到弹幕 time 上 */
  offsetSec: number;
  comments: DanmakuComment[];
}

export interface DanmakuSettings {
  enabled: boolean;
  fontSize: number;
  /** 0.1 ~ 1 */
  opacity: number;
  /** 滚动时长倍率：越大越慢，1 为基准 */
  speed: number;
  /** 弹幕占屏幕高度百分比（10~100） */
  areaPercent: number;
  merge: boolean;
  /** 底部安全区百分比（默认 15，字幕区禁显） */
  safeBottomPercent: number;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/* ---------- 订阅导入 ---------- */
export type ImportOrigin = 'url' | 'file';

export interface ImportIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  field: string | null;
  message: string;
}

export interface ImportPreviewEntry {
  key: string;
  name: string;
  type: SourceType | 'unknown';
  baseUrl: string;
  enabled: boolean;
  selected: boolean;
  valid: boolean;
  duplicateOf: string | null;
  warning: string | null;
  issues: ImportIssue[];
  normalized: SourceInput | null;
}

export interface ImportPreview {
  origin: ImportOrigin;
  sourceUrl: string | null;
  fileName: string | null;
  fetchedAt: Timestamp;
  name: string | null;
  total: number;
  entries: ImportPreviewEntry[];
  globalIssues: ImportIssue[];
  /** 多仓索引（顶层 `urls[]` 或逐行 URL 文本）：待用户选择后展开，非空时 `entries` 为空 */
  repos: string[];
  /** TVBox `lives[]` 直播源（CHG-13）：导入成功后由 UI 征询/自动添加到直播页 */
  lives: Array<{ name: string; url: string }>;
  /** v1.7/CHG-18：内容不是普通订阅时的可操作建议（加入直播源 / 自定义频道 / 采集源） */
  suggestions?: ImportSuggestion[];
}

/** v1.7/CHG-18：非订阅内容的引导动作 */
export type ImportSuggestion =
  | { kind: 'live-list'; action: 'add-live'; payload: string; channelCount: number }
  | { kind: 'single-stream'; action: 'add-channel'; payload: string }
  | { kind: 'cms-api'; action: 'add-site'; payload: string };

export interface ImportCommitOptions {
  selectedKeys: string[];
  onDuplicate: 'skip' | 'overwrite' | 'keep-both';
}

export interface ImportResult {
  success: number;
  skipped: number;
  failed: number;
  sourceIds: string[];
  issues: ImportIssue[];
}

/* ---------- 直播（CHG-13） ---------- */
export type LiveListFormat = 'm3u' | 'txt' | 'auto';

/** 直播播放列表记录（频道本身不落库：直播源更新频繁，按需拉取解析） */
export interface LiveRecord {
  id: string;
  name: string;
  /** 播放列表地址（m3u / txt / 单频道 m3u8） */
  url: string;
  format: LiveListFormat;
  /** 最近一次成功拉取的频道数；从未成功为 null */
  channelCount: number | null;
  subscriptionId: string | null;
  /** EXT-06/FR-68：回看配置（纯可选，老记录缺省视为不支持回看） */
  catchup?: LiveCatchupSettings;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** 频道分组（解析层聚合结果，不落库） */
export interface LiveGroup {
  name: string;
  channels: Array<{ name: string; url: string; logo: string | null }>;
}


/* ---------- 备份 ---------- */
export type BackupMode = 'merge' | 'overwrite';

export interface BackupFile {
  schemaVersion: number;
  appVersion: string;
  exportedAt: Timestamp;
  sources: Source[];
  favorites: FavoriteRecord[];
  history: HistoryRecord[];
  settings: AppSettings | null;
  downloads: Array<Omit<DownloadTask, 'sink' | 'filePath' | 'blobKey'>>;
}

export interface BackupImportReport {
  sources: number;
  favorites: number;
  history: number;
  downloads: number;
  settingsRestored: boolean;
}

/* ---------- 界面状态 ---------- */
export type LoadState =
  | 'idle'
  | 'loading'
  | 'refreshing'
  | 'success'
  | 'empty'
  | 'error'
  | 'offline';

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'error';
  text: string;
  durationMs: number;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

/* ---------- 适配器 ---------- */
export interface SourceAdapter {
  readonly type: SourceType;
  /** 单源搜索超时（CHG-15）。缺省 5s；需预热或链路更长的源（jar/drpy）应更长 */
  readonly searchTimeoutMs?: number;
  testConnection(source: Source, signal?: AbortSignal): Promise<ConnectionResult>;
  /** CHG-15：后台预热（加载 jar/规则拿句柄），实现方自行吞错、失败静默 */
  warmup?(source: Source): Promise<void>;
  listCategories(source: Source, signal?: AbortSignal): Promise<Category[]>;
  browse(params: BrowseParams): Promise<PageResult<MediaItem>>;
  search(params: SearchParams): Promise<MediaItem[]>;
  getDetail(params: GetDetailParams): Promise<MediaDetail>;
  resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource>;
}

/* =========================================================
 * EXT-06（2026-11-06）：IPTV/EPG 增强（FR-66 ~ FR-71）
 * 全部为追加类型，既有数据类型不改字段语义。
 * =======================================================*/

/* ---------- FR-66/FR-67：EPG 多源 ---------- */
export type EpgProtocol = 'auto' | 'diyp' | 'xmltv';

/**
 * 匹配模式：`auto` = L1(tvg-id) → L2(tvg-name) → L3(归一化名称) 依次尝试；
 * 其余取值只跑指定级别（四级确定性匹配，不做模糊匹配，见 Q-16）。
 */
export type EpgMatchMode = 'auto' | 'channel-name' | 'xmltv-id';

export interface EpgSource {
  id: string;
  name: string;
  endpoint: string;
  protocol: EpgProtocol;
  matchMode: EpgMatchMode;
  /** 合并优先级：1..N 唯一，数值小者优先 */
  priority: number;
  enabled: boolean;
  /** 内置默认源不可删除（EPG_DEFAULT_ENDPOINT） */
  builtin: boolean;
  lastProbeAt: Timestamp | null;
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface EpgSourceInput {
  name: string;
  endpoint: string;
  protocol?: EpgProtocol;
  matchMode?: EpgMatchMode;
  sampleChannel?: { name: string; tvgId?: string | null };
}

/** 频道侧引用（由 LiveChannel + liveExtras 合成，不落库） */
export interface EpgChannelRef {
  name: string;
  tvgId: string | null;
  tvgName: string | null;
  url?: string;
}

/** 命中级别：1 = tvg-id，2 = tvg-name，3 = 归一化名称 */
export type EpgMatchLevel = 1 | 2 | 3;

export interface ChannelEpgResult {
  channel: { name: string; tvgId: string | null; tvgName: string | null };
  channelKey: string;
  /** yyyy-MM-dd（设备本地时区） */
  date: string;
  programmes: EpgProgramme[];
  matchedSource: { id: string; name: string; matchLevel: EpgMatchLevel } | null;
  /** 源不可达时返回过期缓存 */
  stale: boolean;
  errors: Array<{ sourceId: string; code: ErrorCode; message: string }>;
}

/** AppSettings.epg：EPG 源上限（缺省取 constants 的 EPG_SOURCE_MAX / EPG_SOURCE_ENABLED_MAX） */
export interface EpgSourceLimits {
  maxSources: number;
  maxEnabled: number;
}

/* ---------- FR-69/FR-70：频道分组与排序 ---------- */
export interface ChannelGroupDef {
  id: string;
  name: string;
  order: number;
  createdAt: Timestamp;
}

export interface ChannelPrefs {
  /** keyPath = 直播源 id（作用域隔离：不同直播源的分组互不影响） */
  liveSourceId: string;
  groups: ChannelGroupDef[];
  /** channelKey → groupId（一频道最多一组） */
  assignments: Record<string, string>;
  /** scopeKey('all' | 'g:<id>' | 's:<源分组名>') → channelKey[] */
  orders: Record<string, string[]>;
  updatedAt: Timestamp;
}

/* ---------- FR-68：回看 ---------- */
export interface LiveCatchupSettings {
  enabled: boolean;
  /** 模板，占位符白名单见 shared/catchupTemplate.ts */
  template: string;
  /** 回看天数 1..CATCHUP_MAX_DAYS */
  days: number;
}

export type CatchupProbeState = 'unknown' | 'available' | 'auth_required' | 'not_found' | 'unreachable';

export interface CatchupCapability {
  key: string;
  state: CatchupProbeState;
  checkedAt: Timestamp | null;
  days: number;
  status: number | null;
  reason: string | null;
}

/** m3u 旁路属性（不写入 LiveChannel，避免破坏既有解析契约） */
export interface LiveChannelExtras {
  tvgId: string | null;
  tvgName: string | null;
  /** m3u `catchup-source` */
  catchupTemplate: string | null;
  /** m3u `catchup-days` */
  catchupDays: number | null;
  /** m3u `catchup-correction` */
  catchupCorrectionSec: number | null;
}

export type LiveChannelExtrasMap = Record<string /* channel url */, LiveChannelExtras>;

/* ---------- FR-71：节目提醒 ---------- */
export type ReminderState = 'scheduled' | 'firing' | 'fired' | 'missed' | 'cancelled';

/** 提醒提前量（分钟）；0 = 节目开播时刻提醒（REV-20） */
export type ReminderLead = 0 | 5 | 10 | 15 | 30;

export interface Reminder {
  id: string;
  liveSourceId: string;
  epgSourceId: string | null;
  channelKey: string;
  channelName: string;
  programmeKey: string;
  programmeTitle: string;
  startAt: Timestamp;
  endAt: Timestamp;
  leadMinutes: 0 | 5 | 10 | 15 | 30;
  notifyAt: Timestamp;
  state: ReminderState;
  /** 原生通知 id（32 位正整数，稳定哈希） */
  nativeId: number;
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
