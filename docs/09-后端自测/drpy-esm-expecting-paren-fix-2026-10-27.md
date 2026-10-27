# drpy2.min.js `expecting '('` 根因与修复（2026-10-27）

> 现象：加载 `drpy2.min.js`（drpy 2.1 运行时库）报
> `规则加载失败: expecting '(' at catvod_bundle.js:3`
> 排查对象：`android/app/src/main/java/com/qoder/cinema/drpy/CatvodLoader.java`

## 一、结论

`expecting '('` 是 **CatvodLoader 的 ES module 转换缺陷**，与网络、规则内容无关。
`drpy2.min.js` 是 ES module，触发 `CATVOD_IMPORT_RE` 走拼接路径，但转换器有 **4 个连锁缺陷**：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `IMPORT_LINE` 只匹配单行 import | 多行 import 原样残留 → QuickJS 把 `import` 当动态 import → `expecting '('` |
| 2 | `bindingOf` 用 `matches()`（整串匹配） | import 末尾有说明符，子模式永远整串不匹配 → 绑定被静默丢弃 |
| 3 | `EXPORT_DEFAULT` 用 `(.+?)$` 非贪婪 | `export default {` 多行对象被截断成 `var __catDefault_0 = ({);` → **语法错误** |
| 4 | `scanExports` 只查单行正则 | 多行 default 漏判 → 入口拿不到 `__catDefault_entry` |
| 5 | `build()` 用 `i == 0` 判入口 | `collect()` 是后序（依赖先入），入口在**最后**，第 0 个是依赖 |

## 二、证据链

### 2.1 缺陷 3 的直接复现（最关键）

`drpy2.min.js` 第 3186 行是 `export default {` 开头的多行对象。旧逻辑产物：

```js
var __catDefault_0 = ({);
```

Node 校验：

```
$ node --check old-final.js
SyntaxError: Unexpected token ')'
```

QuickJS 报 `expecting '('` —— **与实测错误完全对应**（两引擎对同一畸形语法的措辞不同）。

新逻辑产物：

```
$ node --check final.js
exit=0
```

### 2.2 转换结果对比

| 项 | 旧逻辑 | 新逻辑 |
|---|---|---|
| import 匹配 | ❌ False（多行不匹配） | ✅ 整段 62 字符 |
| default 匹配 | ⚠️ 只吃到 `{` | ✅ 288 字符完整字面量 |
| import/export 残留 | 有 | 0 |
| `__catDefault_entry` | 未生成 | 已生成 |
| 产物语法 | SyntaxError | 通过 |

### 2.3 逐层验证（真机 BLT0222A11043727）

每修一层，错误就前进一步，说明修复真实生效：

```
① 修复前：expecting '(' at catvod_bundle.js:3
② 修多行 import + default 后：redeclaration of 'MOBILE_UA'
③ const/let 降级为 var 后：catvod 规则未导出可用的 __jsEvalReturn
④ 修入口索引 + hasDefaultExport 后：LOAD OK: {"handle":"dp-13"}
⑤ 调用时：When invoke console stuff, you should be set a stdout ...
⑥ setConsole 后：Value {"class":[]} ... cannot be converted to JSONObject
```

## 三、修复内容

### 3.1 多行 import（`IMPORT_LINE`）

```java
// 旧：要求整条语句在一行内
"(?m)^[ \t]*import[ \t]+.*['\"][^'\"]+['\"][ \t]*;?[ \t]*$"
// 新：允许中间跨行
"(?m)^[ \t]*import[ \t]+(?:[^;]*?)[ \t]*['\"][^'\"\n]+['\"][ \t]*;?[ \t]*$"
```

`DEF_IMPORT` / `LIST_IMPORT` 补 `Pattern.DOTALL`。

### 3.2 `bindingOf` 改 `find()`

`matches()` 要求整串匹配，而 import 语句末尾还有 `from "x.js";`，
子模式只覆盖到 `from ` 之前 → 必然失败 → 绑定静默丢弃。全部改 `find()`。

### 3.3 多行 export default（新增 ③-a 步 + `matchBracket`）

`EXPORT_DEFAULT` 收窄为单行（排除 `{`），多行字面量用括号配平扫描：

```java
private static int matchBracket(String code, int openIndex)
// 跳过字符串字面量与注释，避免字符串里的 {} 误判
```

### 3.4 `hasDefaultExport` 同时查两种形态

```java
if (EXPORT_DEFAULT.matcher(m.code).find()
        || EXPORT_DEFAULT_MULTILINE.matcher(m.code).find()) {
    m.hasDefaultExport = true;
}
```

### 3.5 入口索引

```java
// collect() 后序遍历：依赖先入 order，入口在最后
int entryIndex = order.size() - 1;
... transform(m, i == entryIndex, ...)
```

### 3.6 顶层 const/let → var

多模块拼接共享词法作用域，两个模块各声明 `const MOBILE_UA` 会编译期报错。
只处理行首（顶层）声明，函数体内局部 `const` 保持原样：

```java
TOP_LEVEL_CONST_LET = "(?m)^([ \t]*)(?:const|let)(?=[ \t]+[\w$\[{])"
```

### 3.7 console 绑定

wrapper 未设 `setConsole` 时，规则里任何 `console.log` 都抛
`When invoke console stuff, you should be set a stdout of platform to console.stdout`。
在 JS 侧覆盖无效（原生绑定调用时才检查），必须在原生设：

```java
ctx.setConsole(new RuleConsole(handle));  // 落 logcat，tag = DrpyRule/<handle>
```

### 3.8 drpy 库 vs catvod 规则分流

`drpy2.min.js` 的 default 导出是 **drpy 风格** `{runMain, getRule, home, ...}`（`home` 无参），
不是 catvod Spider `{home(filter), category(tid,pg,filter,ext), ...}`。
错挂到 `__catvod` 会让 `sp.home(true)` 返回字符串，下游 `new JSONObject()` 报
`Value {"class":[]} ... cannot be converted to JSONObject`。

按导出对象特征键分流：

```js
var isDrpyLib = (typeof o.runMain === 'function') || (typeof o.getRule === 'function');
if (isDrpyLib) { globalThis.rule = o; } else { globalThis.__catvod = o; }
```

## 四、验证状态

| 项 | 状态 |
|---|---|
| 编译 | ✅ BUILD SUCCESSFUL |
| `node --check` 产物语法 | ✅ exit=0 |
| 真机 `P.load(drpy2.min.js)` | ✅ `LOAD OK: {"handle":"dp-13"}` |
| 真机 `P.invoke(home)` | ⚠️ **未通过**（见下） |

**`invoke` 仍失败**：分流修复（3.8）已提交编译，但因真机 USB 反复掉线
（`device` ↔ `offline` ↔ `unauthorized` 抖动），最后一次验证未能完成。
WebView DevTools socket 一度完全不可用（`/proc/net/unix` 无 webview 记录），
需设备稳定后复测。

## 五、复现与验证命令

```bash
# 编译
cd android && ./gradlew assembleDebug --offline
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk

# DevTools 通道
PID=$(adb -s <serial> shell pidof com.qoder.cinema | tr -d '\r')
adb -s <serial> forward tcp:9334 localabstract:webview_devtools_remote_$PID

# 验证加载
WV_PORT=9334 node scripts/mumu-driver.cjs eval \
  "(async()=>{const P=window.Capacitor.Plugins.Drpy;\
   return JSON.stringify(await P.load({ruleUrl:'https://raw.githubusercontent.com/ne7359/tvurl/main/lib/drpy2.min.js',initExt:''}));})()"

# 日志
adb -s <serial> logcat -d | grep -E "CatvodLoader|DrpyRuntime|DrpyRule"
```
