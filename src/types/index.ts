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
export type SourceType = 'demo' | 'alist' | 'webdav' | 'jellyfin' | 'site';

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
}

/* ---------- 列表查询 ---------- */
export type LibraryFilterType = 'type' | 'year' | 'area';

export interface LibraryFilters {
  type: MediaType | null;
  yearFrom: number | null;
  yearTo: number | null;
  area: string | null;
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
}

export interface GestureSettings {
  sensitivity: Sensitivity;
  /** 水平满屏拖动映射的最长秒数 */
  seekMaxSec: number;
}

export interface DownloadSettings {
  concurrency: 1 | 2 | 3;
  wifiOnly: boolean;
  autoResume: boolean;
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
  updatedAt: Timestamp;
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
}

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
  testConnection(source: Source, signal?: AbortSignal): Promise<ConnectionResult>;
  listCategories(source: Source, signal?: AbortSignal): Promise<Category[]>;
  browse(params: BrowseParams): Promise<PageResult<MediaItem>>;
  search(params: SearchParams): Promise<MediaItem[]>;
  getDetail(params: GetDetailParams): Promise<MediaDetail>;
  resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource>;
}
