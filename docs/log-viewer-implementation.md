# 运行日志查看功能 - 实现总结

## 概述

为 PeanutMov 应用实现了完整的运行日志查看功能，支持实时查看、过滤、搜索、导出日志，覆盖原生层和 JS 层的所有关键日志。

## 实现阶段

### P0：基础查看功能 ✅

**原生层改动：**
- `SpiderLogStore.java`：新增 `flushNow()`、`readTail()`、`clearAll()`、`appendBatch()` 方法
- `SpiderPlugin.java`：新增 `readLogTail`、`clearAllLogs`、`appendLogs` 三个插件方法

**Web 层改动：**
- `src/native/logs.ts`：扩展 API，新增 `readTail()`、`clearAll()`、`appendLogs()`
- `src/native/spiderPlugin.ts`：更新类型定义
- `src/shared/logLine.ts`：纯函数日志解析器（支持续行、级别/标签/关键字过滤）
- `src/views/LogsView.vue`：完整的日志查看页面
- `src/router/index.ts`：新增 `/settings/logs` 路由
- `src/views/SettingsView.vue`：添加"运行日志"入口

**功能特性：**
- 实时轮询（1秒间隔）读取日志文件尾部
- 级别过滤（D/I/W/E/F）
- 标签过滤（底部弹层选择）
- 关键字搜索（200ms 防抖）
- 暂停/继续轮询
- 自动滚动（可切换）
- 复制/分享/清空日志
- 选择日期文件查看历史日志
- 错误/崩溃高亮（红色背景）
- 最多显示 2000 条，超出自动裁剪

### P1：JS 日志统一接入 ✅

**新增文件：**
- `src/shared/logBus.ts`：JS 日志总线

**改动文件：**
- `src/main.ts`：在启动最早期安装 console 捕获
- `src/native/logs.ts`：新增 `restoreLogLevel()` 函数
- `src/views/LogsView.vue`：支持 Web 环境（从 logBus 读取）

**功能特性：**
- 包装 `console.*`，捕获所有 JS 日志（含 `logger.*` 和裸 `console.*`）
- 捕获 `window.onerror` 和 `unhandledrejection`
- 环形缓冲（2000 条）
- 批量转发到原生层（500ms 或 32 条一批）
- 脱敏处理（URL token/password、对象 key）
- 防递归（内部错误不走 logger）
- JS logger 级别联动（详细日志启用时允许 debug）

### P2：原生模块日志接入 ✅

**新增文件：**
- `android/app/src/main/java/com/qoder/cinema/AppLog.java`：统一日志门面

**改动文件：**
- `HlsDownloader.java`：错误路径使用 AppLog
- `NativeDownloadManager.java`：错误/警告路径使用 AppLog
- `RangeDownloader.java`：警告/错误路径使用 AppLog
- `ExoPlayerPlugin.java`：警告路径使用 AppLog
- `LocalProxyPlugin.java`：警告路径使用 AppLog

**功能特性：**
- 统一的原生日志入口（同时写 logcat 和 SpiderLogStore）
- 高价值模块关键路径接入（下载、播放、代理）
- 使查看页能看到原生模块的关键日志

### P3：崩溃现场捕获 ✅

**改动文件：**
- `MainApplication.java`：安装全局 UncaughtExceptionHandler
- `src/shared/logLine.ts`：支持 'F' (FATAL) 级别
- `src/views/LogsView.vue`：新增"只看错误"快捷按钮

**功能特性：**
- 全局崩溃处理器，写 FATAL 日志后交还默认处理
- 崩溃日志包含线程名、异常类、消息、堆栈
- 查看页"只看错误"按钮快速过滤 E/F 级别
- FATAL 条目红色高亮显示

## 测试覆盖

- `tests/unit/logLine.spec.ts`：15 个测试用例全部通过
  - 解析单行标准格式
  - 续行归并
  - 多行多条目
  - 无时间戳行处理
  - 空文本处理
  - 级别过滤
  - 标签过滤
  - 关键字搜索
  - 标签统计
  - 格式化输出

## 构建验证

- ✅ Android Java 编译成功
- ✅ Web Vite 构建成功
- ✅ TypeScript 类型检查通过（无新增错误）
- ✅ 单元测试全部通过

## 使用方式

1. **开启详细日志**：设置 → 数据 → 详细日志（开关）
2. **查看日志**：设置 → 数据 → 运行日志
3. **过滤日志**：
   - 点击级别 chips（D/I/W/E）
   - 输入关键字搜索
   - 点击"标签"按钮选择标签
   - 点击"只看错误"快速过滤
4. **操作日志**：
   - 暂停/继续：停止/恢复自动轮询
   - 自动滚动：新日志自动滚动到底部
   - 复制：复制当前筛选结果到剪贴板
   - 分享：导出日志文件并分享
   - 清空：清空所有日志文件（需二次确认）
5. **选择日期**：点击"选择"按钮切换历史日志文件

## 技术亮点

1. **增量读取**：按字节 offset 轮询，每次只读尾部 256KB，避免整文件重读
2. **统一数据源**：查看页只读落盘文件，避免内存缓冲和文件两路日志混排
3. **防递归设计**：logBus 内部错误静默处理，避免死循环
4. **脱敏处理**：自动过滤 URL 中的 token/password 等敏感信息
5. **性能优化**：
   - 列表使用 `content-visibility: auto` 保证滚动流畅
   - 最多显示 2000 条，超出自动裁剪
   - 搜索 200ms 防抖
6. **跨环境支持**：Web 环境从 logBus 读取，原生环境从文件读取

## 文件清单

### 新增文件（6 个）
- `src/shared/logBus.ts`
- `src/shared/logLine.ts`
- `src/views/LogsView.vue`
- `tests/unit/logLine.spec.ts`
- `android/app/src/main/java/com/qoder/cinema/AppLog.java`

### 修改文件（12 个）
- `android/app/src/main/java/com/qoder/cinema/SpiderLogStore.java`
- `android/app/src/main/java/com/qoder/cinema/SpiderPlugin.java`
- `android/app/src/main/java/com/qoder/cinema/MainApplication.java`
- `android/app/src/main/java/com/qoder/cinema/download/HlsDownloader.java`
- `android/app/src/main/java/com/qoder/cinema/download/NativeDownloadManager.java`
- `android/app/src/main/java/com/qoder/cinema/download/RangeDownloader.java`
- `android/app/src/main/java/com/qoder/cinema/ExoPlayerPlugin.java`
- `android/app/src/main/java/com/qoder/cinema/LocalProxyPlugin.java`
- `src/native/logs.ts`
- `src/native/spiderPlugin.ts`
- `src/main.ts`
- `src/router/index.ts`
- `src/views/SettingsView.vue`

## 后续优化建议

1. **日志分析**：添加日志统计图表（错误率、高频标签等）
2. **日志搜索增强**：支持正则表达式搜索
3. **日志导出格式**：支持导出为 JSON/CSV 格式
4. **日志分享增强**：支持分享筛选后的日志片段
5. **性能监控**：添加日志写入性能监控（队列长度、刷盘延迟等）
6. **远程日志**：支持可选的远程日志上报（需用户授权）
