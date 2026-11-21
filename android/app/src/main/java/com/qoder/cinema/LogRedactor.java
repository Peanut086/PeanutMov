package com.qoder.cinema;

import java.io.IOException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 日志文本脱敏（P2-3）。
 *
 * <h3>为什么必须有</h3>
 * 爬虫与网盘链路为了可诊断，会把请求头、响应头和响应体原样写进日志。真机导出文件里
 * 实测存在 {@code set-cookie=*** path=/, server_session_4e4bb913=976a898f…}
 * 这类会话材料，以及 {@code AliYun.init constructor cache:{"oauth":{"access_token":…}}}、
 * {@code pan115_cookie:"…"} 这类账号凭据字段——把这些文件发到群里提问，等于把网盘账号交给陌生人。
 * 旧写入规则只按 {@code cookie} 一个键打码，{@code server_session_…} 那一段原样留在文件里。
 *
 * <p>脱敏口径只在这里定义一次：写入前（{@link SpiderLogStore}）与导出时
 * （{@link SpiderLogStore#exportMerged} / {@link CrashEventsCollector#export}）共用，
 * 导出时再兜一遍是因为磁盘上还有旧版本落的原文，tombstone 与崩溃栈也绕过了写入路径。
 *
 * <h3>刻意保留什么</h3>
 * 只替换「值」，保留「键」与结构：脱敏后仍能看出这一步带过哪些 cookie、有没有 {@code Accept} 与
 * {@code User-Agent}、{@code path} 与 {@code Max-Age} 是什么——{@code md5=}/{@code size=}/
 * {@code status=} 等诊断字段一律不动（见 {@link #DIAGNOSTIC_KEYS}），响应体也不截断，
 * 它们是定位假清单、规则不兼容的主要材料，命中键名的敏感值已就地打码。
 *
 * <h3>不做什么</h3>
 * 不脱敏 URL 主机名与路径（换域名就没法定位是哪个源坏了），也不追求密码学级不可逆：
 * 目标是「分享出去的日志不再携带账号凭据与个人身份」，同时诊断能力不打折。
 */
public final class LogRedactor {

    private LogRedactor() {
    }

    /** 脱敏标记 */
    static final String MASK = "***";

    /**
     * 凭据与个人身份类键名：命中即把值替换成 ***（键名与分隔符原样保留）。
     * {@code cookie} 不在名单里——它由 {@link #COOKIE_HEADER} 专用规则逐段处理，
     * 走通用键值规则会把整串 cookie 连同后面的 {@code Accept} 一起盖掉。
     */
    private static final String CREDENTIAL_KEYS =
            "token|access_token|refresh_token|open_token|opentoken|id_token|jwt|device_token"
                    + "|x-ku-\\w+|x-kuacc-\\w+"
                    + "|password|passwd|pwd|pwd_id|share_id|shareid|surl|fid"
                    + "|api_?key|apikey|app_?key|secret|secret_key|app_?secret|client_secret|sign|msign|qsign|tmp_sign|temp_key"
                    + "|session|sessionid|session_id|jsessionid|phpsessid|asp\\.net_sessionid"
                    + "|__pus|__puus|__kp|__up__cf|_up_\\w+"
                    + "|uid|user_id|userid|unionid|open_id|openid|nickname|nick_name|screen_name"
                    + "|mobile|phone|tel|contact"
                    + "|imei|oaid|android_id|device_id|idfa|mac";

    /**
     * 键与值之间的连接符：只认「值紧跟在 {@code =} / {@code :} 之后」这几种真实写法——
     * {@code k=v}、{@code "k": "v"}、转义后的 {@code \"k\":\"v\"}。
     *
     * <p>刻意不含 {@code _} 与 {@code -}：否则 {@code Cookie=__pus=x} 会把下一个键名的一截
     * 当成连接符吃掉，打出 {@code Cookie=__***} 这种看不出发生了什么的日志；也不含 {@code /}：
     * 否则 {@code ...-time/900} 这类直链路径会被误判成键值对。
     */
    private static final String CONNECTOR = "([\\\\]{0,2}[\"']?\\s*[=:]\\s*[\\\\]{0,2}[\"']?)";

    /**
     * 值：到引号、逗号、分号、&amp;、空白、闭括号、尖括号、反斜杠为止（允许含 {@code =}）。
     * 尖括号是实测量加的：爬虫把 404 的 HTML 原样打进了 {@code Ali init token:<html>…}，
     * 不排除就会把响应体从中间咬断，只剩半句 {@code Not Found}。
     */
    private static final String VALUE = "([^\"',;&\\s}\\]\\<>\\\\]+)";

    /** 键=值 / 键:值：命中名单内的凭据与身份键 */
    private static final Pattern CREDENTIAL_KV = Pattern.compile(
            "(?i)\\b(" + CREDENTIAL_KEYS + ")\\b" + CONNECTOR + VALUE);

    /** cookie 头定位：`Cookie=` / `Set-Cookie: ` / `\"cookie\":\"` 之后的值区起点 */
    private static final Pattern COOKIE_HEADER = Pattern.compile("(?i)\\bcookie\\b" + CONNECTOR);

    /** cookie 值区里的一个 {@code 名=值} */
    private static final Pattern COOKIE_PAIR = Pattern.compile("([A-Za-z0-9_.\\-]{1,64})=([^;,)}\\]'\"\\\\\\s]*)");

    /** cookie 属性名：不是凭据，值留着才能判断域与有效期（{@code path=/}、{@code Max-Age=864000}） */
    private static final Set<String> COOKIE_ATTRS = new HashSet<>(Arrays.asList(
            "path", "domain", "expires", "max-age", "httponly", "secure", "samesite",
            "version", "comment", "partitioned"));

    /**
     * `Authorization`/`Proxy-Authorization` 单独一条：值常常是 `Bearer <长令牌>`，
     * 用通用键值规则会把方案名当成值打掉、真令牌反而留着。
     */
    private static final Pattern AUTH_VALUE = Pattern.compile(
            "(?i)\\b(authorization|proxy_authorization)\\b" + CONNECTOR
                    + "(bearer|basic)?(\\s*)([^\\s\"',;&}\\]\\<>\\\\]+)");

    /** 没带键名、但方案名与长令牌同时出现（curl 回显、原始请求行等） */
    private static final Pattern BEARER = Pattern.compile(
            "(?i)\\b(bearer|basic)\\s+[A-Za-z0-9._+/=\\-]{8,}");

    /**
     * URL 查询串里的单/双字母签名键：{@code ?s=}（夸克直链签名）、{@code ?do=}（网盘代理转发口令）。
     * 键名太短，进不了 {@link #CREDENTIAL_KEYS}（那条规则要求完整词边界，1-2 个字母的键
     * 在采集站地址里另有含义），也进不了 {@link #OPAQUE_VALUE}（键名下限 3 位），
     * 于是真机 39 处 {@code ?s=} 一条都没打码地写进了分享日志。
     */
    private static final Pattern SHORT_SIGNED_QUERY = Pattern.compile(
            "(?i)([?&](?:s|do)=)([^&#\\s\"'\\\\]{1,256})");

    /** 签名形状允许出现的字符（含百分号编码，夸克签名尾部就是 {@code %2F} {@code %3D}） */
    private static final String SIGNATURE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789%._+/=-";

    /**
     * 「像签名」才打码：≥8 位、字符集受限、且字母与数字同时出现。
     *
     * <p>这条门控不是保险起见的冗余，是同一份真机日志教出来的：63200 行里 39 处 {@code ?s=}，
     * 35 处是采集站的搜索词、4 处才是直链签名。无差别盖掉就把「哪个词发到了哪个源」
     * 这条唯一的请求侧线索一起废了。
     */
    private static boolean isSignatureShape(String value) {
        if (value.length() < 8) return false;
        boolean digit = false;
        boolean letter = false;
        for (int i = 0; i < value.length(); i++) {
            char c = Character.toLowerCase(value.charAt(i));
            if (c >= '0' && c <= '9') digit = true;
            else if (c >= 'a' && c <= 'z') letter = true;
            else if (SIGNATURE_CHARS.indexOf(c) < 0) return false;
        }
        return digit && letter;
    }

    private static String redactShortSigned(String text) {
        Matcher m = SHORT_SIGNED_QUERY.matcher(text);
        if (!m.find()) return text;
        StringBuilder sb = new StringBuilder(text.length());
        int last = 0;
        do {
            if (!isSignatureShape(m.group(2))) continue;
            sb.append(text, last, m.start()).append(m.group(1)).append(MASK);
            last = m.end();
        } while (m.find());
        sb.append(text, last, text.length());
        return sb.toString();
    }

    /**
     * 没命中键名、但值明显是会话材料的情况（{@code server_session_4e4bb913=976a898f…}、
     * 32 位 hex 签名等）。刻意只认「纯 hex」与「纯字母数字长串」，不用 {@code =:} 通配：
     * 否则 {@code path=/storage/…} 这类还有诊断价值的定位串会被一起盖掉。
     * 键名在诊断白名单里时跳过，避免把 md5/size 打成星号。
     */
    private static final Pattern OPAQUE_VALUE = Pattern.compile(
            "(?i)\\b([a-z0-9_.\\-]{3,64})=([0-9a-f]{24,64}|[0-9a-z]{30,})\\b");

    /** 诊断字段：值是哈希/长度/状态，脱敏它们只会让日志失去用处 */
    private static final Set<String> DIAGNOSTIC_KEYS = new HashSet<>(Arrays.asList(
            "md5", "md5sum", "sha1", "sha256", "hash", "etag", "size", "bytes", "length",
            "duration", "ts", "timestamp", "time", "start", "end", "version", "code",
            "status", "http_status", "port", "count", "index", "page", "seq", "attempt",
            "retry", "timeout", "budget", "limit", "width", "height", "bitrate", "level",
            "expected", "actual", "want", "got", "prev", "old", "new"));

    /** 出现这些片段才值得跑完整规则集，避免每行都白扫一遍 */
    private static final String[] HINTS = {
            "token", "cookie", "authoriz", "passw", "pwd", "secret", "sign", "api_", "apikey",
            "_up_", "__pus", "__puus", "bearer", "basic", "nick", "mobile", "phone", "openid",
            "unionid", "user_id", "session", "imei", "oaid", "android_id", "device_id", "fid=",
    };

    /** 命中任一提示词（大小写不敏感） */
    private static boolean hasHint(String lower) {
        for (String hint : HINTS) {
            if (lower.contains(hint)) return true;
        }
        return false;
    }

    /**
     * 对一段日志文本脱敏（可含多行，逐条规则整段替换）。
     * 值统一替换成 {@code ***}，键名、连接符与其余文本保持原样；重复调用结果不变（幂等）。
     */
    public static String redact(String text) {
        if (text == null || text.isEmpty()) return text;
        if (text.indexOf('=') < 0 && text.indexOf(':') < 0) return text;
        String result = text;
        if (hasHint(result.toLowerCase(Locale.US))) {
            result = AUTH_VALUE.matcher(result).replaceAll("$1$2$3$4" + MASK);
            result = redactCookies(result);
            result = BEARER.matcher(result).replaceAll("$1 " + MASK);
            result = CREDENTIAL_KV.matcher(result).replaceAll("$1$2" + MASK);
        }
        return redactOpaque(redactShortSigned(result));
    }

    /**
     * cookie 值区逐段脱敏：{@code 名=值} 只打值，属性名（{@code path} 等）整段保留，
     * 值区之外的文本一律不碰——同一条日志里的 {@code Accept}、{@code User-Agent}、
     * {@code nel} 这些响应头要继续可读（真机日志里就是一行 {@code set-cookie} 后面跟着它们）。
     */
    private static String redactCookies(String text) {
        Matcher head = COOKIE_HEADER.matcher(text);
        // 先在原文上把值区找齐，再从后往前替换：边替换边找会让下标对不上
        List<Run> runs = new ArrayList<>();
        while (head.find()) {
            int from = head.end();
            int to = cookieRunEnd(text, from);
            if (to > from) {
                runs.add(new Run(from, to, false));
            } else if (isBareCookie(text, from)) {
                // `Cookie: <裸令牌>`：没有 `名=值` 结构可留，第一个边界之前整段打掉
                runs.add(new Run(from, segmentEnd(text, from), true));
            }
        }
        if (runs.isEmpty()) return text;
        StringBuilder sb = new StringBuilder(text);
        for (int i = runs.size() - 1; i >= 0; i--) {
            Run run = runs.get(i);
            if (run.whole) sb.replace(run.from, run.to, MASK);
            else sb.replace(run.from, run.to, maskCookieRun(text.substring(run.from, run.to)));
        }
        return sb.toString();
    }

    /** cookie 值区：{@code whole=true} 表示整段是裸令牌，直接盖掉 */
    private static final class Run {
        final int from;
        final int to;
        final boolean whole;

        Run(int from, int to, boolean whole) {
            this.from = from;
            this.to = to;
            this.whole = whole;
        }
    }

    /** 值区内逐个 {@code 名=值} 打码，属性名（path / Max-Age 等）原样保留 */
    private static String maskCookieRun(String run) {
        Matcher pair = COOKIE_PAIR.matcher(run);
        StringBuilder out = new StringBuilder(run.length());
        int last = 0;
        while (pair.find()) {
            if (COOKIE_ATTRS.contains(pair.group(1).toLowerCase(Locale.US))) continue;
            out.append(run, last, pair.start()).append(pair.group(1)).append('=').append(MASK);
            last = pair.end();
        }
        return out.append(run, last, run.length()).toString();
    }

    /** 值区起点的这一段是不是裸 cookie 串（形如 {@code Cookie: abcdef…}，没有 `名=值` 结构） */
    private static boolean isBareCookie(String text, int from) {
        int stop = segmentEnd(text, from);
        if (stop <= from) return false;
        String seg = text.substring(from, stop).trim();
        if (seg.isEmpty() || seg.charAt(0) == '"' || seg.charAt(0) == '\'' || seg.charAt(0) == '<') return false;
        return !seg.contains("=") && seg.matches("[0-9A-Za-z._+/=-]{8,}");
    }

    /**
     * cookie 值区右边界：{@code ;} 之后仍是 cookie 段就继续，遇到
     * {@code , } {@code ]} {@code }} 引号 反斜杠 换行 即止（响应头 map 的下一项不是 cookie）。
     */
    private static int cookieRunEnd(String text, int from) {
        int pos = from;
        while (true) {
            int stop = segmentEnd(text, pos);
            if (!isCookieSegment(text.substring(pos, stop))) return pos;
            if (stop >= text.length() || text.charAt(stop) != ';') return stop;
            int next = stop + 1;
            while (next < text.length() && text.charAt(next) == ' ') next++;
            if (next >= text.length()) return stop;
            pos = next;
        }
    }

    /** 到下一个分隔符为止（不含） */
    private static int segmentEnd(String text, int from) {
        for (int i = from; i < text.length(); i++) {
            switch (text.charAt(i)) {
                case ';':
                case ',':
                case ']':
                case '}':
                case '"':
                case '\'':
                case '\\':
                case '\n':
                case '\r':
                    return i;
                default:
                    break;
            }
        }
        return text.length();
    }

    private static boolean isCookieSegment(String raw) {
        String seg = raw.trim();
        if (seg.startsWith("[")) seg = seg.substring(1).trim();
        if (seg.isEmpty()) return false;
        int eq = seg.indexOf('=');
        if (eq < 0) return COOKIE_ATTRS.contains(seg.toLowerCase(Locale.US));
        return seg.substring(0, eq).matches("[A-Za-z0-9_.\\-]{1,64}");
    }

    private static String redactOpaque(String text) {
        Matcher m = OPAQUE_VALUE.matcher(text);
        if (!m.find()) return text;
        StringBuilder sb = new StringBuilder(text.length());
        int last = 0;
        do {
            String key = m.group(1).toLowerCase(Locale.US);
            if (DIAGNOSTIC_KEYS.contains(key)) continue;
            sb.append(text, last, m.start()).append(m.group(1)).append('=').append(MASK);
            last = m.end();
        } while (m.find());
        sb.append(text, last, text.length());
        return sb.toString();
    }

    /**
     * 按行脱敏的输出包装：只有攒到换行才落笔，保证跨 chunk 的行也能完整脱敏
     * （tombstone 与崩溃栈是 8192 字符一块读出来的，逐块打码会把行中间切断）。
     */
    public static final class RedactingWriter extends Writer {

        private final Writer delegate;
        private final StringBuilder pending = new StringBuilder(8192);
        private boolean closed;

        public RedactingWriter(Writer delegate) {
            this.delegate = delegate;
        }

        @Override
        public synchronized void write(char[] buf, int off, int len) throws IOException {
            if (closed) throw new IOException("writer already closed");
            int lineStart = off;
            for (int i = off; i < off + len; i++) {
                if (buf[i] != '\n') continue;
                pending.append(buf, lineStart, i - lineStart);
                flushLine();
                lineStart = i + 1;
            }
            if (lineStart < off + len) pending.append(buf, lineStart, off + len - lineStart);
        }

        @Override
        public synchronized void write(String str, int off, int len) throws IOException {
            write(str.substring(off, off + len).toCharArray(), 0, len);
        }

        @Override
        public synchronized void write(int oneChar) throws IOException {
            char[] single = new char[] { (char) oneChar };
            write(single, 0, 1);
        }

        /** 行尾换行符已到达：整行脱敏后交给下游 */
        private void flushLine() throws IOException {
            delegate.write(redact(pending.toString()));
            delegate.write("\n");
            pending.setLength(0);
        }

        @Override
        public synchronized void flush() throws IOException {
            if (pending.length() > 0) {
                delegate.write(redact(pending.toString()));
                pending.setLength(0);
            }
            delegate.flush();
        }

        @Override
        public synchronized void close() throws IOException {
            if (closed) return;
            try {
                flush();
            } finally {
                closed = true;
                delegate.close();
            }
        }
    }
}
