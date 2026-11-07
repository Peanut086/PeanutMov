/**
 * 全局常量（SCF 冻结，PKG-B 只读）
 *
 * 只放"跨模块共享且不允许运行期变化"的值。
 * 与具体页面/组件相关的视觉常量见 `src/styles/tokens.css`，不要混放。
 */
import type { PlaybackRate } from '@/types';

/* ---------- 应用信息 ---------- */
export const APP_NAME = 'PeanutMov';
export const APP_ID = 'com.qoder.cinema';

/** 由 vite define 注入；未注入时兜底为 '未知版本' 的场景由 UI 判定 */
export const APP_VERSION: string = (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0)
  ? __APP_VERSION__
  : '未知版本';

/** 构建时间戳（毫秒）；未注入时为 null，UI 不展示构建日期（REV-19） */
export const BUILD_TIME: number | null = (typeof __BUILD_TIME__ === 'string' && __BUILD_TIME__.length > 0)
  ? Date.parse(__BUILD_TIME__)
  : null;

/* ---------- IndexedDB ---------- */
export const DB_NAME = 'cinema-db';
/**
 * v2（CHG-13）：新增 lives store（直播播放列表）；v3（CHG-22/23）：danmakuCache / epgCache；
 * v4（EXT-06）：epgSources / channelPrefs / reminders + epgCache 键空间改版（`epgv2:`）
 */
export const DB_VERSION = 4;

/** kv 表中存放应用设置的 key */
export const KV_KEY_SETTINGS = 'app-settings';
/** kv 表中存放演示种子完成标记的 key */
export const KV_KEY_DEMO_SEEDED = 'demo-seeded';
/** kv 表中存放订阅导入记录的 key */
export const KV_KEY_IMPORT_RECORDS = 'import-records';

/* ---------- 合规 ---------- */
/** 合规声明文本版本；文本变更时 +1，触发已同意用户重新确认（AC-101） */
export const COMPLIANCE_VERSION = 1;

/* ---------- 分页与列表 ---------- */
/** 媒体库每页条数（AC-25） */
export const PAGE_SIZE = 30;
/** 剧集列表超过该数量时启用虚拟滚动/分页（AC-32） */
export const EPISODE_PAGE_SIZE = 50;
/** 历史记录条数上限，超出按 updatedAt 淘汰（AC-62） */
export const HISTORY_MAX = 500;
/** 继续观看最多展示条数（AC-63） */
export const CONTINUE_WATCHING_LIMIT = 10;
/** 搜索结果条数上限 */
export const SEARCH_LOCAL_LIMIT = 50;
/** 搜索历史保留条数 */
export const SEARCH_HISTORY_MAX = 10;
/** 滚动距底部多少 px 触发加载下一页（FR-11） */
export const INFINITE_SCROLL_THRESHOLD_PX = 300;

/* ---------- 超时（毫秒） ---------- */
/** 源连通性探测（AC-15/AC-16） */
export const TIMEOUT_TEST_CONNECTION_MS = 3000;
/**
 * 爬虫源探活窗口（P0-3）：jar 冷启动要走「下载 1MB+ → dex 加载 → 防护初始化 → homeContent」，
 * 原生侧连接超时 20s、读取超时 30s，3s 必然误判。
 * 命中缓存（热句柄）后只走一次 homeContent + 一次列表，按热窗口收紧，
 * 避免每次体检都等满冷窗口。
 */
export const TIMEOUT_PROBE_SPIDER_MS = 35000;
export const TIMEOUT_PROBE_SPIDER_WARM_MS = 15000;
/**
 * 健康检查并发上限（AC-16；CHG-05 由 3 提升为 6）
 *
 * OPT-03 耗时口径：最坏耗时 ≈ 启用源数 × 单源探测超时 ÷ 本并发数
 * （183 个冷启 spider ≈ 183 × 35s ÷ 6 ≈ 17.8 分钟），不存在“全量 2 分钟”的保证；
 * 因此 UI 必须展示 `检测中 n/total`、支持取消与“仅检测失败源”，不得给出固定时长承诺。
 */
export const HEALTH_CHECK_CONCURRENCY = 6;
/** 订阅拉取 */
export const TIMEOUT_SUBSCRIPTION_FETCH_MS = 10000;
/** 远程搜索单源超时（AC-24）；CHG-15 起按源类型区分，此为缺省值 */
export const TIMEOUT_SEARCH_MS = 5000;
/** 站点源（CMS JSON）搜索超时（CHG-15）：模板请求较轻，略放宽 */
export const TIMEOUT_SEARCH_SITE_MS = 8000;
/** 爬虫源搜索超时（CHG-15）：冷启动需 jar 下载+dex+init，5s 必超时；
 * 预热（warmup）命中热句柄后多数 <1s 返回，20s 只兜冷路径 */
export const TIMEOUT_SEARCH_SPIDER_MS = 20000;
/** 播放器 loadedmetadata 等待（9.7） */
export const TIMEOUT_LOAD_METADATA_MS = 15000;
/** 播放网络错误自动重试间隔（FR-25） */
export const PLAYER_RETRY_DELAY_MS = 1000;

/* ---------- GitHub raw 镜像（CHG-11） ---------- */
/** 直连 raw.githubusercontent.com 在部分网络不可达，按序尝试的镜像前缀（清单实测在用） */
export const GITHUB_MIRROR_HOSTS = ['gh-proxy.org', 'ghfast.top', 'gh-proxy.com'] as const;
/** 批量订阅评测：并发与单订阅预算 */
export const SUBSCRIPTION_EVAL_CONCURRENCY = 4;
export const TIMEOUT_SUBSCRIPTION_EVAL_MS = 15000;

/* ---------- 播放 ---------- */
export const PLAYBACK_RATES: readonly PlaybackRate[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const DEFAULT_PLAYBACK_RATE: PlaybackRate = 1;
/** 进度写回间隔（FR-21） */
export const PROGRESS_WRITE_INTERVAL_MS = 5000;
/** ProgressReporter 最小写库间隔（9.4） */
export const PROGRESS_MIN_WRITE_GAP_MS = 4000;
/** 视为"从头播放"的进度下限 */
export const PROGRESS_START_THRESHOLD = 0.05;
/** 视为"已看完"的进度上限 */
export const PROGRESS_FINISHED_THRESHOLD = 0.95;
/** 播放器控制条自动隐藏延时（FR-18） */
export const CONTROLS_AUTO_HIDE_MS = 3000;

/* ---------- 手势（9.3） ---------- */
export const GESTURE_TAP_MAX_MOVE_PX = 8;
export const GESTURE_TAP_MAX_DURATION_MS = 300;
export const GESTURE_DOUBLE_TAP_INTERVAL_MS = 250;
export const GESTURE_LONG_PRESS_MS = 500;
export const GESTURE_DIRECTION_RATIO = 1.5;
export const GESTURE_SEEK_MAX_SEC = 90;
export const GESTURE_SENSITIVITY_FACTOR = {
  low: 0.6,
  medium: 1.0,
  high: 1.5,
} as const;
/** 亮度手势映射：遮罩最多 80%，底层保留 20%（AC-48 / API-12） */
export const DIM_MAX_PERCENT = 80;

/* ---------- 下载（Q-03） ---------- */
export const DOWNLOAD_DEFAULT_CONCURRENCY = 2;
export const DOWNLOAD_MAX_RETRIES = 2;
export const DOWNLOAD_RETRY_BACKOFF_MS = [1000, 3000] as const;
/** Web 端单文件超过该体积时前置提示改用 App（AC-76） */
export const DOWNLOAD_WEB_SIZE_WARN_BYTES = 1024 * 1024 * 1024;
/** 移动网络下下载超过该体积前提示（Q-03） */
export const DOWNLOAD_CELLULAR_WARN_BYTES = 500 * 1024 * 1024;
/** 下载进度落库间隔 */
export const DOWNLOAD_PROGRESS_PERSIST_MS = 2000;
/** 下载限速档位对应的字节/秒 */
export const DOWNLOAD_SPEED_LIMITS = {
  low: 512 * 1024,      // 512 KB/s
  medium: 2 * 1024 * 1024,  // 2 MB/s
  high: 5 * 1024 * 1024,    // 5 MB/s
  unlimited: Infinity,
} as const;

/* ---------- 功能扩展-4：下载增强（EXT-04） ---------- */
/** 单次批量上限（FR-61 / AC-144） */
export const DOWNLOAD_BATCH_MAX = 50;
/** 队列非终态任务默认上限（FR-61）；实际值取 `settings.download.maxQueueTasks` */
export const DOWNLOAD_QUEUE_MAX = 200;
/** 队列上限可选档位（Q-12 A：可配置） */
export const DOWNLOAD_QUEUE_MAX_OPTIONS = [50, 100, 200, 500] as const;
/** 单任务预检超时（FR-65） */
export const DOWNLOAD_PREFLIGHT_TIMEOUT_MS = 4000;
/** 预检并发上限（FR-65；硬上限 4） */
export const DOWNLOAD_PREFLIGHT_MAX_PARALLEL = 4;
/** 清单预检缓存 TTL（FR-65：同 master 60s 复用，减少请求） */
export const DOWNLOAD_PREFLIGHT_CACHE_TTL_MS = 60_000;
/** 预检单分片探测读取字节数（`Range: bytes=0-65535`） */
export const DOWNLOAD_PREFLIGHT_PROBE_BYTES = 64 * 1024;
/** 清单预检缓存条目上限（与 LocalProxy MAX_TARGETS=100 兼容） */
export const DOWNLOAD_PREFLIGHT_CACHE_MAX = 50;
/** 转封装超时（FR-60；由后端原生侧执行，前端只做状态展示预留） */
export const DOWNLOAD_REMUX_TIMEOUT_MS = 120_000;
/** 速率统计滑窗（FR-63 / AC-148） */
export const DOWNLOAD_RATE_WINDOW_MS = 3000;
/** 令牌桶补充节拍（FR-63） */
export const DOWNLOAD_RATE_TICK_MS = 50;

/* ---------- 导入 / 备份 ---------- */
/** 订阅文件与响应体大小上限 2MB（FR-05 / API-05） */
export const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
/** 单份订阅最多源数量（7.7） */
export const MAX_SUBSCRIPTION_SOURCES = 500;
/** 备份文件 schemaVersion */
export const BACKUP_SCHEMA_VERSION = 1;

/* ---------- 校验 ---------- */
export const SOURCE_NAME_MAX_LENGTH = 30;
export const SOURCE_NAME_MIN_LENGTH = 1;

/* ---------- 布局（与 tokens.css 对齐的 JS 侧数值） ---------- */
export const TAB_BAR_HEIGHT_PX = 56;
export const HEADER_HEIGHT_PX = 52;
export const MIN_TOUCH_TARGET_PX = 44;

/* ---------- v1.7：订阅导入归一化（CHG-18） ---------- */
/** 会被代理前缀包装的 GitHub raw 域名（gh-proxy/ghfast 等前缀在失效时剥离直连） */
export const URL_PROXY_HOSTS = ['gh-proxy.org', 'ghfast.top', 'gh-proxy.com', 'ghproxy.net', 'mirror.ghproxy.com'] as const;
/** CDN 变体对：网络失败时 jsdelivr ↔ raw.githubusercontent 互换重试 */
export const CDN_VARIANT_MAP: Readonly<Record<string, string>> = {
  'cdn.jsdelivr.net': 'raw.githubusercontent.com',
  'fastly.jsdelivr.net': 'raw.githubusercontent.com',
  'testingcf.jsdelivr.net': 'raw.githubusercontent.com',
};
/** HTML 落地页嗅探：同域候选配置链接上限 */
export const HTML_SNIFF_MAX_CANDIDATES = 3;

/* ---------- v1.7：订阅生命周期（CHG-19） ---------- */
/** 自动刷新 TTL：距上次成功刷新超过该值才在启动/前台时刷新 */
export const SUBSCRIPTION_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
/** 自动刷新并发上限 */
export const SUBSCRIPTION_REFRESH_CONCURRENCY = 2;
/** 连续体检 bad 达到该次数自动禁用（FR-51） */
export const SUBSCRIPTION_AUTO_DISABLE_STREAK = 3;

/* ---------- v1.7：播放（CHG-21） ---------- */
/** 起播失败自动兜底窗口：窗口内失败自动换线→换源 */
export const PLAYER_FAILOVER_WINDOW_MS = 10000;
/**
 * 爬虫源 playerContent 单次超时（P1-6）：
 * jar 已缓存命中（热句柄）时 10s 足够；只有「下载/镜像降级」链路才允许 30s。
 * 否则真机实测出现过 30s 长等待后统一报错，用户以为卡死。
 */
export const TIMEOUT_SPIDER_PLAY_HOT_MS = 10000;
export const TIMEOUT_SPIDER_PLAY_COLD_MS = 30000;
/** 高码率（≥1080p）前向缓冲目标（秒） */
export const HLS_MAX_BUFFER_HIGH_S = 60;
/** 高码率前向缓冲默认值（秒，hls.js 默认 30） */
export const HLS_MAX_BUFFER_DEFAULT_S = 30;
/** 直播低延迟：落后直播点多少个分片内追平 */
export const LIVE_SYNC_COUNT = 3;
/** 直播频道起播超时（超时自动切同组下一路） */
export const TIMEOUT_LIVE_CHANNEL_MS = 8000;
/** 直播失效判定：同频道连续起播失败次数 */
export const LIVE_DEAD_STREAK = 2;

/* ---------- v1.7：弹幕（CHG-22） ---------- */
/** 同屏弹幕密度上限 */
export const DANMAKU_MAX_ONSCREEN = 150;
/**
 * 单集弹幕保存上限（超出按时间均匀抽稀）。
 * 腾讯每 30s 最多下发 600 条，一集可达 5 万+、缓存 3.4MB；渲染层同屏仅几十条，
 * 整季预取累加会到百 MB 级，因此按时间分布抽稀而不是全量保存。
 */
export const DANMAKU_MAX_PER_EPISODE = 10_000;
/** 弹幕缓存 TTL（30 天；命中缓存不发网络请求） */
export const DANMAKU_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** dandanplay 匹配接口基址（appId/secret 就绪前不启用该 Provider） */
export const DANMAKU_DANDANPLAY_BASE = 'https://api.dandanplay.net';

/* ---------- v1.7：EPG（CHG-23） ---------- */
/** EPG 缓存 TTL */
export const EPG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 默认 EPG 端点（diyp 风格） */
export const EPG_DEFAULT_ENDPOINT = 'https://epg.112114.eu.org';

/* ---------- v1.7：推荐订阅（CHG-24） ---------- */
/** 内置推荐订阅清单版本（清单内容见 src/data/recommended/recommended.json） */
export const RECOMMENDED_SUBSCRIPTIONS_VERSION = 1;

/* ---------- EXT-06（FR-66 ~ FR-71）：IPTV/EPG 增强 ---------- */
/** 内置默认 EPG 源 id（不可删除，端点为既有 EPG_DEFAULT_ENDPOINT） */
export const BUILTIN_EPG_SOURCE_ID = 'epg-builtin';
/** 用户新增 EPG 源数量上限（不含内置源，对齐 FR-66） */
export const EPG_SOURCE_MAX = 10;
/**
 * 同时启用的 EPG 源上限。默认 5 对齐需求 AC-155「第 6 个启用源被拒绝」与方案 §4.4；
 * 任务书 Q-15 记为 3，二者冲突已上报协调者，可在 `AppSettings.epg.maxEnabled` 覆盖。
 */
export const EPG_SOURCE_ENABLED_MAX = 5;
/** 多源合并/预取并发闸门 */
export const EPG_MERGE_CONCURRENCY = 3;
/** 节目单预取频道数上限 */
export const EPG_PREFETCH_MAX = 30;
/** EPG 拉取超时（沿用既有 6s） */
export const EPG_FETCH_TIMEOUT_MS = 6000;
/** EPG 源探测超时 */
export const EPG_PROBE_TIMEOUT_MS = 8000;
/** EPG 缓存键前缀：`epgv2:{sourceId}:{channelKey}:{yyyy-MM-dd}` */
export const EPG_CACHE_KEY_PREFIX = 'epgv2';

/** 回看天数上限（缺省 1 天，见 LiveCatchupSettings.days） */
export const CATCHUP_MAX_DAYS = 7;
/** 回看能力探测结果 TTL（6h） */
export const CATCHUP_PROBE_TTL_MS = 6 * 60 * 60 * 1000;
/** 单次回看探测超时（HEAD → GET Range） */
export const CATCHUP_PROBE_TIMEOUT_MS = 3000;
/** kv 中存放回看探测结果的 key */
export const KV_KEY_CATCHUP_PROBES = 'live-catchup-probes';
/** 回看起播超时（FR-68：沿用直播 5s 口径，超时给出错误 + 重试/返回节目单） */
export const TIMEOUT_REPLAY_START_MS = 5000;

/** 单直播源自定义分组数上限 */
export const LIVE_GROUP_MAX = 20;
/** 分组名长度上限 */
export const LIVE_GROUP_NAME_MAX = 10;
/** 单 scope 自定义排序项上限（超出禁止拖拽） */
export const CHANNEL_ORDER_MAX = 300;

/** 非终态节目提醒上限 */
export const REMINDER_MAX = 50;
/** 可选的提前量（分钟） */
export const REMINDER_LEAD_OPTIONS = [0, 5, 10, 15, 30] as const;
/** 提醒错过判定宽限：startAt + 10min 仍未触发 → missed */
export const REMINDER_GRACE_MS = 10 * 60 * 1000;
