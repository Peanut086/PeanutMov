# 契约变更 CHG-05 —— 线路质量管理

| 项目 | 内容 |
| --- | --- |
| 文档编号 | TSD-004 |
| 版本 | v1.2 |
| 日期 | 2026-10-21 |
| 上游 | `docs/02-方案/技术方案.md` 第 17 章、第 16 章 CHG-05 行；`docs/01-需求/需求规格说明书.md` FR-47 / FR-48 / AC-106 ~ AC-111 |
| 提出方 | 需求&方案（架构师） |
| 状态 | **待 PM 批准**；批准前双方不得编码 |
| 性质 | **纯新增 + 一处常量调整**（`HEALTH_CHECK_CONCURRENCY` 3 → 6），不改既有类型/签名/编号 |

---

## 1. 变更摘要

用户提供 49 条第三方 TVBox 订阅地址，实测可用性极差：仅 16 条返回可解析 JSON，19 条 200 但返回 HTML/BMP/PNG/纯文本，4 条 401/403，2 条 404，7 条超时/DNS 失败。

按已冻结的合规基线 **FR-46：App 不内置、不分发任何第三方片源接口**，用户选择**方案 A**：App 不内置任何具体线路，只把"TVBox 兼容能力 + 线路质量可见性"做扎实。因此本补丁**不含任何线路数据**，只补"看清质量、按质量排序、快速测完、坏了自动躲开、错因说得明白"这五件事：

| # | 缺口（现状） | 本补丁 |
| --- | --- | --- |
| 1 | `HealthCheckResult.latencyMs` 已采集但 UI 未使用；只有 `ok/timeout/...` 6 态粗粒度文案 | 新增 `HealthTier` 6 档分级（极速/快速/一般/较慢/异常/未检测），阈值常量化可单测 |
| 2 | `SourceListView` 只按 `builtin + sort` 排，无法按质量排 | 新增 `SourceSortMode = 'manual' \| 'tier'`，偏好存 `localStorage` |
| 3 | 全量测速并发 3，49 条要等很久且只有"检测中…" | 并发提到 6（50 源 < 25s），新增 `sources:healthProgress` 逐源进度 |
| 4 | 打开已失效源只得到错误页 | `browse` 失败且有 `health === 'ok'` 的替代源时自动切一次 + Toast 告知，只切一次 |
| 5 | "200 但返回 HTML"被报成 `E_PARSE`（"数据解析失败，源可能已变更"），用户误以为配置写错 | `SiteAdapter` 区分非 JSON / 认证 / 404 / 网络四类，文案改为"该地址返回的不是订阅 JSON，可能是网页地址或已被拦截" |

**合规边界（AC-105 复述）**：49 条地址一条都不进仓库、不进打包产物、不进演示数据、不进文档示例；本补丁不新增任何抓取/探测目标，探测对象恒等于用户已配置且已启用的源。

## 2. 新增条目

### 2.1 新增文件：`src/shared/healthTier.ts`

纯函数 + 常量，无 IO / 无 DOM / 无 Pinia 依赖（`shared/` 层约束）。

```ts
import type { Source, SourceHealth } from '@/types';

export type HealthTier = 'fast' | 'good' | 'fair' | 'slow' | 'bad' | 'unknown';

export const HEALTH_TIER_THRESHOLDS = { fastMaxMs: 300, goodMaxMs: 800, fairMaxMs: 2000 } as const;

export const HEALTH_TIER_LABELS: Record<HealthTier, string> = {
  fast: '极速', good: '快速', fair: '一般', slow: '较慢', bad: '异常', unknown: '未检测',
};

export const HEALTH_TIER_ORDER: Record<HealthTier, number> = {
  fast: 0, good: 1, fair: 2, slow: 3, bad: 4, unknown: 5,
};

export function healthTierOf(health: SourceHealth, latencyMs: number | null): HealthTier;

export type SourceSortMode = 'manual' | 'tier';
export const SOURCE_SORT_MODE_STORAGE_KEY = 'peanutmov.sourceSortMode';
export function readSourceSortMode(): SourceSortMode;
export function writeSourceSortMode(mode: SourceSortMode): void;
export function sortSources(
  sources: readonly Source[],
  mode: SourceSortMode,
  latencyOf: (sourceId: string) => number | null,
): Source[];
```

**`healthTierOf` 判定顺序（必须按序短路）**

| 步骤 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `health === 'unknown'` | `unknown` |
| 2 | `health !== 'ok'` | `bad` |
| 3 | `latencyMs` 非有限数 / `null` / `< 0` | `bad` |
| 4 | `≤ 300` | `fast` |
| 5 | `≤ 800` | `good` |
| 6 | `≤ 2000` | `fair` |
| 7 | 其余 | `slow` |

**`sortSources` 规则**

- `manual`：`builtin` 升序 → `sort` 升序（与 `SourceListView` 现有 `ordered` 逐字等价，含演示源恒最后）。
- `tier`：`HEALTH_TIER_ORDER[tier]` → `latencyMs`（`null` 最后）→ `sort` → `name`（`localeCompare('zh-Hans-CN')`）→ `id`。
- `tier` 模式**不特判 `builtin`**：演示源延迟极小，自然落 `fast` 靠前（AC-108 断言）。
- 不修改入参，返回新数组；同一输入多次排序结果一致。

**`localStorage` 偏好**

| 项 | 值 |
| --- | --- |
| key | `peanutmov.sourceSortMode`（字面量，点号） |
| value | `'manual'` / `'tier'`，纯字符串 |
| 缺省/非法/读写异常 | `'manual'`；写入失败静默吞掉，内存态仍生效 |
| 不进 | `AppSettings`、备份文件、`src/types/index.ts` |

> 既有 `useTheme` 用 `peanutmov:theme`（冒号），本 key 按 PM 指定用点号。风格不一致属已知项，本期不统一（改 key 会使已存偏好失效），后续如需统一另起 CHG 并做兼容读取。

### 2.2 新增事件：`sources:healthProgress`

`src/services/events.ts` 的 `AppEventMap` 增加一行：

```ts
'sources:healthProgress': { done: number; total: number };
```

| 规则 | 约定 |
| --- | --- |
| 发送方 | `sourceService.checkHealth()`（唯一） |
| 起点 | `{ done: 0, total }` |
| 步进 | 每完成一个源（`markHealth` 之后，成功失败均计）发 `{ done: n, total }`，严格 +1 |
| 终点 | `{ done: total, total }` |
| `total === 0` | 只发 `{ done: 0, total: 0 }` |
| 整体失败 | 不发终点事件 |

UI 文案：`检测中 {done}/{total}`（例：`检测中 12/49`）。

### 2.3 新增方法（挂在既有 API 编号下，不新增 API-16）

| 归属 | 新增 | 说明 |
| --- | --- | --- |
| API-06 `LibraryService` | `pickFallbackSource(failedSourceId: string): Promise<Source \| null>` | 只读查询候选，**不做切换**（切换由 `libraryStore` 执行以保证必须告知） |
| API-14 `sourceStore` | `latencyOf(sourceId): number \| null` | 代理 `healthService.lastSnapshot()`，因 UI 不得 import `healthService` 且 `Source` 无 `latencyMs` |
| API-14 `sourceStore` | `state.healthProgress: { done, total } \| null` | 订阅 `sources:healthProgress`；`refreshHealth()` 结束置 `null` |
| `healthService` | `latencyOf(id)` / `tierOf(id)` | 纯新增，既有 6 个方法签名不变 |
| `HealthBadge` props | `tier?: HealthTier`、`latencyMs?: number \| null` | **均可选**；`tier` 缺省时行为与现状逐字一致（既有调用零回归） |

**候选选择（`pickFallbackSource`）**：过滤 `enabled && health === 'ok' && id !== failedSourceId` → `builtin` 升序 → `HEALTH_TIER_ORDER` 升序 → `latencyMs` 升序（`null` 最后）→ `sort` 升序 → `id` 升序，取首个。

### 2.4 新增需求与验收标准

| 编号 | 内容 |
| --- | --- |
| FR-47 | 线路质量分级与排序（P1），AC-106 ~ AC-108 |
| FR-48 | 失效线路自动跳过（P1），AC-109 ~ AC-111 |
| AC-106 | 分级阈值边界（300/301、800/801、2000/2001）+ 非 ok / 无延迟 / 未检测 |
| AC-107 | 并发 6、50 源全量 < 25s、进度事件 `done` 严格递增至 `total` |
| AC-108 | `tier` 排序全序正确 + 同档按延迟 + `manual` 与现状一致 + 偏好跨重启保持 |
| AC-109 | 自动切换有 Toast、当前源同步、无白屏 |
| AC-110 | 无候选不切；同一组合只切一次（累计 1 次） |
| AC-111 | 非 JSON → `E_UNSUPPORTED_FORMAT` + 指定文案 + `bad_config`；401/403/404/网络分类正确；`ErrorCode` 未新增 |

### 2.5 新增错误分类（不新增 `ErrorCode`）

| 现象 | 分类标签 | code（既有枚举） | `message` | `health` |
| --- | --- | --- | --- | --- |
| 200 + HTML | `E_FORMAT_UNSUPPORTED` | `E_UNSUPPORTED_FORMAT` | 该地址返回的不是订阅 JSON，可能是网页地址或已被拦截 | `bad_config` |
| 200 + 图片（BMP/PNG） | `E_FORMAT_UNSUPPORTED` | `E_UNSUPPORTED_FORMAT` | 同上 | `bad_config` |
| 200 + 非 JSON 文本 | `E_FORMAT_UNSUPPORTED` | `E_UNSUPPORTED_FORMAT` | 同上 | `bad_config` |
| 200 + JSON 但缺 `list`/`class` | `E_FORMAT_UNSUPPORTED` | `E_UNSUPPORTED_FORMAT` | 该地址返回的 JSON 不是 TVBox 订阅格式（缺少 list/class 字段） | `bad_config` |
| 401 | `E_AUTH` | `E_AUTH` | 认证失败，请检查账号或 Token | `auth_failed` |
| 403 | `E_AUTH` | `E_HTTP_403` | 无权限访问(403) | `auth_failed` |
| 404 | `E_HTTP_404` | `E_HTTP_404` | 资源不存在(404) | `unreachable` |
| 超时 / DNS | `E_NETWORK` | `E_TIMEOUT` / `E_NETWORK` | 请求超时，请稍后重试 / 网络不可用，请检查网络后重试 | `timeout` / `unreachable` |

> 注意：用户口语中的 `E_FORMAT_UNSUPPORTED` 是**分类标签**；代码里必须用既有枚举 **`E_UNSUPPORTED_FORMAT`**（语序不同），不得新造枚举值。具体原因（Content-Type、响应片段前 80 字符、顶层键名）写入 `detail`，不写进 `message`。

## 3. 修改条目（既有条目只加注，不改语义）

| 位置 | 修改 | 影响 |
| --- | --- | --- |
| `src/shared/constants.ts` | `HEALTH_CHECK_CONCURRENCY` 3 → **6** | **唯一常量调整**；AC-16 措辞同步为"并发上限 6"，判定阈值（5 源 ≤ 6s）与结论不变 |
| 技术方案 API-03 | `checkHealth` 注释补"并发 6 + 发 `sources:healthProgress`" | 签名不变 |
| 技术方案 API-06 | 增补 `pickFallbackSource` | 纯新增方法 |
| 技术方案 API-14 | `sourceStore` 增补 `healthProgress` + `latencyOf` | 既有 state/getters/actions 零改动 |
| 技术方案 3.2 | 文件清单增 `src/shared/healthTier.ts` | 新增 SCF 文件 |
| 技术方案 8.3 | 事件总线列表增 `sources:healthProgress` | 纯新增 |
| 技术方案 14 章 | 增 v1.2 行 + 补丁说明第 6 条 | 流程记录 |
| 技术方案 16 章 | 增 CHG-05 行 + 对 AC-16 的影响说明 | 流程记录 |
| 技术方案 17 章 | **新增整章**「线路质量管理」 | 本补丁主体 |
| SRS 3.2 | Out of Scope 增"不内置任何第三方线路/订阅地址" | 呼应 FR-46 |
| SRS FR-07 / AC-16 | "并发上限 3" → "并发上限 6" | 措辞更新，阈值不变 |
| SRS 8 章 | 追踪表增 FR-47/FR-48；统计 48 FR / 111 AC | 纯新增 |

## 4. 影响文件清单

| 责任方 | 文件 | 动作 | 说明 |
| --- | --- | --- | --- |
| SCF | `src/shared/healthTier.ts` | **新建** | 2.1 全部导出；纯函数，无 IO |
| SCF | `src/shared/constants.ts` | 修改 | `HEALTH_CHECK_CONCURRENCY` 3 → 6 |
| PKG-B | `src/services/events.ts` | 修改 | `AppEventMap` 加 `sources:healthProgress` |
| PKG-B | `src/services/healthService.ts` | 修改 | 加 `latencyOf` / `tierOf`；既有方法不变 |
| PKG-B | `src/services/sourceService.ts` | 修改 | `checkHealth` 内按 17.5.2 发进度事件（起点/逐源/终点）；并发常量走 import，不写死 |
| PKG-B | `src/services/libraryService.ts` | 修改 | 加 `pickFallbackSource`；`markSourceUnreachable` 扩展为按 `healthOfError` 映射的 `markSourceFailed` |
| PKG-B | `src/stores/sourceStore.ts` | 修改 | 加 `latencyOf` + `healthProgress` 订阅（API-14 纯新增） |
| PKG-B | `src/stores/libraryStore.ts` | 修改 | 自动跳过编排 + 防抖（`Set<(from→to)>`，内存态） |
| PKG-B | `src/sources/site/SiteAdapter.ts` | 修改 | `request()` 用 `requestWithMeta` 读 Content-Type；非 JSON/HTML/图片/缺 `list`/`class` → `E_UNSUPPORTED_FORMAT` + detail |
| PKG-A | `src/components/source/HealthBadge.vue` | 修改 | 可选 props `tier`/`latencyMs`；6 档 tone；`bad` 显示具体故障文案；`fast` 用新紫色 token |
| PKG-A | `src/views/SourceListView.vue` | 修改 | 排序模式切换（写 `localStorage`）+ `sortSources` + `检测中 {done}/{total}` |
| PKG-A | `src/styles/tokens.css` | 修改 | 新增 `--color-tier-fast` / `--color-tier-fast-soft`（深浅两主题，值由 UI 按设计规范体系给出，对比度 ≥ 4.5:1） |
| 双方 | `docs/02-方案/技术方案.md`、`docs/01-需求/需求规格说明书.md`、本文 | 已完成 | 方案侧交付物 |

**不需要改**

- `src/types/index.ts`（`HealthTier`/`SourceSortMode` 放 `shared/healthTier.ts`；`Source` 不加 `latencyMs`；`AppSettings` 不加排序偏好）。
- `ErrorCode` 枚举（沿用 `E_UNSUPPORTED_FORMAT` / `E_AUTH` / `E_HTTP_403` / `E_HTTP_404` / `E_TIMEOUT` / `E_NETWORK`）。
- `docs/03-设计规范/设计规范.md`（紫色 token 由 UI 侧新增，规范文档本期不动）。
- `src/sources/base/BaseAdapter.ts`（`healthOfError` 映射已覆盖全部所需 code）。
- `src/sources/base/httpClient.ts`（`E_PARSE` 语义被其它适配器依赖，只在 `SiteAdapter` 内包装）。
- `src/db/**`、路由表、`src/services/importService.ts`、`src/services/backupService.ts`。

**白名单说明（PKG-A 必读）**：UI 仍**不得** import `@/services/healthService` / `@/services/libraryService` / `@/services/sourceService`。分级与排序用 `@/shared/healthTier`（在 `@/shared/*` 白名单内），延迟与进度用 `sourceStore.latencyOf` / `sourceStore.healthProgress`。

## 5. 回归范围

| 层级 | 范围 | 通过标准 |
| --- | --- | --- |
| 单测（新增） | `tests/unit/healthTier.spec.ts`：`healthTierOf` 全边界（AC-106）、`sortSources` 两模式全序与稳定性（AC-108）、`readSourceSortMode` 缺省/非法/写入失败 | 全绿；测试内无 300/800/2000 字面量（引用 `HEALTH_TIER_THRESHOLDS`） |
| 单测（新增） | `tests/unit/sourceService.spec.ts` 追加：并发上限 6、50 源 < 25s（假计时器）、`sources:healthProgress` 序列 `0→1→…→total` 不重不漏、`total === 0` 只发一次（AC-107） | 全绿 |
| 单测（新增） | `tests/unit/libraryService.spec.ts` 追加：`pickFallbackSource` 候选过滤与排序、无候选返回 `null`、不改任何状态 | 全绿 |
| 单测（新增） | `tests/unit/siteAdapter.spec.ts`：HTML / 图片 / 非 JSON 文本 / 缺 `list`+`class` → `E_UNSUPPORTED_FORMAT` 且 `health === 'bad_config'`；401 → `E_AUTH`；403 → `E_HTTP_403`；404 → `E_HTTP_404`；超时/DNS → `E_TIMEOUT`/`E_NETWORK`（AC-111） | 全绿 |
| 单测（回归） | `errors.spec.ts`（`ErrorCode` 枚举条目数不变）、`httpClient.spec.ts`（`E_PARSE` 语义不变）、`sourceService.spec.ts` 既有 AC-15/16 用例、`libraryService.spec.ts` 既有 browse 缓存/离线用例、`sourceStore.spec.ts` | 全绿，无断言改写（AC-16 仅措辞变化） |
| 组件（回归） | `HealthBadge` 既有 6 态映射关系不变（不传 `tier` 时文案/色调与现状一致；仅 neutral 底色由硬编码 `rgba(255,255,255,0.08)` 换为既有 `--color-border` token，深色下等价）；新增 `tier` 6 档 + `latencyMs` 文案 + `withText=false` 的 sr 文案 | 全绿 |
| E2E（源管理） | 导入 3 源（1 可用 / 1 返回 HTML / 1 返回 404）→ 测速：进度从 `0/3` 递增到 `3/3`，徽标分别 `极速/异常/异常`，HTML 源点击后提示"不是订阅 JSON"（AC-111 手工复核）；切 `tier` 排序 → 顺序变化 → 重启保持（AC-108） | 全部符合 |
| E2E（媒体库） | 默认源设为失效源 → 打开媒体库：Toast「「B」暂不可用，已自动切换到「A」」+ 海报墙为 A + 当前源标识 A（AC-109）；仅 1 源失效 → 无切换、错误态提示可手动切换（AC-110） | 全部符合 |
| 手工（合规） | 全仓搜索 TVBox 接口特征（`api.php/provide/vod`、`?ac=detail`、`m3u8` 常量、49 条域名）→ 仓库/`dist`/`android` 产物中零命中（AC-105） | 零命中 |
| 构建 | `npm run typecheck` + `npm run build` | 无新增 TS 错误；`ErrorCode` 枚举未变 |

## 6. 风险与取舍

| 项 | 取舍 | 理由 |
| --- | --- | --- |
| 并发 3 → 6 | 采用 | 探测只在用户主动触发时发生、`retries = 0`、单源最多 1 请求；50 源最坏 27s（9 波 × 3s），目标场景 < 25s。不再提高，避免瞬时连接数失控 |
| 换源放 `libraryStore` 而非 `libraryService.browse()` | 采用 | `PageResult<MediaItem>` 不带 `sourceId`，服务层静默换源会让海报墙挂 A 的分类显示 B 的内容，用户无法判断；且违反"必须告知" |
| 非 JSON 用 `E_UNSUPPORTED_FORMAT` 而非新增 `E_FORMAT_UNSUPPORTED` | 采用 | `ErrorCode` 冻结且 `errors.spec.ts` 断言枚举；`E_UNSUPPORTED_FORMAT` 已被 `healthOfError` 映射为 `bad_config`，语义吻合。具体原因进 `detail` |
| 紫色 token | UI 侧新增 | 现有色板无紫色原始值，本期不改设计规范文档；`--color-tier-fast` / `--color-tier-fast-soft` 由 UI 按 primitive→semantic 体系给出，深浅主题各一组，对比度 ≥ 4.5:1 |
| 排序偏好存 `localStorage` 而非 `AppSettings` | 采用 | 纯本机 UI 偏好，不值得进 DB/备份/迁移；与 `useTheme` 的既有做法一致 |
| 自动跳过只切一次 | 采用 | 防抖动与"源连环失效"导致页面反复跳变；切换后仍失败即停在错误态，把决定权交回用户 |

## 7. 流程与批准

1. 需求&方案方出具本文件 + `技术方案.md` 第 17 章 + 第 16 章 CHG-05 行 + SRS FR-47/FR-48（**已完成**）。
2. PM 批准后，在 `技术方案.md` 第 14 章变更记录表把 v1.2 行批准人由"待 PM"改为实名。
3. 双方同步：PKG-B 先落地 `healthTier.ts` 消费方（`healthService` / `sourceService` / `libraryService` / 两个 Store / `SiteAdapter`），PKG-A 随后接 `HealthBadge` / `SourceListView` / `tokens.css`。
4. 后续追加变更另起 `CHG-06`，不得并入本补丁。
