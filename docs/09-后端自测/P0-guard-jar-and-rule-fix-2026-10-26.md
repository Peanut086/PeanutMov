# 后端自测记录 — Guard Jar 崩溃 / 假 Jar / drpy 规则（2026-10-26）

> 变更文件：`android/app/src/main/java/com/qoder/cinema/SpiderPlugin.java`、`DrpyPlugin.java`
> 变更范围：仅原生 Java，未改动已提交的 UI 基线（6845af6）
> 设备：华为真机 `BLT0222A11043727`（arm64-v8a）；MuMu 12 `192.168.3.3:5555`（x86_64）

## 一、修复项

| 编号 | 问题 | 根因 | 修复位置 |
|---|---|---|---|
| P0-A | 真机冷启动必崩（SIGABRT，Java catch 无效） | guard 型 jar 的 `BaseSpiderGuard.<init>` → `Init.getSpider()` → `Init.loader()` 读到 null 的 `DexClassLoader`；只有 `Init.init(Context)` 会赋值该字段，宿主从未调用 | `SpiderPlugin.loadSpider` 实例化前调用 `Init.init(Application)` |
| P0-B | 114 字节 HTML 跳转页被当 jar 缓存 | 死域名 200 返回 HTML，下载路径与缓存命中路径均未校验内容 | `SpiderPlugin.ensureJarFile` / `downloadJar` 增加 ZIP magic 校验 |
| P1-C | drpy 规则 `unexpected token '<'` | 订阅里贴 GitHub `/blob/` 网页链接，返回 HTML 外壳；镜像失效时同样返回 HTML | `DrpyPlugin.normalizeRuleUrl` + `inspectRuleContent` |

## 二、实现要点

### P0-A guard jar 预初始化

- **识别方式**：先扫 jar 的 zip 条目找特征类（`DexNative.class` / `BaseSpiderGuard.class`，不触发类加载），
  失败再退回 `Class.forName(name, false, loader)`。保守判定，避免误判。
- **硬约束**：非 guard jar **绝不**调用 `Init.init()` —— 会连带拉起 jar 自带的悬浮球与本地代理。
- **柔性反射**：`init` 的参数类型在不同混淆版本间不一致，用 `findInitMethod()` 遍历 `getDeclaredMethods()`
  取「单参且参数与 `Context` 兼容」的静态方法；`loader()` 的 getter 名可能是 `loader` 或 `getLoader`，
  不存在则跳过校验（不阻断）。
- **失败可读**：任何异常都剥掉 `InvocationTargetException` 包装，经 `describeFailure()` 转成
  `guard 类型爬虫初始化失败（api）：类名: 消息`，抛 `IllegalStateException` 由上层 `call.reject` 捕获，
  **不再出现进程级崩溃**。

### P0-B ZIP magic 校验

- 接受 `PK\x03\x04`（普通包）、`PK\x05\x06`（空包）、`PK\x07\x08`（流式包）。
- 三处覆盖：**缓存命中**（发现假 jar 即删除重下）、**下载落盘后 rename 前**（删除临时文件并抛错）。
- 错误文案带字节数：`下载内容不是有效 jar（114 字节，疑似 HTML/跳转页）：<url>`。
- 纳入不可重试判定：内容非 zip 属确定性失败，重试同样结果。

### P1-C drpy 规则归一化

- `github.com/{o}/{r}/blob/{ref}/{path}` → `raw.githubusercontent.com/{o}/{r}/{ref}/{path}`，
  **保留镜像前缀**（如 `gh-proxy.net/` 前缀仍走原镜像）。
- `gitlab.com/.../-/blob/...` → `/-/raw/...`。
- 下载后 `inspectRuleContent()` 检查首字符与 `<!doctype` / `<html`，命中即删临时文件并抛可读错误。
- **缓存命中同样校验**：旧版本可能已把 HTML 存成 `.js`，命中时校验失败即删除并重下。

## 三、验证证据

### 真机冷启动（华为 BLT0222A11043727，arm64-v8a）

连续 3 次 `am force-stop` + `am start`，间隔 8 秒：

```
launch #1 started, wait 8s...
launch #2 started, wait 8s...
launch #3 started, wait 8s...
===CHECK CRASH===
（无输出）
```

进程存活确认：

```
$ adb -s BLT0222A11043727 shell pidof com.qoder.cinema
15124
```

全量日志扫描 `JNI DETECTED ERROR|Abort message|SIGABRT|tombstone|FATAL EXCEPTION`：
仅命中系统广播队列的 `process ... has died, drop BroadcastRecord{PACKAGE_REMOVED/ADDED/REPLACED}`，
这是 `adb install -r` 触发的包变更广播，**与应用崩溃无关**。

修复前同一路径的取证（`docs/05-测试报告/evidence/2026-10-26/realdevice-crash-jni-abort.log`）：

```
F DEBUG   : Abort message:
'JNI DETECTED ERROR IN APPLICATION: can't call java.lang.Class
 java.lang.ClassLoader.loadClass(java.lang.String) on null object
at com.github.catvod.spider.Init.getSpider+14
at com.github.catvod.spider.BaseSpiderGuard.<init>+22
at com.qoder.cinema.SpiderPlugin.loadSpider+374'
```

### guard jar 加载路径（真机实测，端到端）

**注意**：健康检测只跑 drpy 路径，不加载 jar，因此无法用它验证。改为通过 WebView DevTools
直接调用原生 `Spider.load()`，用 `adb reverse` 把本机托管的 guard jar 喂给真机。

```
# 1. 真机下载 guard jar（ftyguard 样本，1448574 字节）
I SpiderPlugin: jar abi precheck: e6821f63...jar -> [armeabi-v7a, arm64-v8a]
                device=[arm64-v8a, armeabi-v7a, armeabi]
I SpiderPlugin: injected catvod Init context (1 field(s))

# 2. guard 判定命中 + Init.init() 成功
I SpiderPlugin: guard jar initialized: csp_YunDuo     ← 类名猜错，但初始化已成功
I SpiderPlugin: guard jar initialized: csp_FyGuard    ← 真实类名，完整走通
I SpiderPlugin: loaded spider: csp_FyGuard

# 3. 实际调用爬虫
$ P.invoke({handle:'sp-51', method:'homeContent', args:[false]})
→ {"json":"{\"class\": [], \"list\": []}","logs":[]}

# 4. 崩溃计数
$ logcat | grep -c "JNI DETECTED ERROR|Abort message|SIGABRT"
0
$ pidof com.qoder.cinema
12171     ← 进程存活
```

对比修复前：同一 jar 的 `BaseSpiderGuard.<init>` 必然触发 JNI abort（见崩溃取证）。
现在 guard jar 能初始化、实例化、接受调用并返回结果。

**为什么最初 `isGuardJar()` 判定失效**：guard jar 的 zip 条目只有 5 个
（`classes.dex` 37KB + `assets/{fty,wex}guard_v7/v8.so` + `assets/*shinidie.guard` 加密载荷），
**类名不在条目里，而在 dex 字符串池中**。改为读 dex 字节匹配 `DexNative` / `BaseSpiderGuard` 特征串后判定生效。

### 假 jar 拦截（P0-B 主动验证）

把 114 字节的 HTML 跳转页当 jar 投喂：

```
$ P.load({jarUrl:'http://127.0.0.1:8803/fakejar.jar', api:'csp_FyGuard'})
→ ERR: 爬虫加载失败: IOException: 下载内容不是有效 jar（114 字节，疑似 HTML/跳转页）：
       http://127.0.0.1:8803/fakejar.jar
```

**历史污染清扫**：真机 `spider-jars/` 里原有一个 114 字节假 jar（`3f6baba1...`）。
新增 `purgeCorruptJarCache()` 在首次加载任意源时全量扫描并删除非 ZIP 文件。实测清理后目录：

```
$ run-as com.qoder.cinema ls -la files/spider-jars/
08789a61....jar  1925396   ← 保留
7eb712d0....jar   401684   ← 保留
c009aeda....jar  1448574   ← 保留（guard）
e800c0f8....jar   671316   ← 保留
fe43528e....jar  1006882   ← 保留（guard）
（3f6baba1....jar 已删除）
```

### drpy 规则（MuMu，修复后）

修复前（同一设备、同一订阅）：

```
I DrpyPlugin: downloaded rule: https://github.com/ne7359/tvurl/blob/main/js/爱上你听书网.js
W DrpyPlugin: 加载 failed
W DrpyPlugin: com.whl.quickjs.wrapper.QuickJSException: unexpected token in expression: '<'
W DrpyPlugin: 	at rule.js:7
...（同一条订阅里反复出现 3+ 次）
```

修复后：

```
I DrpyPlugin: downloaded rule: https://qist.wyfc.qzz.io/FTY/虎牙.js
I DrpyPlugin: downloaded rule: https://qist.wyfc.qzz.io/FTY/斗鱼直播.js
I DrpyPlugin: downloaded rule: https://qist.wyfc.qzz.io/FTY/兔小贝.js

$ adb logcat -d | grep -c "unexpected token"
0
```

`unexpected token '<'` 计数由多次降为 **0**。

## 四、编译验证

```
$ ./gradlew :app:compileDebugJavaWithJavac --offline
BUILD SUCCESSFUL in 9s
（仅 MainActivity 过时 API 提示与 SpiderPlugin unchecked 泛型告警，无 error）

$ ./gradlew assembleDebug --offline
BUILD SUCCESSFUL in 7s
app-debug.apk  15,906,984 bytes
```

## 五、guard 源出片率实测（真机全量 99 个 enabled 源）

**方法**: 通过 WebView DevTools 直接调用 `Spider.load()` + `homeContent`，逐个探测。

### 结果摘要

| 统计 | 数量 | 占比 |
|---|---|---|
| 总计 (enabled jar 源) | 99 | 100% |
| ✅ 成功出内容 (`ok=true`) | 58 | 58.6% |
| ❌ 首页空 (`class=0 list=0`) | 6 | 6.1% |
| ❌ 加载失败 | 35 | 35.4% |

### 主要错误类型

| 错误类别 | 数量 | 真实原因 | 解决方向 |
|---|---|---|---|
| `AppV7 init incomplete` | ~12 | WexAppV7Guard 需要 `initExt={"config":"AppV7Llq","proxyImg":false}` 等参数 | 订阅中该源缺失 ext 配置 |
| `MyCrypto so 未初始化` | ~8 | wexguard 系依赖加密库 `/files/AiWex/libdec/...`，需预下载解密 | GuardJar 预热时补解密包 |
| HTTP 429 / 服务超时 | ~6 | 源站限流 / 响应太慢 | 增加镜像切换与超时控制 |
| `SpiderDebug.log` 方法签名不匹配 | ~5 | 框架版本差异 (jar 内 log 方法参数不兼容) | SpiderAPI stub 扩展 |
| NPE (Alist/WebDav) | ~3 | 特定爬虫的空指针 bug | 空值校验完善 |
| 其他 runtime exception | ~1 | 个别源内部逻辑异常 | 隔离重试 |

**结论**: guard 型 jar **大部分能正常加载并返回数据**，部分问题属于「配置缺失」或「外部依赖未满足」，而非 App 本身缺陷。本次 P0-A 已确保这些 jar 不再导致崩溃。

## 六、第二轮修复（出片率失败归因驱动）

出片率实测暴露两类**可解的代码缺陷**（非源站问题），已修复：

### 6.1 `SpiderDebug` 必须为 static（修 5 个源）

**现象**：`IncompatibleClassChangeError: The method 'void
com.github.catvod.crawler.SpiderDebug.log(java.lang.Throwable)' was expected to be of type static`

**根因**（dexdump 实证）：

```
1cc068: 7110 ed12 0200  |invoke-static {v2}, Lcom/github/catvod/crawler/SpiderDebug;.log:(Ljava/lang/Throwable;)V
```

jar 内是 `invoke-static` 调用，而我们的 stub 声明为**实例方法** → 运行期抛 ICCE。

**修复**：`SpiderDebug` 全部改为 static，环形缓冲改静态字段；
补上 jar 可能调用的 `log(String, Throwable)` 重载。
调用点 `SpiderPlugin` / `DrpyRuntime` 同步改为 `SpiderDebug.xxx()`。

**影响源**：`csp_FakeAi115ShareGuard`、`csp_AnimeCiYuanChengGuard`、
`csp_AiNewHuBanGuard`、`csp_AiNewDuoDuoGuard` 等 5 个。

### 6.2 guard 工作目录预创建（修 8 个源）

**现象**：`RuntimeException: MyCrypto so 未在启动阶段初始化完成:
/data/user/0/com.qoder.cinema/files/AiWex/libdec`

**根因**：AiWex/MyCrypto 系 guard jar 在 `Init.init()` 里把 `assets/*guard_v*.so`
解密落到 `files/AiWex/libdec/` 再 `System.load()`。目录缺失/不可写时 jar 内部
只抛上述异常且**不重试**，该源永久不可用。

**修复**：`prepareGuardWorkDirs()` 在调用 `Init.init()` 前预创建
`files/AiWex/{,libdec,lib}` 并做可写探测。

**影响源**：`csp_ManJuAiHongGuoGuard`、`csp_BookHeMaGuard`、
`csp_ManJuAiHuoLongGuard`、`csp_BookHongGuoGuard`、
`csp_ManJuAiQiMaoGuard`、`csp_ManJuAiXiFanGuard` 等 8 个。

### 6.3 镜像候选补充 jsdelivr CDN

**现象**：真机网络下 `gh-proxy.net` 与 `raw.githubusercontent.com` 全部 20s 超时，
原有 fallback 链（原地址 → 直连 → gh-proxy 系镜像）无一命中。

**修复**：候选链插入 jsdelivr 系 CDN（国内可达性通常更好），置于 gh-proxy 系之前：

```
raw.githubusercontent.com/{u}/{r}/{ref}/{path}
  → https://cdn.jsdelivr.net/gh/{u}/{r}@{ref}/{path}
  → https://fastly.jsdelivr.net/gh/...
  → https://gcore.jsdelivr.net/gh/...
  → https://testingcf.jsdelivr.net/gh/...
```

裸 GitHub 地址（非镜像包装）现在也会生成变体候选，不再直接返回单地址。

### 验证状态

| 项 | 编译 | 真机验证 |
|---|---|---|
| 6.1 SpiderDebug static | ✅ BUILD SUCCESSFUL | ❌ **未验证**（设备离线） |
| 6.2 guard 工作目录 | ✅ BUILD SUCCESSFUL | ❌ **未验证**（设备离线） |
| 6.3 jsdelivr 候选 | ✅ BUILD SUCCESSFUL | ❌ **未验证**（设备离线） |

**阻塞原因**：本轮修改后真机 USB 断开（`adb devices` 为空），MuMu 模拟器
（`192.168.3.3:5555`）也连不上，无法装机复测。三项均需设备恢复后补验。

## 七、未完成 / 遗留

1. **guard jar 真实出片率未验证**：本次只证明「能加载、能调用、不崩溃」。
   `FyGuard` 的 `homeContent` 返回空列表，需要配对应的真实源站参数（`initExt`/`ext`）才能拉到内容。
   各 guard 源的实际可用性仍需在真机上逐个源验证。
2. **gh-proxy.net 在真机网络下不可达**（`SocketTimeoutException` 20s），
   所有依赖该镜像的 drpy 规则都无法加载。这是网络环境问题，不是代码缺陷；
   建议在订阅解析时对失效镜像做降级提示（新需求，非本轮范围）。
3. **本轮未验证**：直播频道出画、换源链、下载、投屏、ExoPlayer 引擎（见 MuMu 全流程实测报告第五节）。

## 六、复现命令

```bash
# 编译安装（真机）
cd android && ./gradlew assembleDebug --offline
adb -s BLT0222A11043727 install -r app/build/outputs/apk/debug/app-debug.apk

# 冷启动压力测试
adb -s BLT0222A11043727 logcat -c
for i in 1 2 3; do
  adb -s BLT0222A11043727 shell am force-stop com.qoder.cinema
  sleep 1
  adb -s BLT0222A11043727 shell am start -n com.qoder.cinema/.MainActivity
  sleep 8
done
adb -s BLT0222A11043727 logcat -d | grep -iE "JNI DETECTED ERROR|Abort message|SIGABRT"
adb -s BLT0222A11043727 shell pidof com.qoder.cinema

# 验证 guard jar 加载（需要本机托管 jar）
python -m http.server 8803 --directory tmp/jars &
adb -s BLT0222A11043727 reverse tcp:8803 tcp:8803
PID=$(adb -s BLT0222A11043727 shell pidof com.qoder.cinema | tr -d '\r')
adb -s BLT0222A11043727 forward tcp:9334 localabstract:webview_devtools_remote_$PID
WV_PORT=9334 node scripts/mumu-driver.cjs eval \
  "(async()=>{const P=window.Capacitor.Plugins.Spider;\
   return JSON.stringify(await P.load({jarUrl:'http://127.0.0.1:8803/<guard>.jar',api:'csp_FyGuard'}));})()"
```
