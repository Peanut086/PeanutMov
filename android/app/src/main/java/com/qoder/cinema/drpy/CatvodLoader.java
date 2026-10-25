package com.qoder.cinema.drpy;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * catvod JS 模块规则加载器（v1.8/CHG-27）
 *
 * 规则形态（Spike 样本：jadehh/TVSpider 等 FongMi 系仓库）：
 *   import {_} from '../lib/cat.js';
 *   import {Spider} from './spider.js';
 *   ... class XxxSpider extends Spider ...
 *   export function __jsEvalReturn() { return {init, home, homeVod, category, detail, play, search, proxy}; }
 *
 * 变换策略（路线①：import 改写 + 拼接，Spike 拍板）：
 *   1. 递归解析 import（相对说明符按规则 URL 解析），HTTP 拉取模块并缓存
 *      （filesDir/catvod-modules/{md5}.js，单模块 8MB / 总量 16MB / 最多 40 个模块）；
 *   2. 依赖拓扑序拼接为单脚本，QuickJS 词法作用域天然提供跨模块可见性：
 *      - `import {A as B} from 'x'` → `var B = <x 中 A 的原始顶层名>;`
 *      - `import * as N from 'x'`  → `var N = {导出名: 原始名, ...};`
 *      - `import D from 'x'`       → `var D = __catDefault_<i>;`（x 的 `export default E` → `var __catDefault_<i> = (E);`）
 *      - `export function/class/const...` → 去掉 export 前缀（成为顶层声明）
 *      - `export {a, b as c}` → 删除名单（名字已由原始声明提供）；`export {x as default}` → default 变量
 *   3. cat.js 是自包含 UMD bundle 且不导出 req/pdfh/pd——原生面直接复用 drpy_host.js。
 *
 * 已知边界（设备验证清单）：顶层 const/let 重名会在编译期报错（词法冲突按错误暴露）；
 * 不支持动态 import() 与循环依赖（明确报错）；assets:// 说明符不支持（需 APK 内置资源）。
 */
public final class CatvodLoader {

    private static final String TAG = "CatvodLoader";
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long MAX_MODULE_BYTES = 8L * 1024 * 1024;
    private static final long MAX_TOTAL_BYTES = 16L * 1024 * 1024;
    private static final int MAX_MODULES = 40;

    private CatvodLoader() {}

    /* ---------------- 模块模型 ---------------- */

    private static final class Module {
        final String url;
        final String code;
        final String fileName;
        /** 依赖（按 import 出现顺序） */
        final List<String> deps = new ArrayList<>();
        /** 导出名 → 顶层原始名（如 `_ → Sh`） */
        final Map<String, String> exportedToOrig = new LinkedHashMap<>();
        boolean hasDefaultExport = false;
        int defaultVarIndex = -1;

        Module(String url, String code, String fileName) {
            this.url = url;
            this.code = code;
            this.fileName = fileName;
        }
    }

    /* ---------------- import / export 识别 ---------------- */

    private static final Pattern IMPORT_LINE = Pattern.compile(
            "(?m)^[ \\t]*import[ \\t]+.*['\"][^'\"]+['\"][ \\t]*;?[ \\t]*$");
    private static final Pattern SPEC_AT_END = Pattern.compile("['\"]([^'\"]+)['\"][ \\t]*;?[ \\t]*$");
    private static final Pattern NS_IMPORT = Pattern.compile("^[ \\t]*import[ \\t]+\\*[ \\t]*as[ \\t]+(\\w+)[ \\t]+from[ \\t]+");
    private static final Pattern DEF_IMPORT = Pattern.compile("^[ \\t]*import[ \\t]+(\\w+)[ \\t]*,[ \\t]*\\{([^}]*)\\}[ \\t]+from[ \\t]+");
    private static final Pattern DEF_ONLY_IMPORT = Pattern.compile("^[ \\t]*import[ \\t]+(\\w+)[ \\t]+from[ \\t]+");
    private static final Pattern LIST_IMPORT = Pattern.compile("^[ \\t]*import[ \\t]+\\{([^}]*)\\}[ \\t]+from[ \\t]+");
    private static final Pattern BARE_IMPORT = Pattern.compile("^[ \\t]*import[ \\t]+['\"]");

    /** export 名单（含跨行）：`export { a, b as c } from 'x' ?` */
    private static final Pattern EXPORT_LIST = Pattern.compile(
            "export[ \\t]*\\{([^}]*)\\}[ \\t]*(?:from[ \\t]*['\"]([^'\"]+)['\"][ \\t]*)?;?",
            Pattern.DOTALL);
    /** export default <expr> 至行尾/分号（类/函数表达式包一层括号） */
    private static final Pattern EXPORT_DEFAULT = Pattern.compile(
            "(?m)^[ \\t]*export[ \\t]+default[ \\t]+(.+?);?[ \\t]*$");
    /** export 声明前缀（function/class/const/let/var/async function） */
    private static final Pattern EXPORT_DECL = Pattern.compile(
            "(?m)^[ \\t]*export[ \\t]+(?=(?:async[ \\t]+function|function|class|const|let|var)\\b)");
    private static final Pattern EXPORTED_DECL_NAME = Pattern.compile(
            "^[ \\t]*export[ \\t]+(?:async[ \\t]+function|function|class|const|let|var)[ \\t]+([\\w$]+)",
            Pattern.MULTILINE);

    /* ---------------- 入口 ---------------- */

    /** 规则源码 + 规则 URL → 可直接 evaluate 的拼接脚本 */
    public static String build(Context ctx, String ruleUrl, String ruleCode) throws Exception {
        Map<String, Module> modules = new LinkedHashMap<>();
        List<Module> order = new ArrayList<>();
        collect(ctx, ruleUrl, ruleCode, "catvod_entry.js", modules, order, new ArrayDeque<>());

        StringBuilder out = new StringBuilder(1 << 20);
        long total = 0;
        for (int i = 0; i < order.size(); i++) {
            Module m = order.get(i);
            m.defaultVarIndex = i;
            total += m.code.length();
            if (total > MAX_TOTAL_BYTES) {
                throw new IllegalStateException("catvod 模块总量超出上限（16MB）");
            }
            out.append("\n/* ===== catvod module[").append(i).append("]: ").append(m.url).append(" ===== */\n");
            out.append(transform(m, i == 0, order, modules));
        }
        Log.i(TAG, "catvod bundle: " + order.size() + " modules, " + out.length() + " chars");
        return out.toString();
    }

    /* ---------------- 模块图收集（DFS 拓扑序） ---------------- */

    private static void collect(
            Context ctx,
            String url,
            String code,
            String fileName,
            Map<String, Module> modules,
            List<Module> order,
            Deque<String> stack
    ) throws Exception {
        if (modules.containsKey(url)) return;
        if (stack.contains(url)) {
            throw new IllegalStateException("catvod 模块循环依赖: " + url + "（栈: " + stack + "）");
        }
        if (modules.size() + 1 > MAX_MODULES) {
            throw new IllegalStateException("catvod 模块数量超出上限（40）");
        }
        stack.push(url);
        Module module = new Module(url, code, fileName);
        modules.put(url, module);

        // 先解析依赖（递归收集，保证依赖先进入 order）
        Matcher lineMatcher = IMPORT_LINE.matcher(code);
        int searchFrom = 0;
        while (lineMatcher.find(searchFrom)) {
            searchFrom = lineMatcher.end();
            String line = lineMatcher.group();
            String spec = specifierOf(line);
            if (spec == null) continue;
            String resolved = resolveSpecifier(url, spec);
            if (!modules.containsKey(resolved)) {
                String depCode = fetchModule(ctx, resolved);
                collect(ctx, resolved, depCode, shortName(resolved), modules, order, stack);
            }
            module.deps.add(resolved);
        }

        scanExports(module);

        stack.pop();
        order.add(module); // 后序：依赖先于本模块
    }

    /** import 行 → 模块说明符（无则 null） */
    private static String specifierOf(String line) {
        Matcher m = SPEC_AT_END.matcher(line);
        return m.find() ? m.group(1) : null;
    }

    /** 解析说明符：相对路径按当前模块 URL；只允许 http(s) */
    private static String resolveSpecifier(String baseUrl, String spec) {
        if (spec.startsWith("assets://") || spec.startsWith("file://")) {
            throw new IllegalStateException("暂不支持内置资源说明符: " + spec + "（catvod 仅支持 http(s) 模块）");
        }
        try {
            String resolved = URI.create(baseUrl).resolve(spec).toString();
            if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) {
                throw new IllegalStateException("catvod 模块地址非法: " + spec + " → " + resolved);
            }
            return resolved;
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("解析 catvod 模块地址失败: " + spec + "（基于 " + baseUrl + "）");
        }
    }

    /* ---------------- export 扫描（导出名 → 原始顶层名） ---------------- */

    private static void scanExports(Module m) {
        // ① export function/class/const NAME ...
        Matcher decl = EXPORTED_DECL_NAME.matcher(m.code);
        while (decl.find()) {
            String name = decl.group(1);
            m.exportedToOrig.put(name, name);
        }
        // ② export { a, b as c } [from 'x']
        // 带 from 的再导出不注册到本模块（原始名在依赖里），变换期单独处理
        Matcher list = EXPORT_LIST.matcher(m.code);
        while (list.find()) {
            String names = list.group(1);
            String from = list.group(2);
            for (String part : names.split(",")) {
                String entry = part.trim();
                if (entry.isEmpty()) continue;
                String[] seg = entry.split("\\s+as\\s+");
                String orig = seg[0].trim();
                String exported = seg.length > 1 ? seg[1].trim() : orig;
                if (exported.equals("default")) {
                    m.hasDefaultExport = true; // `export {x as default}` → 变换期生成 default 变量
                } else if (from == null) {
                    m.exportedToOrig.put(exported, orig);
                }
            }
        }
        // ③ export default EXPR（标记 + 变换期处理）
        if (EXPORT_DEFAULT.matcher(m.code).find()) m.hasDefaultExport = true;
    }

    /* ---------------- 变换 ---------------- */

    private static String transform(Module m, boolean isEntry, List<Module> order, Map<String, Module> modules) {
        StringBuilder code = new StringBuilder(m.code);

        // ① 移除 / 改写 import 行（自下而上保持偏移有效）
        Matcher lineMatcher = IMPORT_LINE.matcher(code);
        List<int[]> ranges = new ArrayList<>();
        List<String> replacements = new ArrayList<>();
        while (lineMatcher.find()) {
            ranges.add(new int[]{lineMatcher.start(), lineMatcher.end()});
            replacements.add(bindingOf(m, lineMatcher.group(), modules));
        }
        for (int i = ranges.size() - 1; i >= 0; i--) {
            code.replace(ranges.get(i)[0], ranges.get(i)[1], replacements.get(i));
        }

        // ② export { ... } [from 'x'] → 绑定行或删除
        Matcher list = EXPORT_LIST.matcher(code);
        StringBuilder sb = new StringBuilder();
        int cursor = 0;
        while (list.find()) {
            sb.append(code, cursor, list.start());
            String names = list.group(1);
            String from = list.group(2);
            StringBuilder bind = new StringBuilder();
            for (String part : names.split(",")) {
                String entry = part.trim();
                if (entry.isEmpty()) continue;
                String[] seg = entry.split("\\s+as\\s+");
                String orig = seg[0].trim();
                String exported = seg.length > 1 ? seg[1].trim() : orig;
                if (from == null) {
                    if (exported.equals("default")) {
                        bind.append("var __catDefault_").append(m.defaultVarIndex).append(" = ").append(orig).append(";");
                    }
                    // 非默认名单：名字已由原始顶层声明提供，无需绑定
                } else {
                    // 再导出：export {a as b} from 'y' → var b = <y 中 a 的原始名>;
                    Module dep = modules.get(resolveSpecifier(m.url, from));
                    if (dep == null) throw new IllegalStateException("再导出依赖未收集: " + from);
                    String depOrig = dep.exportedToOrig.get(orig);
                    if (depOrig == null) {
                        if (exported.equals("default") && dep.hasDefaultExport) {
                            depOrig = "__catDefault_" + dep.defaultVarIndex;
                        } else {
                            throw new IllegalStateException("再导出的名字不存在: " + orig + "（来自 " + from + "）");
                        }
                    }
                    bind.append("var ").append(exported.equals("default")
                            ? "__catDefault_" + m.defaultVarIndex : exported)
                        .append(" = ").append(depOrig).append(";");
                }
            }
            sb.append(bind);
            cursor = list.end();
        }
        sb.append(code, cursor, code.length());
        code = sb;

        // ③ export default → default 变量
        // 单行表达式（对象/标识符/调用）直接包一层；命名 function/class 去前缀、
        // 模块尾部补绑定（多行函数体只匹配到首行，正文原样保留）；
        // 匿名多行 function/class 默认导出不支持（明确报错）。
        Matcher def = EXPORT_DEFAULT.matcher(code);
        sb = new StringBuilder();
        cursor = 0;
        String pendingDefaultName = null;
        Pattern namedDefault = Pattern.compile("^(?:async[ \\t]+function|function|class)[ \\t]+([\\w$]+)");
        while (def.find()) {
            sb.append(code, cursor, def.start());
            String expr = def.group(1).trim();
            if (expr.endsWith(";")) expr = expr.substring(0, expr.length() - 1);
            Matcher named = namedDefault.matcher(expr);
            if (named.find()) {
                sb.append(expr);
                pendingDefaultName = named.group(1);
            } else if (expr.startsWith("function") || expr.startsWith("class") || expr.startsWith("async")) {
                throw new IllegalStateException("暂不支持匿名多行默认导出（" + m.url + "）");
            } else {
                sb.append("var __catDefault_").append(m.defaultVarIndex).append(" = (").append(expr).append(");");
            }
            cursor = def.end();
        }
        sb.append(code, cursor, code.length());
        code = sb;
        if (pendingDefaultName != null) {
            code.append("\nvar __catDefault_").append(m.defaultVarIndex).append(" = ").append(pendingDefaultName).append(";");
        }

        // ④ export function/class/const... → 去前缀
        code = new StringBuilder(EXPORT_DECL.matcher(code).replaceAll(""));

        // ⑤ 入口 default 别名固定名（DrpyRuntime 取 __catDefault_entry）
        if (isEntry && m.hasDefaultExport) {
            code.append("\nvar __catDefault_entry = __catDefault_").append(m.defaultVarIndex).append(";");
        }
        return code.toString();
    }

    /** import 行 → 绑定代码（var 本地名 = 原始名; / var Ns = {...}; / 空） */
    private static String bindingOf(Module m, String line, Map<String, Module> modules) {
        String spec = specifierOf(line);
        Module dep = modules.get(resolveSpecifier(m.url, spec));

        Matcher ns = NS_IMPORT.matcher(line);
        if (ns.matches()) {
            String local = ns.group(1);
            StringBuilder obj = new StringBuilder("var ").append(local).append(" = {");
            boolean first = true;
            for (Map.Entry<String, String> e : dep.exportedToOrig.entrySet()) {
                if (!first) obj.append(",");
                first = false;
                obj.append(e.getKey()).append(":").append(e.getValue());
            }
            if (dep.hasDefaultExport) {
                if (!first) obj.append(",");
                obj.append("default:__catDefault_").append(dep.defaultVarIndex);
            }
            obj.append("};");
            return obj.toString();
        }

        StringBuilder bind = new StringBuilder();
        Matcher defList = DEF_IMPORT.matcher(line);
        if (defList.matches()) {
            appendDefaultBind(bind, defList.group(1), dep);
            appendNamedBinds(bind, defList.group(2), dep);
            return bind.toString();
        }
        Matcher defOnly = DEF_ONLY_IMPORT.matcher(line);
        if (defOnly.matches()) {
            appendDefaultBind(bind, defOnly.group(1), dep);
            return bind.toString();
        }
        Matcher listImp = LIST_IMPORT.matcher(line);
        if (listImp.matches()) {
            appendNamedBinds(bind, listImp.group(1), dep);
            return bind.toString();
        }
        if (BARE_IMPORT.matcher(line).matches()) return ""; // 副作用导入：模块本身已评估
        return ""; // 未知形态（多行 import 等）：保守移除，未绑定名会以 ReferenceError 暴露
    }

    private static void appendDefaultBind(StringBuilder bind, String local, Module dep) {
        if (!dep.hasDefaultExport) {
            throw new IllegalStateException("默认导入目标没有 export default: " + dep.url);
        }
        bind.append("var ").append(local).append(" = __catDefault_").append(dep.defaultVarIndex).append(";");
    }

    /** `{ A, B as C }` → var A = <orig(A)>; var C = <orig(B)>;（同名省略绑定） */
    private static void appendNamedBinds(StringBuilder bind, String names, Module dep) {
        if (names == null) return;
        for (String part : names.split(",")) {
            String entry = part.trim();
            if (entry.isEmpty()) continue;
            String[] seg = entry.split("\\s+as\\s+");
            String imported = seg[0].trim();
            String local = seg.length > 1 ? seg[1].trim() : imported;
            String orig = dep.exportedToOrig.get(imported);
            if (orig == null) {
                throw new IllegalStateException("导入的名字不存在: " + imported + "（来自 " + dep.url + "）");
            }
            if (orig.equals(local)) continue; // 同名：依赖顶层声明直接可见
            bind.append("var ").append(local).append(" = ").append(orig).append(";");
        }
    }

    /* ---------------- 模块下载（带磁盘缓存） ---------------- */

    private static final Map<String, String> memoryCache = new HashMap<>();

    private static String fetchModule(Context ctx, String url) throws Exception {
        String cached = memoryCache.get(url);
        if (cached != null) return cached;

        File dir = new File(ctx.getFilesDir(), "catvod-modules");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cannot create catvod-modules dir");
        File target = new File(dir, md5Of(url) + ".js");
        if (!target.exists()) {
            downloadTo(url, target);
        }
        byte[] bytes = readAll(target);
        String code = new String(bytes, "UTF-8");
        memoryCache.put(url, code);
        Log.i(TAG, "module ready: " + url + " (" + code.length() + " chars)");
        return code;
    }

    private static void downloadTo(String url, File target) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) PeanutMov");
        try {
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status + ": " + url);
            File temp = new File(target.getParentFile(), target.getName() + ".tmp");
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[16384];
                long total = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_MODULE_BYTES) throw new IllegalStateException("模块过大: " + url);
                    out.write(buffer, 0, read);
                }
            }
            if (!temp.renameTo(target)) throw new IllegalStateException("cannot save module: " + url);
        } finally {
            conn.disconnect();
        }
    }

    private static byte[] readAll(File file) throws Exception {
        long size = file.length();
        if (size > MAX_MODULE_BYTES) throw new IllegalStateException("模块过大: " + file.getName());
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[(int) size];
            int total = 0;
            int read;
            while (total < buffer.length && (read = in.read(buffer, total, buffer.length - total)) > 0) {
                total += read;
            }
            return buffer;
        }
    }

    private static String shortName(String url) {
        int slash = url.lastIndexOf('/');
        return slash >= 0 ? url.substring(slash + 1) : url;
    }

    private static String md5Of(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] bytes = digest.digest(value.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(value.hashCode());
        }
    }
}
