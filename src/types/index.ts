/* =========================================================
 * 全局类型契约 —— 冻结版本 v1.0
 * 约定：所有时间戳为毫秒 Date.now()；可空字段显式 null
 * =======================================================*/

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
  errorCode: ErrorCode | null;
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
export type PlaybackRate = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;
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
  updatedAt: Timestamp;
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

export type DanmakuProviderId = 'dandanplay' | 'aggregate' | 'local-xml';

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
