package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.StringWriter;
import org.junit.Test;

/**
 * 日志脱敏单测（P2-3）。
 *
 * 用例的<b>形态</b>取自真机导出日志（响应头 map 里的 set-cookie、{@code QuarkPan.get … headers:{Cookie=…}}、
 * {@code Ali init token:<html>…}、{@code AliYun.init constructor cache:{…}}），值全部是假的。
 * 两个方向都要钉死：
 * 1) 该打码的一个不漏——分享出去的日志不能带网盘 cookie、会话 id、手机号；
 * 2) 不该动的一律不动——同一条日志里的 {@code Accept}／{@code Max-Age}／{@code md5}／HTML 响应体
 *    是定位源站问题的主要材料，被顺手盖掉就等于自废武功（这一类断言是真跑过导出日志后补的）。
 */
public class LogRedactorTest {

    /** 假的会话值，长度与形态同真实值 */
    private static final String HEX32 = "976a898f36eeae07e3070ae5be425c35";
    private static final String FAKE_PUS = "abcdef1234567890abcdef1234567890";
    private static final String FAKE_PUUS = "0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef";

    @Test
    public void cookiePairsMaskedByValueWithNamesKept() {
        String line = "QuarkPan.get url:https://drive.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc"
                + " headers:{Cookie=__pus=" + FAKE_PUS + "; __puus=" + FAKE_PUUS
                + ", Accept=application/json, User-Agent=quark-cloud-drive/2.5.20}";
        String out = LogRedactor.redact(line);
        assertFalse(out.contains(FAKE_PUS));
        assertFalse(out.contains(FAKE_PUUS));
        assertTrue("每个 cookie 各自打码，键名留着才看得出带过哪些会话键",
                out.contains("__pus=***") && out.contains("__puus=***"));
        assertTrue("值区之外的请求头不受影响",
                out.contains("Accept=application/json") && out.contains("User-Agent=quark-cloud-drive/2.5.20"));
        assertTrue("主机名与路径不参与脱敏", out.contains("https://drive.quark.cn/1/clouddrive/member"));
    }

    @Test
    public void setCookieHeaderMapKeepsAttributesAndCatchesStraySessionKey() {
        // 真机原样：响应头 map 里 set-cookie 是 `[名=值; 属性, 名=值; 属性]`，
        // 写入规则当年只盖了第一段，第二段 server_session_* 一直裸留在导出文件里。
        String line = "响应--> {date=[Mon, 16 Nov 2026 16:01:42 GMT], server=[nginx], "
                + "set-cookie=[demo_sid=" + FAKE_PUS + "; path=/, server_session_4e4bb913=" + HEX32
                + "; Max-Age=864000; httponly; path=/], expires=[Thu, 19 Nov 1981 08:52:00 GMT], "
                + "content-type=[text/html; charset=utf-8]}";
        String out = LogRedactor.redact(line);
        assertFalse(out.contains(FAKE_PUS));
        assertFalse("第一段由 cookie 规则盖掉", out.contains("demo_sid=" + FAKE_PUS));
        assertTrue(out.contains("server_session_4e4bb913=***"));
        assertTrue("cookie 属性照旧可读", out.contains("path=/") && out.contains("Max-Age=864000"));
        assertTrue("同一条日志里后续响应头照旧可读", out.contains("content-type=[text/html; charset=utf-8]"));
    }

    @Test
    public void emptySetCookieFollowedByOtherHeadersIsLeftAlone() {
        String line = "响应--> {server=[TencentEdgeOne], set-cookie="
                + "[; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; HttpOnly, "
                + "nel=[{\"max_age\":604800}], content-type=[text/html]}";
        assertEquals("空 cookie 没有可泄露的东西，一个字符都不该动", line, LogRedactor.redact(line));
    }

    @Test
    public void bareCookieTokenIsMaskedWholesale() {
        String line = "QuarkPan.setCookie set new Cookie:" + HEX32 + "abc";
        String out = LogRedactor.redact(line);
        assertFalse(out.contains(HEX32));
        assertTrue("没有 `名=值` 结构可留时，整段盖掉", out.startsWith("QuarkPan.setCookie set new Cookie:***"));
    }

    @Test
    public void htmlBodyAfterTokenKeyStaysReadable() {
        // 真机形态：接口 404，爬虫把整页 HTML 当成了 token 的值。
        // `<` 起头不是凭据形态，整行原样保留才对——旧规则会从中间咬断，只剩半句 Not Found。
        String line = "Ali init token:<html><head><title>404 Not Found</title></head>"
                + "<body><center><h1>404 Not Found</h1></center></body></html>";
        assertEquals(line, LogRedactor.redact(line));
    }

    @Test
    public void longOpaqueValueWithoutKnownKeyIsMasked() {
        String line = "预热完成 server_session_4e4bb913=" + FAKE_PUS + " 用时 12ms";
        String out = LogRedactor.redact(line);
        assertFalse(out.contains(FAKE_PUS));
        assertTrue(out.contains("server_session_4e4bb913=***"));
    }

    @Test
    public void plainAndEscapedJsonBothHit() {
        String plain = "AliYun.init constructor cache:{\"oauth\":{\"access_token\":\"" + FAKE_PUS
                + "\",\"nickname\":\"张三\",\"mobile\":\"13800000000\"}}";
        String out = LogRedactor.redact(plain);
        assertFalse(out.contains(FAKE_PUS));
        assertFalse("个人身份同样要盖", out.contains("张三") || out.contains("13800000000"));
        assertTrue("键名与 JSON 结构保持可读", out.contains("\"access_token\":\"***\""));

        String escaped = "写入配置 --> {\\\"token\\\":\\\"" + FAKE_JWT + "\\\",\\\"jar\\\":\\\"ok\\\"}";
        String escapedOut = LogRedactor.redact(escaped);
        assertFalse(escapedOut.contains(FAKE_JWT));
        assertTrue("同一条响应体里的非敏感字段不动", escapedOut.contains("jar"));
    }

    @Test
    public void emptyCredentialsInConfigAreNotRewritten() {
        String line = "115 config:{\"pan115_cookie" + "\":\"\",\"aliproxy\":\"\","
                + "\"proxy\":\"socks5://127.0.0.1:10172\"}";
        assertEquals("空值没有可泄露的东西，别把配置改花", line, LogRedactor.redact(line));
    }

    @Test
    public void bearerSchemeSurvivesButTokenGoes() {
        assertEquals("Authorization: Bearer ***", LogRedactor.redact("Authorization: Bearer " + FAKE_JWT));
        assertEquals("Authorization=***", LogRedactor.redact("Authorization=" + FAKE_PUS));
        assertTrue(LogRedactor.redact("proxy-authorization: basic YWJjZGVmMTIzNDU2").contains("basic ***"));
    }

    @Test
    public void signedPlaybackUrlKeepsHostAndExpiryMasksSignature() {
        String url = "播放地址--> http://nxytv.example.com/m3u8?path=/a/b.m3u8&sign="
                + FAKE_PUS + "&t=1763000000&wsSession=" + FAKE_JWT;
        String out = LogRedactor.redact(url);
        assertFalse(out.contains(FAKE_PUS));
        assertTrue("时间戳这类短数值留着才排得出直链过期", out.contains("t=1763000000"));
        assertTrue("路径照旧可读", out.contains("path=/a/b.m3u8") && out.contains("http://nxytv.example.com/m3u8"));
        assertTrue(out.contains("sign=***"));
    }

    @Test
    public void diagnosticHashesAndCountersAreUntouched() {
        String line = "jar 校验 md5=" + HEX32 + " expected=" + FAKE_PUS + " actual=" + HEX32
                + " size=356241 status=200 level=4";
        assertEquals(line, LogRedactor.redact(line));
    }

    @Test
    public void ordinaryLinesPassThroughByteForByte() {
        String line = "2026-11-18 21:03:11.204 D [spider-worker] CatVodSpider: 搜索完成 关键词=电影 命中 42 条 用时 1834ms";
        assertEquals(line, LogRedactor.redact(line));
    }

    @Test
    public void redactionIsIdempotent() {
        String line = "headers:{Cookie=__pus=" + FAKE_PUS + ", Accept=*/*} token=" + FAKE_JWT;
        String once = LogRedactor.redact(line);
        assertEquals(once, LogRedactor.redact(once));
    }

    @Test
    public void crashStackUrlParamsAreMaskedFramesStay() {
        String stack = "java.lang.RuntimeException: load failed: http://x.example.com/api?token="
                + FAKE_PUS + "\n\tat com.qoder.cinema.SpiderPlugin.play(Native Method)";
        String out = LogRedactor.redact(stack);
        assertFalse(out.contains(FAKE_PUS));
        assertTrue(out.contains("at com.qoder.cinema.SpiderPlugin.play"));
    }

    @Test
    public void writerRedactsLinesSplitAcrossChunks() throws Exception {
        String line = "headers:{Cookie=__pus=" + FAKE_PUS + "}";
        StringWriter sink = new StringWriter();
        LogRedactor.RedactingWriter writer = new LogRedactor.RedactingWriter(sink);
        char[] chars = (line + "\n").toCharArray();
        // 故意每次只喂 7 个字符：任何一块都不足以让正则认出完整的键值
        for (int i = 0; i < chars.length; i += 7) {
            writer.write(chars, i, Math.min(7, chars.length - i));
        }
        writer.close();
        String out = sink.toString();
        assertFalse(out.contains(FAKE_PUS));
        assertTrue(out.contains("__pus=***"));
        assertTrue("换行必须补回来，否则导出文件糊成一行", out.endsWith("\n"));
    }

    @Test
    public void trailingLineWithoutNewlineIsStillFlushed() throws Exception {
        StringWriter sink = new StringWriter();
        LogRedactor.RedactingWriter writer = new LogRedactor.RedactingWriter(sink);
        writer.write("set-cookie=" + "abcdefghijklmn0123456789");
        writer.close();
        assertEquals("set-cookie=***", sink.toString());
    }
}
