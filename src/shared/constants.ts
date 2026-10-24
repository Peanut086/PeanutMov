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
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : '未知版本';

/** 构建时间戳（毫秒）；未注入时为 null，UI 不展示构建日期（REV-19） */
export const BUILD_TIME: number | null =
  typeof __BUILD_TIME__ === 'string' && __BUILD_TIME__.length > 0 ? Date.parse(__BUILD_TIME__) : null;

/* ---------- IndexedDB ---------- */
export const DB_NAME = 'cinema-db';
/** v2（CHG-13）：新增 lives store（直播播放列表） */
export const DB_VERSION = 2;

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
/** 健康检查并发上限（AC-16；CHG-05 由 3 提升为 6） */
export const HEALTH_CHECK_CONCURRENCY = 6;
/** 订阅拉取 */
export const TIMEOUT_SUBSCRIPTION_FETCH_MS = 10000;
/** 远程搜索单源超时（AC-24） */
export const TIMEOUT_SEARCH_MS = 5000;
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
export const GESTURE_DOUBLE_TAP_INTERVAL_MS = 300;
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
