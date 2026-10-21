# 前端自测记录 —— 契约 v1.1 接入与 E2E 缺陷返工

| 项目 | 内容 |
| --- | --- |
| 文档编号 | QA-UI-002 |
| 日期 | 2026-10-21 |
| 执行人 | UI&前端（PKG-A） |
| 范围 | 接契约 v1.1（CHG-01 / CHG-02），修复 E2E 实测暴露的 BUG-02/03/04/05 |
| 环境 | Windows 11 · Node v22.23.0 · Vite 6（dev `http://localhost:5175`） · Chrome（`--headless=new`，CDP :9446） |
| 结论 | **通过**：E2E-01~25 **25/25**，补充验收 7/7，typecheck 0 / build 0 / vitest 157 用例全绿 |
| 未改动 | `src/services/**`、`src/db/**`、`src/sources/**`、`src/stores/**`、`src/types/index.ts`、`src/shared/**`、`package.json` 均未修改（`git status` 可核） |

---

## 1. 交付统计

| 项 | 数量 | 文件 |
| --- | --- | --- |
| 修改视图 | 5 | `SourceFormView.vue`、`SourceListView.vue`、`ImportSubscriptionView.vue`、`DetailView.vue`、`BackupView.vue` |
| 修改组件 | 1 | `SourceForm.vue`（仅注释：删除"真实调用由数据包提供"的过期说明） |
| 修改脚本 | 1 | `scripts/review-e2e.cjs`（下载行为修 CDP 作用域、导入按钮选择器、下载字段断言） |
| 新增脚本 | 1 | `scripts/review-supplement.cjs`（BUG-02 编辑/测试/删除、BUG-03 结果明细、BUG-04 单集直下） |
| 删除占位实现 | 约 210 行 | 临时订阅解析（`SuggestionView` 内 74~300 行）与 3 处"暂未开放"文案全部移除 |
| 新增截图 | 12 张 | `docs/03-设计规范/preview/review-15a/22/23/26~33*.png` |

### 1.1 占位文案清零核验

```bash
$ grep -rn "暂未开放" src/
（无匹配）
```

`grep -rn "本地校验" src/` 仅剩 `SourceForm.vue` 第 10 行的一处**准确性说明**（"本组件只做表单与本地校验"），指表单自身的地址格式校验，不再用于测试连接的结论话术。

## 2. 契约 v1.1 接入点

| 契约条目 | 接入位置 | 说明 |
| --- | --- | --- |
| `sourceStore.create(input)` | `SourceFormView.onSubmit`（新增分支） | 返回 `Source`，成功后 Toast `已添加「name」` + `router.replace('/settings/sources')` |
| `sourceStore.update(id, patch)` | `SourceFormView.onSubmit`（编辑分支） | patch 直接传 `SourceInput`；地址变更的清缓存逻辑在 Service 内，UI 不重复处理 |
| `sourceStore.remove(id)` | `SourceFormView.removeSource`、`SourceListView.remove` | 均先 `ui.confirm`；`removeDownloads` 未传（保留下载文件，与列表气泡文案一致） |
| `sourceStore.testConnection(input)` | `SourceFormView.onTest` | 用未保存的表单值探测；`ok` → 展示 `message + （N ms）`；`ok:false` → 原样展示失败原因 |
| `importStore.previewFromUrl/File/Text` | `ImportSubscriptionView.fetchPreview` / `onFileChange` | 直接消费 `state.preview`（`ImportPreview`，非临时结构）与 `state.parsing/error` |
| `importStore.commit(options)` | `ImportSubscriptionView.commit` | `selectedKeys` 取本地勾选，`onDuplicate` 取同名策略；返回值即 `ImportResult` |
| `importStore.reset()` | `onMounted` / `closeResult` / `leave` | 进入页面清空上次会话；提交成功后清空避免重复提交（`records` 由 Store 保留） |

**未直连 Service**：`grep -n "@/services/" src/views/ImportSubscriptionView.vue` 无匹配；`SourceFormView` 同理。数据层实现零改动。

### 2.1 BUG-03 的"跳过"口径（重要，需 PM 知悉）

`importService.commit()` 返回的 `ImportResult.skipped` **只统计"同名已存在被跳过"**，不含预览阶段就判定无效（如缺 api）的条目。E2E-21/AC-13 要求"成功 2 / 跳过 1"的口径包含后者，因此 UI 在提交瞬间快照 `invalidAtCommit`（= 预览中 `valid:false` 的条数），结果面板与 Toast 展示 `skipped + invalidAtCommit`，并单列一行说明"其中 N 个源因配置不完整（如缺 api）未提交"。

> 该补偿只发生在前端展示层，**未修改 `ImportResult` 类型或 Service 行为**。若希望由数据层统一口径，请 PM 派 PKG-B 评估（见第 7 节）。

## 3. 每个 BUG 的根因与修复

### BUG-02（P0）源管理无法新增/编辑/删除/测试连接

- **根因**：不是逻辑 bug，而是契约缺口——API-14 旧版 `sourceStore` 只有 5 个 action，`sourceService.create/update/remove/testConnection` 不在 UI import 白名单内，视图只能留占位。
- **修复**：`SourceFormView` / `SourceListView` 改调 v1.1 新增的 4 个 action；`onTest` 从"320ms 延时 + 地址格式判断"改为真实探测；`removeSource` 在 `ui.confirm` 之后真实删库并 `router.replace`；错误统一 `toErrorShape(e).message`。删除中态（`removing`）禁用按钮并显示 spinner，避免重复提交。
- **验证**：SUP-01 落库 + 路由回列表；SUP-02 不可达地址返回 `失败`（日志 `请求超时，请稍后重试`）；SUP-03 改名落库；SUP-04 删除后 `sources` 表无该 id。

### BUG-03（P0）订阅导入不落库

- **根因**：同上，`importService` 未在 2.2 白名单内，视图内自带约 210 行临时解析，`commit()` 固定返回"暂未开放"的假 `ImportResult`。
- **修复**：删掉临时解析（`buildPreview`/`typeOf`/`fileSizeError` 等）、`fetch` 直连与手写敏感词表；改 `useImportStore()`。预览按真实 `ImportPreview` 适配（`entries[].valid/selected/duplicateOf/warning/issues/normalized`、`globalIssues`），并补"将跳过 N 个源"逐条原因块。结果面板按 `ImportResult` 渲染 `success/skipped/failed/sourceIds/issues`。源列表刷新由 `sources:changed` 驱动，UI 不双写。
- **附带修复**：E2E 的 `CLICK('导入')` 会被分段控件「**从链接导入**」先命中（文本包含匹配），改为 `CLICK_SEL('.import-commit')`。
- **验证**：SUP-05 `sources` 1→3、结果面板 `成功 2 · 跳过 1 · 失败 0`；SUP-06 缺 api 条目展示"第 3 条缺少 api 字段"。

### BUG-04（P0）详情页下载入口"找不到"

- **根因（两层，第一层是真正的视觉缺陷）**：
  1. **背景层遮挡（真因）**：`.detail__backdrop` 是 `position: absolute`，而 `.detail-actions__icon`（收藏/下载/投屏）是静态定位；两者同处 `.detail` 这一 static 容器，绝对定位元素必然绘制在静态元素之上。`pointer-events: none` 只让按钮**可点**，却不让它**可见**——`.detail__backdrop-fade` 用的 `--gradient-hero` 下缘是不透明纯色（`#0b0b0f`），正好把 254~302px 处的三个图标按钮整块涂掉。主按钮「播放」之所以可见，是因为全局 `.btn { position: relative }` 把它抬到了背景之上。
     - 证据：探针读取三个按钮的计算样式，`display:flex / visibility:visible / opacity:1 / color:rgb(245,245,247)` 全部正常，`document.elementFromPoint()` 也命中按钮（命中测试对"被同色图层覆盖"不敏感），但截图区域全黑；强制 `background:red` 后仍不可见 → 确认是绘制顺序而非样式缺失。
  2. **判定条件错位**：单集电影（如演示 Big Buck Bunny）`aria-label` 为「下载」，而多线路单集电影（Sintel，双线路各 1 集）原逻辑 `isSeries` 为 `false`，`aria-label` 退化成「下载」且点击直接建任务——但 E2E 约定的入口是「选择集数下载」+ 抽屉。
- **修复**：
  - `DetailView` 样式：`.detail__backdrop { z-index: 0 }` + `.detail__scroll { position: relative; z-index: 1 }`，让内容层稳定压在背景之上（并加注释说明原因，防止回归）。
  - 新增 `needsEpisodePicker = episodes.length > 1 || lines.length > 1`，替代 `isSeries` 决定 `aria-label` 与是否开抽屉：**单集单线路电影点「下载」直接建任务**；多集或**多线路（即使每线路仅 1 集）**开抽屉，抽屉内「全选」「开始下载」文案不变。
  - `downloadEpisodes` 改为 `library.toDownloadInputs(it.id, ids, currentLineId)`——三参传入当前线路，`CreateDownloadInput` 全部由 Store 生成，不手工拼字段；并过滤 `inputs.length === 0` 的空结果。
  - E2E-16 增加回归护栏：断言按钮 `found + inViewport + elementFromPoint 命中`，并断言任务记录的 `sourceId/mediaId/episodeId/url/format/title` 均非空。
- **验证**：E2E-16 通过（`sourceId/mediaId/episodeId/url/title` 全 true）；E2E-17 任务完成写 `blobKey`；SUP-07 单集电影不开抽屉且 `downloads` 0→1。

### BUG-05（P0）备份导出在浏览器无文件产出

- **根因：两条独立原因叠加，应用代码不是主因。**
  1. **E2E 脚本的 CDP 作用域错误（主因）**：`connect()` 用 `Target.createBrowserContext` 建了独立的 incognito 上下文，但 `Browser.setDownloadBehavior` 是在 **page session** 上、且**不带 `browserContextId`** 调用的。该命令作用于**默认**上下文，因此本上下文里的下载不会落盘，`readdirSync(DL_DIR)` 恒为空。
     - 对比实验：同一页面、同一按钮，`browser session + browserContextId` → 目录立刻出现 `peanutmov-backup-*.json`；page session 不带 id → 目录为空。两次都收到 `Page.downloadWillBegin`（`suggestedFilename` 正确、`totalBytes:1642`），证明**文件确实生成了、只是没落到指定目录**。
  2. **应用侧两处脆弱点**（不导致本次失败，但确属隐患）：`<a>` 按下后立刻 `removeChild` 且 1s 后 `revokeObjectURL`，慢盘/headless 下可能读到空 blob；`catch` 分支只 Toast "不支持直接下载"，未区分"浏览器阻止下载"。
- **修复**：
  - 脚本：改为 `cdp.send('Browser.setDownloadBehavior', { behavior:'allow', downloadPath: DL_DIR, browserContextId })`（browser session + 显式 context），并加注释。
  - 应用：`triggerDownload` 返回 `boolean`（真实是否触发点击），`a.style.display='none'` 保留在 DOM 中，60s 后再移除并 `revokeObjectURL`；Blob MIME 兜底为 `application/json`；空 Blob 抛 `E_INVALID_STATE`；成功 Toast 带文件大小，失败 Toast 明确"浏览器阻止了文件下载"，`catch` 改为 `导出失败：<原因>`（不再只提示"不支持"）。**未伪造任何成功状态**。
- **验证**：E2E-22 落盘成功并通过 `schemaVersion === 1`、`sources` 为数组、脱敏（`auth.password/token` 为 null）校验；E2E-23 该文件可被导入页解析出 `源 4 · 收藏 1 · 历史 1`。
- **结论**：**不属于 headless 限制**。headless Chrome 在正确设置 `Browser.setDownloadBehavior` 作用域后可正常落盘，故无需提供替代验证。

## 4. E2E 前后对比

| 阶段 | 通过 | 失败项 |
| --- | --- | --- |
| 返工前（基线，`BASE_URL=http://localhost:5175`） | **19/25** | E2E-16、17（下载入口）、20（新增源不落库）、21（导入不落库）、22（导出无文件）、23（无备份可导入） |
| 返工后 | **25/25** | — |

另跑 `scripts/review-supplement.cjs`（覆盖 E2E 未涉及的编辑/测试连接/删除与单集直下）：**7/7**。

### 4.1 真实命令输出

```text
=== 25/25 passed, 0 failed ===
PASS E2E-16 详情页选择集数下载并生成任务（AC-69） :: [{"status":"downloading","format":"mp4","total":22306323,"sink":"idb-blob","sourceId":true,"mediaId":true,"episodeId":true,"url":true,"title":"Sintel"}]
PASS E2E-17 下载任务完成并写 blobKey（Web 落盘） :: {"items":1,"statuses":["completed"],"completedBytes":22306323,"blobKey":"0f928b1b-…"}
PASS E2E-20 新增 AList 源可保存并出现在源列表（AC-03） :: {"before":1,"after":2}
PASS E2E-21 订阅链接解析并提交写入源（AC-08/13） :: {"before":2,"after":4}
PASS E2E-22 备份导出 JSON 且默认脱敏、含 schemaVersion :: {"file":"peanutmov-backup-2026-10-21.json","sources":4,"favorites":1,"history":1,"downloads":0,"redacted":true}
PASS E2E-23 备份文件可解析预览并导入（AC-89） :: {"parsed":true,"text":"…已选择：peanutmov-backup-2026-10-21.json 源 4 · 收藏 1 ·"}
```

```text
=== 7/7 passed, 0 failed ===
PASS SUP-01 新增源保存后落库并 replace 到源列表 :: {"name":"补充 AList","key":"alist-853bfa66"}
PASS SUP-02 测试连接展示真实结果（不可达地址 → 失败，非"本地校验"） :: {"text":"请求超时，请稍后重试。可先保存配置，稍后在源列表中重试健康检查。","cls":"source-form__test-result source-form__test-result--fail"}
PASS SUP-03 编辑源改名后落库并返回列表 :: {"name":"补充 AList 改名"}
PASS SUP-04 删除源 → 确认后真实删除并返回列表 :: {"remaining":["内置演示"]}
PASS SUP-05 订阅导入：成功 2 / 跳过 1，结果面板展示明细 :: {"text":"导入结果 成功 2 · 跳过 1 · 失败 0 已写入 2 个源…其中 1 个源因配置不完整（如缺 api）未提交","before":1,"after":3}
PASS SUP-06 缺 api 条目在预览中给出跳过原因 :: skip-section-ok
PASS SUP-07 单集电影点下载直接建任务，不打开抽屉 :: {"label":"下载","before":0,"after":1}
```

```text
# npm run typecheck
> vue-tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json
（无输出） exit=0

# npx vitest run
 Test Files  16 passed (16)
      Tests  157 passed (157)

# npm run build
✓ built in 6.15s  exit=0
```

## 5. 截图

| 文件（`docs/03-设计规范/preview/`） | 内容 |
| --- | --- |
| `review-15a-detail-actions.png` | **BUG-04 修复后**：详情页四个操作按钮全部可见（收藏/下载/投屏） |
| `review-15-detail-download.png` | 抽屉内点「全选 → 开始下载」后任务创建 |
| `review-16-downloads.png` | 下载完成、可离线观看 |
| `review-19-source-form.png` | 新增源表单（E2E-20 保存前） |
| `review-26-source-saved.png` | 新增源落库并回到列表 |
| `review-27-source-test-connection.png` | 测试连接真实失败结果（红色） |
| `review-28-source-delete-confirm.png` / `review-29-source-deleted.png` | 删除二次确认 / 删除后列表仅剩内置源 |
| `review-20-import-preview.png`、`review-30-import-preview.png` | 订阅预览（共 3 个源 · 可导入 2 · 跳过 1） |
| `review-21-import-result.png`、`review-31-import-result.png` | 导入结果 `成功 2 · 跳过 1 · 失败 0` + 跳过原因说明 |
| `review-33-import-skip-reason.png` | "将跳过 1 个源：第 3 条缺少 api 字段" |
| `review-22-backup.png` / `review-23-backup-import.png` | 导出成功提示 / 导入预览计数 |
| `review-32-single-download.png` | 单集电影直接建任务（无抽屉） |

原始报告：`docs/03-设计规范/preview/review-e2e-report.json`（25/25）、`review-supplement-report.json`（7/7）。

## 6. 基线未倒退

| 检查 | 返工前基线 | 返工后 | 结论 |
| --- | --- | --- | --- |
| `npx vue-tsc --noEmit` | 0 错误 | 0 错误 | 未倒退 |
| `npx vitest run` | 16 文件 / 157 用例 | 16 文件 / 157 用例 | 未倒退（用例文件与数量一致） |
| `npm run build` | 通过 | 通过（6.15s） | 未倒退 |
| E2E | 19/25 | 25/25 | +6 |

## 7. 遗留项 / 需 PKG-B（DATA）处理

| # | 事项 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | `ImportResult.skipped` 不含"预览即无效"的条目，与 AC-13「成功 6 跳过 2」口径不一致 | UI 已在展示层用 `invalidAtCommit` 补偿，但**其他消费方（若后续有）会拿到偏小值** | 建议 `importService.commit` 把 `preview.entries.filter(!valid).length` 计入 `skipped`，或新增 `invalidCount` 字段（需另起 CHG-03） |
| 2 | `importService.commit` 对 `selectedKeys: []` 视为"全部导入"（`selected.size === 0` 分支） | UI 已拦住空选择（按钮 disabled），但契约语义有歧义 | 建议明确空数组 = 导入 0 条，或文档标注该特例 |
| 3 | `sourceStore.testConnection` 对不可达地址返回 `E_NETWORK`「网络不可用，请检查网络后重试」 | 与"源地址错误"难以区分（实测对 `https://supp-alist.example.com` 返回的是超时/网络类文案） | 可考虑在 `ConnectionResult.error` 中区分 DNS/超时/HTTP 状态，UI 文案即可更准 |
| 4 | `sources.remove(id, { removeDownloads })` 的 UI 未暴露 | 列表气泡只说"不会自动删除已下载文件"，符合当前实现 | 后续若加"同时删除下载"勾选，Store 已支持，无需改数据层 |
| 5 | 备份 `downloads: []` 恒为空数组（`collectBackup` 未查下载表） | 与页面文案"导出下载任务元数据"不符 | 请 PKG-B 确认是刻意（避免泄漏本地路径）还是遗漏 |

## 8. 复现命令

```bash
# 1) 起 dev（若 5175 未占用）
npx vite --port 5175 --strictPort

# 2) 全量 E2E（默认 BASE_URL=http://localhost:5175）
node scripts/review-e2e.cjs

# 3) 补充验收（编辑/测试连接/删除/单集直下）
node scripts/review-supplement.cjs

# 4) 三项基线
npm run typecheck && npx vitest run && npm run build
```
