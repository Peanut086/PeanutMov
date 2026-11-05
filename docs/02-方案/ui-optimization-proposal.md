# PeanutMov UI/交互优化方案

> 基于代码走查产出，所有建议均溯源到具体文件/组件。编号体系：OPT-xx（优化项）、Q-xx（待确认问题）。

---

## 一、现状总结

### 优势

1. **设计体系成熟**：三层 Token 架构（primitive -> semantic -> component）完整，OLED 四层亮度阶梯 + 琥珀金品牌色辨识度高，亮/暗双主题均已落地且 WCAG AA 逐项核对。
2. **状态设计周全**：所有列表页统一实现四态（loading 骨架 / empty 空态 / error 错误卡 / offline 离线横幅），且空态按原因细分（无源 / 筛选无结果 / 分类无内容），给用户明确的行动路径。
3. **无障碍意识强**：BottomSheet 实现了焦点陷阱与还原、aria-modal/dialog 语义、Esc 关闭；PosterCard 整卡 button + aria-label；Toast 使用 aria-live="polite"。
4. **播放器交互完整**：手势层（SeekBar/Volume/Brightness/Rate）+ HUD 反馈 + 自动连播倒计时 + 后台恢复浮层，已形成闭环。
5. **触控合规**：全局 44px 最小触控区，btn--sm 用伪元素扩展命中区。

### 不足

1. **页面转场单薄**：仅有 6px translateY 的 route-in 动画，无方向感知的进入/退出过渡，页面间切换缺乏空间层次感。
2. **硬编码颜色残留**：HomeView 的 hero 卡片标题/元信息使用 `#ffffff` / `rgba(255,255,255,0.72)` 而非 Token；豆瓣入口横幅使用硬编码绿色 `#28a050`，与琥珀金品牌色体系割裂。
3. **反馈维度单一**：仅有视觉 Toast，无触觉反馈（Android 原生 HapticFeedback / Vibration API），操作确认感弱。
4. **首页信息密度偏低**：继续观看大卡（16:9）+ 横滑小卡 + 最近添加横滑 + 豆瓣入口，一屏内信息区块多但每个都不饱满，用户需要频繁滚动。
5. **导航深度过大**：设置 → 源管理 → 新增/编辑源 = 3 级深，且源管理相关页面（SourceListView / SourceFormView / ImportSubscriptionView / SubscriptionListView / EvalSubscriptionView）共 5 个独立路由，缺乏聚合。
6. **播放器缺少 PiP**：Android 原生支持 Picture-in-Picture，当前未利用。
7. **搜索体验基础**：仅文本输入 + 防抖，无搜索建议/联想、无热门搜索、无语音输入入口。

---

## 二、优化建议

### P0 -- 核心体验问题，建议立即处理

#### OPT-01 消除硬编码颜色，统一 Token 引用

- **问题描述**：HomeView.vue 的 `.home-hero__title` 使用 `color: #ffffff`，`.home-hero__meta` 使用 `color: rgba(255,255,255,0.72)`；`.home-douban-banner` 系列使用硬编码绿色 `rgba(40,160,80,...)` 和 `#28a050`。这些值绕过了 Token 体系，主题切换时不会跟随变化，且与品牌色不一致。
- **建议方案**：
  1. Hero 卡片文字颜色改用 `var(--color-text-primary)` 和 `var(--color-text-secondary)`（在渐变遮罩上已有足够对比度）。
  2. 豆瓣入口横幅改为品牌色系：背景 `var(--color-brand-soft)`、边框 `var(--color-brand)` 的透明度变体、图标色 `var(--color-brand)`。或者新增一个语义 Token `--color-douban`（如保持绿色但走 Token 层）。
  3. 运行 `validate-tokens.cjs` 全量扫描，修复所有残留硬编码色值。
- **预期效果**：主题切换无遗漏，品牌色统一，维护成本降低。
- **涉及文件**：`src/views/HomeView.vue`（scoped style 第 421/426/528-549 行）、`src/styles/tokens.css`（可选新增语义 Token）。

#### OPT-02 增加页面转场方向感知

- **问题描述**：当前 `.route-view` 只有一个 `route-in` 动画（translateY 6px），不区分前进/后退/平级切换，用户缺乏空间方位感。
- **建议方案**：
  1. 在 `App.vue` 的 `<RouterView>` 外层包裹 `<Transition>`，使用 `name` 属性配合路由 `meta.depth` 区分方向。
  2. 前进（depth 增大）：新页面从右侧滑入 + 旧页面向左滑出（transform: translateX）。
  3. 后退（depth 减小）：反向。
  4. 平级（Tab 切换）：仅做 opacity 淡入，不位移。
  5. 保留 `prefers-reduced-motion` 降级。
- **预期效果**：导航有方向感，用户能感知"我在哪一层"，减少迷失。
- **涉及文件**：`src/App.vue`（RouterView 包裹 Transition）、`src/router/index.ts`（meta 增加 depth）、新增 `src/styles/transitions.css`。

#### OPT-03 触觉反馈集成

- **问题描述**：所有操作（收藏、下载、删除、播放/暂停、Tab 切换）仅有视觉 Toast 反馈，Android 端缺乏触觉确认。
- **建议方案**：
  1. 封装 `useHaptic()` composable，直接调用 `navigator.vibrate()`（Android 优先，不做降级处理）。
  2. 定义 3 档触觉模式：`light`（10ms，按钮点击）、`medium`（25ms，收藏/取消）、`heavy`（50ms，删除/错误）。
  3. 在以下场景接入：PosterCard 长按触发快捷菜单、PlayerControls 播放/暂停、BottomSheet 打开/关闭、Toast 弹出（error 类型）、Tab 切换。
  4. 设置页提供"触觉反馈"开关（默认开启）。
- **预期效果**：操作确认感提升，减少"我到底点没点到"的疑虑。
- **涉及文件**：新增 `src/composables/useHaptic.ts`、`src/components/player/PlayerControls.vue`、`src/components/common/BottomSheet.vue`、`src/components/common/ToastHost.vue`、`src/views/SettingsView.vue`。

#### OPT-04 首页信息密度优化

- **问题描述**：首页从上到下依次为：Hero 大卡（16:9 约 200px 高）→ "继续观看"横滑小卡（132x198 约 220px）→ "最近添加"横滑（104x156 约 180px）→ 豆瓣入口横幅（60px）。一屏（约 640px 可用高度）只能看到 Hero + 部分继续观看，用户必须滚动才能看到核心内容"最近添加"。
- **建议方案**：
  1. 将"继续观看"的横滑小卡合并到 Hero 大卡下方，改为紧凑的 2-3 张缩略图横条（高度从 220px 压缩到 80px），点击直接续播。
  2. "最近添加"网格从 2 列改为 3 列（手机竖屏），单卡宽度缩小但信息密度提升。
  3. 豆瓣入口从独立横幅改为首页右上角的图标入口（AppHeader 内），或合并到"最近添加"section header 的"更多"位置。
- **预期效果**：首屏可见内容从 ~2 个区块提升到 ~3 个区块，减少无意义滚动。
- **涉及文件**：`src/views/HomeView.vue`、`src/components/media/ContinueWatchingRow.vue`、`src/components/layout/AppHeader.vue`。

---

### P1 -- 重要优化，建议近期处理

#### OPT-05 下拉刷新（Pull-to-Refresh）

- **问题描述**：LibraryView、HomeView、DoubanView 等数据依赖远程源的页面，刷新需点击工具栏图标按钮，操作路径长且不符合移动端直觉。
- **建议方案**：
  1. 封装 `PullToRefresh` 组件，监听 touchstart/touchmove/touchend，下拉超过阈值（60px）触发刷新，带弹性阻尼和 loading 动画。
  2. 在 HomeView、LibraryView、DoubanView、DownloadsView 的滚动容器外层包裹该组件。
  3. 刷新动画使用品牌色（琥珀金）spinner。
- **预期效果**：刷新操作从"找按钮 → 点击"简化为"下拉"，符合移动端心智模型。
- **涉及文件**：新增 `src/components/common/PullToRefresh.vue`，修改 4 个 View。

#### OPT-06 播放器画中画（PiP）

- **问题描述**：用户切到其他 App 或回到首页时，播放被迫暂停（NextEpisodePrompt resume 模式），无法边做其他事边看。
- **建议方案**：
  1. 使用 Capacitor 插件 `@capacitor-community/picture-in-picture` 或 Android 原生 `enterPictureInPictureMode()` API（仅 Android，暂不支持 iOS）。
  2. 在 PlayerControls 增加 PiP 切换按钮（图标：小窗）。
  3. 设置页增加"自动进入画中画"开关（默认关闭）。
  4. PiP 窗口显示当前播放标题 + 播放/暂停控制。
- **预期效果**：用户多任务场景下不中断播放，提升使用时长。
- **涉及文件**：`src/views/PlayerView.vue`、`src/components/player/PlayerControls.vue`、`src/native/` 新增 PiP 适配层、`src/views/SettingsView.vue`。

#### OPT-07 搜索体验增强

- **问题描述**：SearchView 仅支持输入后防抖搜索，无实时联想、无热门搜索、无搜索历史删除单条。
- **建议方案**：
  1. **搜索联想**：输入 2 个字符后，调用新建的轻量 `suggest` 接口（非完整搜索），返回前 5 条建议，点击直接跳转详情。
  2. **热门搜索**：空输入态展示"热门搜索"标签云（数据来自 doubanService 正在热映的前 10 条，或本地统计高频搜索词）。
  3. **历史单条删除**：搜索历史列表每条增加 x 按钮（当前仅支持全部清除）。
  4. **搜索范围指示**：结果页顶部显示"在 X 个源中搜索"的 chip，点击可切换搜索范围。
- **预期效果**：搜索从"被动输入"变为"主动引导"，减少用户输入成本。
- **涉及文件**：`src/views/SearchView.vue`、`src/components/common/SearchBar.vue`、新增 `src/components/search/SearchSuggestion.vue`。

#### OPT-08 详情页转化效率提升

- **问题描述**：DetailView 的主操作按钮（播放/继续观看）位于页面中部偏下，用户进入后需滚动才能看到；简介默认 4 行截断，展开/收起交互不够明显。
- **建议方案**：
  1. **主按钮上浮**：将"播放/继续观看"按钮固定在详情页底部（SafeArea 上方），类似电商 App 的"立即购买"悬浮条。滚动时始终可见。
  2. **底部防遮挡**：增加页面底部 padding（至少 80px），确保固定按钮不遮挡内容。
  3. **简介交互优化**：截断态底部增加渐变遮罩 + "展开全文"文字链，展开后变为"收起"。
  4. **选集横向化**：剧集选集从纵向列表改为横向滚动 chip（当前选中高亮），减少页面长度。
- **预期效果**：核心操作（播放）一键可达，详情页到播放器的转化路径缩短。
- **涉及文件**：`src/views/DetailView.vue`、`src/components/media/EpisodeList.vue`。

#### OPT-09 导航深度优化 -- 设置页聚合

- **问题描述**：设置相关页面共 5 个独立路由（SourceListView / SourceFormView / ImportSubscriptionView / SubscriptionListView / EvalSubscriptionView），从"我的"进入源管理需要 3 级跳转。
- **建议方案**：
  1. **源管理内联化**：将 SourceListView 改为 SettingsView 内的一个可展开 Section（而非独立页面），点击源卡片直接弹出 BottomSheet 编辑（复用 SourceForm 的字段，表单放在 BottomSheet 内）。
  2. **导入订阅合并**：ImportSubscriptionView 的功能合并到源管理 Section 的"添加"按钮下拉菜单中。
  3. **订阅评测入口**：EvalSubscriptionView 作为订阅列表页的右上角操作按钮，而非独立路由。
  4. 最终路由从 5 个减少到 2 个（Settings + Backup）。
- **预期效果**：设置相关操作的导航层级从 3 级压缩到 1-2 级，减少页面跳转。
- **涉及文件**：`src/views/SettingsView.vue`、`src/views/SourceListView.vue`（改为组件）、`src/router/index.ts`。

#### OPT-10 播放器手势引导优化

- **问题描述**：GestureGuide 仅在首次进入播放器时显示一次，之后不再提示。用户可能忘记手势操作方式，且不同手势区域（左半屏亮度/右半屏音量/水平快进）缺乏视觉分区。
- **建议方案**：
  1. **长按触发手势帮助**：在播放器画面长按 1 秒（非播放区），弹出半透明手势示意图（3 秒后自动消失）。
  2. **手势区域视觉提示**：手指触摸时，在触摸点附近显示一个微弱的圆形光晕（颜色区分：左侧蓝色=亮度，右侧绿色=音量），松手后消失。
  3. **设置页增加"手势说明"入口**：永久可查看的图文说明。
- **预期效果**：降低手势学习成本，减少误操作。
- **涉及文件**：`src/components/player/GestureLayer.vue`、`src/components/player/GestureGuide.vue`、`src/views/SettingsView.vue`。

---

### P2 -- 锦上添花，可排期处理

#### OPT-12 直播页频道切换动画

- **问题描述**：LiveView 切换频道时，播放器区域直接替换 URL，无过渡效果，可能出现黑屏闪烁。
- **建议方案**：
  1. 切换频道时，先对当前画面做 `opacity: 1 -> 0.3` 的 150ms 淡出。
  2. 新流加载完成后 `opacity: 0.3 -> 1` 的 200ms 淡入。
  3. 频道列表选中态增加左侧琥珀金竖条 indicator（当前仅背景色变化）。
- **预期效果**：频道切换更平滑，减少黑屏感知。
- **涉及文件**：`src/views/LiveView.vue`、`src/components/live/LivePlayer.vue`。

#### OPT-13 下载页进度可视化增强

- **问题描述**：DownloadItem 当前显示进度百分比文本，但进度条较细（2-3px），在列表中不够醒目。
- **建议方案**：
  1. 将进度条改为海报卡底部的 3px 条 + 卡片整体背景微渐变（已完成部分用 brand-soft 色覆盖）。
  2. 下载中的卡片增加微弱的呼吸动画（border 颜色在 brand 和 transparent 之间循环，周期 2s）。
  3. 下载完成时触发一次触觉反馈（medium）+ Toast "下载完成"。
- **预期效果**：下载状态一目了然，完成时有明确反馈。
- **涉及文件**：`src/components/download/DownloadItem.vue`、`src/views/DownloadsView.vue`。

#### OPT-14 深色/浅色主题自动切换

- **问题描述**：当前主题切换需要手动进入设置页选择，不支持跟随系统主题自动变化。
- **建议方案**：
  1. 设置页主题选项增加"跟随系统"（默认），监听 `window.matchMedia('(prefers-color-scheme: dark)')` 的 `change` 事件。
  2. 切换时保留现有的 `theme-switching` 类（禁用过渡防闪烁）机制。
  3. 用户手动选择过深色/浅色后，视为"覆盖系统设置"，直到重新选择"跟随系统"。
- **预期效果**：主题与系统保持一致，减少手动操作。
- **涉及文件**：`src/composables/useTheme.ts`、`src/views/SettingsView.vue`。

#### OPT-15 离线内容预加载提示

- **问题描述**：用户在有 WiFi 时浏览了内容，进入地铁/离线环境后才发现无法播放，当前仅有 OfflineBanner 被动提示。
- **建议方案**：
  1. 检测到 WiFi 连接 + 用户正在浏览详情页时，在操作按钮区增加一条提示："当前为 WiFi 环境，是否预加载到本地？"（复用 DownloadItem 的创建逻辑）。
  2. 预加载完成后，详情页的播放按钮增加"离线可用"角标。
  3. 设置页增加"智能预加载"开关（默认关闭），开启后自动预加载用户浏览超过 10 秒的内容。
  4. 存储上限由用户手动配置（如 500MB / 1GB / 2GB / 5GB / 无限制），超出上限时停止预加载并提示。
- **预期效果**：离线场景下的内容可用性提升。
- **涉及文件**：`src/views/DetailView.vue`、`src/views/SettingsView.vue`、新增 `src/composables/useSmartPreload.ts`。

---

### P3 -- 长期探索方向

#### OPT-11 海报卡共享元素转场（Hero Transition）

- **问题描述**：从 LibraryView 的海报墙点击 PosterCard 进入 DetailView，两个页面的海报图片是独立的，切换时没有视觉连续性。
- **建议方案**：
  1. 使用 Vue Transition + FLIP 动画库（如 `vue-flip-toolkit` 或自实现），让 PosterCard 的海报图片"飞入" DetailView 的顶部海报位置。
  2. 同时海报卡的标题文字淡出，DetailView 的标题淡入。
  3. 转场时长 300ms，使用 `--ease-emphasized` 缓动。
  4. 备注：低端 Android 设备可能存在性能风险，需后续验证是否加入降级策略。
- **预期效果**：页面切换有电影感，视觉连贯性提升。
- **涉及文件**：`src/components/media/PosterCard.vue`、`src/views/DetailView.vue`、新增 `src/composables/useHeroTransition.ts`。

#### OPT-16 首页个性化推荐

- **问题描述**：首页"最近添加"为全局最新内容，不区分用户偏好。
- **建议方案**：基于用户观看历史（historyStore）和收藏（favoriteStore）的 type/area/year 分布，计算用户偏好画像，对"最近添加"列表做加权排序。纯前端实现，不需要后端。
- **预期效果**：首页内容与用户兴趣更匹配。

#### OPT-17 播放器弹幕增强

- **问题描述**：当前弹幕仅支持基础发送和显示，缺乏互动性。
- **建议方案**：增加弹幕颜色选择、弹幕位置（顶部/底部/滚动）、弹幕屏蔽关键词、弹幕密度调节。
- **预期效果**：弹幕体验更丰富，用户可控性更强。

#### OPT-18 多设备同步观看进度

- **问题描述**：当前观看进度仅存储在本地，换设备后丢失。
- **建议方案**：通过用户账号体系（或 WebDAV/云存储）同步 historyStore 数据。需要后端支持。
- **预期效果**：跨设备无缝续播。

#### OPT-19 手势快捷操作扩展

- **问题描述**：当前手势仅支持播放控制（快进/音量/亮度/倍速）。
- **建议方案**：增加双指旋转调整画面比例、三指下滑快速返回、单指从边缘滑入打开选集面板。
- **预期效果**：高级用户操作效率提升。

---

## 三、待确认问题（已全部确认）

| 编号 | 问题 | 用户决策 | 影响范围 |
|------|------|----------|----------|
| Q-01 | 豆瓣入口横幅是否保留独立位置 | ✅ **保留独立位置**，不合并到 AppHeader | OPT-04 |
| Q-02 | 触觉反馈兼容性 | ✅ **直接用 `navigator.vibrate()`**，不做降级处理（Android 优先） | OPT-03 |
| Q-03 | 画中画平台范围 | ✅ **仅 Android**，暂不支持 iOS | OPT-06 |
| Q-04 | 搜索联想数据源 | ✅ **新建轻量 suggest 接口**，不复用完整搜索 | OPT-07 |
| Q-05 | 详情页固定按钮遮挡 | ✅ **增加底部 padding** 防遮挡 | OPT-08 |
| Q-06 | 源管理表单位置 | ✅ **放 BottomSheet 内**，减少页面跳转 | OPT-09 |
| Q-07 | 共享元素转场性能 | ✅ **先不做，降到 P3** 长期探索 | OPT-11 |
| Q-08 | 智能预加载存储上限 | ✅ **用户手动配置上限** | OPT-15 |

---

## 四、实施建议

### 第一阶段：基础修复（1-2 周）

**目标**：消除硬编码、统一 Token、修复主题一致性。

| 序号 | 优化项 | 预估工时 | 依赖 |
|------|--------|----------|------|
| 1 | OPT-01 消除硬编码颜色 | 2h | 无 |
| 2 | OPT-03 触觉反馈集成 | 4h | 无 |
| 3 | OPT-14 主题自动切换 | 3h | OPT-01 |

**验收标准**：
- `validate-tokens.cjs` 扫描 0 违规。
- 触觉反馈在 Android 真机可感知。
- 系统切换深色/浅色时 App 自动跟随。

### 第二阶段：导航与转场（2-3 周）

**目标**：提升页面切换的空间感和流畅度。

| 序号 | 优化项 | 预估工时 | 依赖 |
|------|--------|----------|------|
| 4 | OPT-02 页面转场方向感知 | 6h | 无 |
| 5 | OPT-04 首页信息密度优化 | 8h | 无 |
| 6 | OPT-05 下拉刷新 | 5h | 无 |
| 7 | OPT-09 设置页聚合 | 10h | 无 |

**验收标准**：
- 前进/后退/Tab 切换三种转场方向正确。
- 首页首屏可见内容 >= 3 个区块。
- 下拉刷新在 4 个页面均可用。
- 设置相关路由从 5 个减少到 2 个。

### 第三阶段：播放器与搜索增强（3-4 周）

**目标**：核心使用场景（播放、搜索）的体验提升。

| 序号 | 优化项 | 预估工时 | 依赖 |
|------|--------|----------|------|
| 8 | OPT-06 播放器画中画 | 8h | 无 |
| 9 | OPT-07 搜索体验增强 | 10h | 无 |
| 10 | OPT-08 详情页转化效率 | 6h | 无 |
| 11 | OPT-10 手势引导优化 | 5h | 无 |

**验收标准**：
- PiP 在 Android 10+ 可用。
- 搜索联想响应 < 300ms。
- 详情页播放按钮始终可见。
- 长按触发手势帮助可正常工作。

### 第四阶段：视觉打磨（4-6 周）

**目标**：提升视觉品质感和微交互。

| 序号 | 优化项 | 预估工时 | 依赖 |
|------|--------|----------|------|
| 12 | OPT-12 直播频道切换动画 | 4h | 无 |
| 13 | OPT-13 下载页进度可视化 | 5h | OPT-03 |
| 14 | OPT-15 离线预加载提示 | 8h | 无 |

**验收标准**：
- 直播切换无黑屏闪烁。
- 下载进度视觉可感知。
- 预加载存储上限可由用户配置。

### 长期路线图

OPT-11（共享元素转场）/ OPT-16 / OPT-17 / OPT-18 / OPT-19 作为未来版本储备，需根据用户反馈和数据验证优先级。

---

## 附录：优化项与需求溯源

| 优化项 | 溯源 FR/AC | 说明 |
|--------|-----------|------|
| OPT-01 | 设计规范 9.1 | Token 体系要求禁止硬编码 |
| OPT-02 | 页面蓝图 18.2 | 路由过渡应有方向感 |
| OPT-03 | 设计规范 12.1 | 触控反馈应多模态 |
| OPT-04 | 页面蓝图 2.1 | 首页信息密度应最大化 |
| OPT-05 | FR-12 | 列表页应支持下拉刷新 |
| OPT-06 | FR-30 | 播放器应支持后台/画中画 |
| OPT-07 | FR-15 | 搜索应提供联想/建议 |
| OPT-08 | AC-36/37 | 详情页主按钮应突出 |
| OPT-09 | 信息架构优化 | 减少导航层级 |
| OPT-10 | 设计规范 12.2 | 手势应有可发现的引导 |
| OPT-11 | 设计规范 7.3 | 页面转场应有视觉连续性 |
| OPT-12 | FR-35 | 直播切换应平滑 |
| OPT-13 | FR-20 | 下载进度应醒目 |
| OPT-14 | FR-42 | 主题应支持跟随系统 |
| OPT-15 | FR-50 | 离线场景应可预加载 |
