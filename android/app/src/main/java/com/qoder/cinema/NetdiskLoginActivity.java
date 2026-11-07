package com.qoder.cinema;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * NetdiskLoginActivity —— 网盘登录页（P1）
 *
 * 流程：
 * 1. 加载登录 URL（如 https://pan.quark.cn）
 * 2. 用户扫码/账密登录
 * 3. CookieManager 抓取平台对应域名的全量 cookie（含 HttpOnly）
 * 4. 平台驱动校验：
 *    - 夸克：调用 member/account 接口并解析响应体关键字段（status/code/data），
 *      校验不通过则绝不写 cookie 文件、绝不返回 RESULT_OK；
 *    - 其余平台：当前无账号接口（Q-03=A 只保证夸克），保存 Cookie 但如实标记
 *      verified=false，不伪造昵称/会员信息。
 * 5. 写入 /sdcard/TVBox/<platform>_cookie.txt（JSON：a=昵称，b=会员类型，c=cookie）
 * 6. 夸克额外做 jar 闸门自检（失败不阻断保存，仅记录日志）
 * 7. setResult(RESULT_OK, extras: platform/verified/nickname/memberType/note)
 *
 * DEV-04 / AND-06 / AND-07：
 * - 原实现用 `url.contains("/list") || url.contains("/main")` 硬编码夸克判定；
 *   现在只有平台配置（PlatformSpec）声明了自动跳转标记才自动校验，且必须是
 *   夸克域名；所有平台都提供“我已登录，保存 Cookie”手动入口。
 * - 原 validateCookie 只看 HTTP 200，昵称固定 "user"、会员类型固定 "0"，
 *   未登录也会“成功”；现在必须解析响应体的 status/code/data，任一关键字段
 *   不符合预期即判定失败，不写文件、不返回成功。
 */
public class NetdiskLoginActivity extends Activity {

    private static final String TAG = "NetdiskLogin";

    /** 返回结果扩展字段：供 NetdiskPlugin/前端后续读取（当前插件未消费） */
    private static final String EXTRA_PLATFORM = "platform";
    private static final String EXTRA_VERIFIED = "verified";
    private static final String EXTRA_NICKNAME = "nickname";
    private static final String EXTRA_MEMBER_TYPE = "memberType";
    private static final String EXTRA_NOTE = "note";

    private static final String QUARK_MEMBER_API =
            "https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str="
                    + "&fetch_subscribe=true&_ch=home&fetch_identity=true";
    private static final String QUARK_ACCOUNT_API =
            "https://pan.quark.cn/account/info?fr=pc&platform=pc";
    private static final String BROWSER_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    private static final int MAX_RESPONSE_CHARS = 64 * 1024;
    private static final int HTTP_TIMEOUT_MS = 10_000;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView statusText;
    private Button confirmButton;

    private String platform;
    private String loginUrl;
    private PlatformSpec spec;

    /** 校验中/保存中的互斥标记，避免自动检测与手动点击并发写文件 */
    private final AtomicBoolean validating = new AtomicBoolean(false);
    private volatile boolean saved = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent intent = getIntent();
        platform = intent.getStringExtra("platform");
        loginUrl = intent.getStringExtra("loginUrl");

        if (platform == null || loginUrl == null) {
            Log.e(TAG, "Missing platform or loginUrl");
            setResult(RESULT_CANCELED);
            finish();
            return;
        }

        spec = PlatformSpec.of(platform, loginUrl);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(16);
        layout.setPadding(padding, padding, padding, padding);

        statusText = new TextView(this);
        statusText.setTextSize(14);
        statusText.setText("正在加载登录页...");
        layout.addView(statusText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        progressBar = new ProgressBar(this);
        layout.addView(progressBar);

        confirmButton = new Button(this);
        confirmButton.setText("我已登录，保存 Cookie");
        confirmButton.setEnabled(false);
        confirmButton.setOnClickListener(v -> startValidation(false));
        layout.addView(confirmButton, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        layout.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(layout);

        setupWebView();
        webView.loadUrl(loginUrl);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 强制桌面 UA：移动 UA 会被官网重定向到「下载 App」落地页，无法登录
        settings.setUserAgentString(BROWSER_UA);
        // 宽视口 + 缩放：让桌面版页面在手机屏上可读可操作
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress == 100) {
                    progressBar.setVisibility(ProgressBar.GONE);
                    confirmButton.setEnabled(true);
                    if (!saved && !validating.get()) {
                        statusText.setText(spec.supportsAccountCheck
                                ? "请完成登录（扫码或输入账密）"
                                : "请完成登录，然后点击下方按钮保存 Cookie");
                    }
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.d(TAG, "Page finished: " + url);
                confirmButton.setEnabled(true);
                if (saved || validating.get()) return;
                if (spec.matchesAutoSuccess(url)) {
                    statusText.setText("检测到登录跳转，正在校验账号...");
                    startValidation(true);
                }
            }
        });
    }

    /**
     * 抓取 cookie → 平台校验 → 落盘 → 返回结果。
     *
     * @param automatic true=页面跳转自动触发；false=用户点击“我已登录”
     */
    private void startValidation(boolean automatic) {
        if (saved || !validating.compareAndSet(false, true)) return;

        runOnUiThread(() -> statusText.setText(
                automatic ? "检测到登录跳转，正在校验账号..." : "正在校验并保存 Cookie..."));

        // 在主线程获取 WebView URL（WebView 方法必须在主线程调用）
        final String currentUrl = webView.getUrl();

        new Thread(() -> {
            try {
                String cookie = collectCookies(currentUrl);
                if (cookie.isEmpty()) {
                    showMessage("未获取到 Cookie，请确认已登录后点击“我已登录，保存 Cookie”重试");
                    return;
                }

                AccountInfo info;
                if (spec.supportsAccountCheck) {
                    // AND-07：必须解析响应体关键字段，失败则终止（不写文件）
                    info = validateQuarkAccount(cookie);
                    if (!info.verified) {
                        showMessage("登录校验未通过：" + info.note
                                + "。请重新登录或点击“我已登录，保存 Cookie”重试");
                        return;
                    }
                } else {
                    // Q-03=A：其余平台无账号接口，如实标记未验证，不伪造昵称/会员
                    info = AccountInfo.unverified(
                            "该平台账号信息暂不支持校验，已按未验证保存");
                }

                if (!writeCookieFile(cookie, info.nickname, info.memberType)) {
                    showMessage("保存 Cookie 失败，请检查 /sdcard/TVBox 写入权限");
                    return;
                }

                if (spec.supportsAccountCheck) {
                    boolean gatePassed = checkJarGate();
                    if (!gatePassed) {
                        Log.w(TAG, "Jar gate check failed after login; cookie file saved anyway");
                    }
                }

                saved = true;
                showMessage(info.verified
                        ? "登录成功（账号：" + info.nickname + "）"
                        : "Cookie 已保存（账号信息未验证）");

                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    Intent data = new Intent();
                    data.putExtra(EXTRA_PLATFORM, platform);
                    data.putExtra(EXTRA_VERIFIED, info.verified);
                    data.putExtra(EXTRA_NICKNAME, info.nickname);
                    data.putExtra(EXTRA_MEMBER_TYPE, info.memberType);
                    data.putExtra(EXTRA_NOTE, info.note);
                    setResult(RESULT_OK, data);
                    finish();
                });
            } finally {
                validating.set(false);
            }
        }, "netdisk-login-validate").start();
    }

    /**
     * 从平台配置的域名集合抓取 cookie，按 name 去重合并。
     * CookieManager 会返回 HttpOnly cookie；这里只做拼接，不打印内容（敏感信息）。
     *
     * @param currentUrl 当前 WebView URL（已在主线程获取）
     */
    private String collectCookies(String currentUrl) {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.flush();

        // 合并配置域名 + 当前 WebView 实际所在域名（覆盖跨域登录跳转，如 123pan.com → yun.123pan.cn）
        java.util.Set<String> origins = new java.util.LinkedHashSet<>(spec.cookieOrigins);
        if (currentUrl != null) {
            try {
                origins.add(PlatformSpec.originOf(currentUrl));
            } catch (Exception ignored) {
            }
        }

        Map<String, String> merged = new LinkedHashMap<>();
        for (String origin : origins) {
            String raw = cookieManager.getCookie(origin);
            if (raw == null || raw.isEmpty()) continue;
            for (String pair : raw.split(";")) {
                String item = pair.trim();
                int idx = item.indexOf('=');
                if (idx <= 0) continue;
                String name = item.substring(0, idx).trim();
                String value = item.substring(idx + 1);
                if (!name.isEmpty()) merged.put(name, value);
            }
        }

        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : merged.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return sb.toString();
    }

    /**
     * AND-07：解析夸克 member / account 接口响应体。
     * HTTP 非 200、status!=200、code!=0、缺 data 任一情况即判定未登录。
     */
    private AccountInfo validateQuarkAccount(String cookie) {
        String memberBody = httpGet(spec.memberApi, cookie);
        if (memberBody == null) {
            return AccountInfo.failure("会员接口请求失败（网络异常或接口不可达）");
        }

        JSONObject member;
        try {
            member = new JSONObject(memberBody);
        } catch (JSONException e) {
            // 常见于未登录被重定向到 HTML 登录页
            return AccountInfo.failure("会员接口响应不是 JSON，登录状态无法确认");
        }

        int status = member.optInt("status", -1);
        boolean hasCode = member.has("code");
        int code = member.optInt("code", 0);
        if (status != 200 || (hasCode && code != 0)) {
            return AccountInfo.failure("未登录或登录已失效（status=" + status + ", code=" + code + "）");
        }

        JSONObject data = member.optJSONObject("data");
        if (data == null) {
            return AccountInfo.failure("会员接口缺少 data 字段，登录状态无法确认");
        }

        String memberType = stringValue(data.opt("member_type"), "0");
        String nickname = firstNonEmpty(data, "nickname", "nick_name", "user_name");

        if (nickname.isEmpty() && spec.accountApi != null) {
            String accountBody = httpGet(spec.accountApi, cookie);
            if (accountBody != null) {
                try {
                    JSONObject account = new JSONObject(accountBody);
                    if (account.optInt("status", -1) == 200) {
                        JSONObject accountData = account.optJSONObject("data");
                        if (accountData != null) {
                            nickname = firstNonEmpty(accountData, "nickname", "nick_name", "user_name");
                        }
                    }
                } catch (JSONException e) {
                    Log.w(TAG, "Account API returned non-JSON body");
                }
            }
        }

        if (nickname.isEmpty()) nickname = "未知账号";
        return new AccountInfo(true, nickname, memberType, "夸克账号校验通过");
    }

    private String httpGet(String api, String cookie) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(api).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("User-Agent", BROWSER_UA);
            conn.setRequestProperty("Referer", "https://pan.quark.cn");

            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "Account API returned HTTP " + code);
                return null;
            }

            InputStream input = conn.getInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
            StringBuilder body = new StringBuilder();
            char[] buffer = new char[4096];
            int len;
            while ((len = reader.read(buffer)) != -1 && body.length() < MAX_RESPONSE_CHARS) {
                body.append(buffer, 0, len);
            }
            reader.close();
            return body.toString();
        } catch (IOException e) {
            Log.w(TAG, "Account API request failed: " + e.getClass().getSimpleName());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private boolean writeCookieFile(String cookie, String nickname, String memberType) {
        File dir = new File(Environment.getExternalStorageDirectory(), "TVBox");
        if (!dir.exists() && !dir.mkdirs()) {
            Log.e(TAG, "Cannot create TVBox directory");
            return false;
        }

        File target = new File(dir, platform + "_cookie.txt");
        File tmp = new File(dir, target.getName() + ".tmp");
        FileOutputStream fos = null;
        try {
            JSONObject json = new JSONObject();
            json.put("a", nickname == null ? "" : nickname);
            json.put("b", memberType == null ? "0" : memberType);
            json.put("c", cookie);

            fos = new FileOutputStream(tmp);
            fos.write(json.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.close();
            fos = null;

            if (tmp.renameTo(target)) return true;
            // 部分文件系统不允许覆盖已存在文件：删除后重试一次
            if (target.exists() && target.delete() && tmp.renameTo(target)) return true;

            Log.e(TAG, "Failed to move cookie tmp file into place");
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Failed to write cookie file", e);
            return false;
        } finally {
            if (fos != null) {
                try {
                    fos.close();
                } catch (IOException ignored) {
                    // ignore
                }
            }
            if (tmp.exists()) tmp.delete();
        }
    }

    private boolean checkJarGate() {
        try {
            // 反射调用 merge.b.w.e().o().d()
            Class<?> wClass = Class.forName("com.github.catvod.spider.merge.b.w");
            Method eMethod = wClass.getMethod("e");
            Object wInstance = eMethod.invoke(null);

            Method oMethod = wClass.getMethod("o");
            Object account = oMethod.invoke(wInstance);

            Method dMethod = account.getClass().getMethod("d");
            Boolean result = (Boolean) dMethod.invoke(account);

            return result != null && result;
        } catch (Exception e) {
            Log.w(TAG, "Gate check failed (jar may not be loaded yet)", e);
            return false;
        }
    }

    private void showMessage(String message) {
        runOnUiThread(() -> {
            if (!isFinishing()) statusText.setText(message);
        });
    }

    private static String firstNonEmpty(JSONObject obj, String... keys) {
        for (String key : keys) {
            String value = obj.optString(key, "");
            if (value == null) continue;
            value = value.trim();
            // Android org.json 对 JSON null 会返回字符串 "null"
            if (!value.isEmpty() && !"null".equals(value)) return value;
        }
        return "";
    }

    private static String stringValue(Object raw, String fallback) {
        if (raw == null || raw == JSONObject.NULL) return fallback;
        String value = String.valueOf(raw);
        return value.isEmpty() ? fallback : value;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ========== 平台配置 ==========

    /**
     * 平台驱动的登录判定配置。
     *
     * 注意：夸克部分与 `src/services/netdiskPlatforms.ts` 保持一致（cookie 域名、
     * member/account 接口）。其余平台在 TS 侧同样没有接口定义（TODO），因此这里
     * 只做 cookie 抓取，不猜测账号状态。
     */
    private static class PlatformSpec {
        final String platform;
        final List<String> cookieOrigins;
        final boolean supportsAccountCheck;
        /** null 表示不做自动跳转判定，只能手动点击保存 */
        final String[] autoSuccessMarkers;
        final String memberApi;
        final String accountApi;

        private PlatformSpec(String platform, List<String> cookieOrigins,
                             boolean supportsAccountCheck, String[] autoSuccessMarkers,
                             String memberApi, String accountApi) {
            this.platform = platform;
            this.cookieOrigins = cookieOrigins;
            this.supportsAccountCheck = supportsAccountCheck;
            this.autoSuccessMarkers = autoSuccessMarkers;
            this.memberApi = memberApi;
            this.accountApi = accountApi;
        }

        static PlatformSpec of(String platform, String loginUrl) {
            String key = platform == null ? "" : platform.toLowerCase(Locale.ROOT);
            if ("quark".equals(key)) {
                return new PlatformSpec(
                        platform,
                        Arrays.asList("https://pan.quark.cn", "https://drive-pc.quark.cn"),
                        true,
                        new String[]{"/list", "/main"},
                        QUARK_MEMBER_API,
                        QUARK_ACCOUNT_API);
            }
            // UC / 123 / 天翼 / 阿里：无账号校验接口，手动保存且标记未验证
            return new PlatformSpec(
                    platform,
                    Collections.singletonList(originOf(loginUrl)),
                    false,
                    null,
                    null,
                    null);
        }

        boolean matchesAutoSuccess(String url) {
            if (autoSuccessMarkers == null || url == null) return false;
            if (!isQuarkHost(url)) return false;
            for (String marker : autoSuccessMarkers) {
                if (url.contains(marker)) return true;
            }
            return false;
        }

        private static boolean isQuarkHost(String url) {
            try {
                String host = new URL(url).getHost();
                if (host == null) return false;
                host = host.toLowerCase(Locale.ROOT);
                return host.equals("quark.cn") || host.endsWith(".quark.cn");
            } catch (MalformedURLException e) {
                return false;
            }
        }

        private static String originOf(String loginUrl) {
            try {
                URL url = new URL(loginUrl);
                String scheme = url.getProtocol();
                String host = url.getHost();
                if (scheme == null || host == null) return loginUrl;
                int port = url.getPort();
                return port > 0 ? scheme + "://" + host + ":" + port : scheme + "://" + host;
            } catch (MalformedURLException e) {
                return loginUrl;
            }
        }
    }

    // ========== 账号信息 ==========

    private static class AccountInfo {
        final boolean verified;
        final String nickname;
        final String memberType;
        final String note;

        private AccountInfo(boolean verified, String nickname, String memberType, String note) {
            this.verified = verified;
            this.nickname = nickname;
            this.memberType = memberType;
            this.note = note;
        }

        static AccountInfo failure(String note) {
            return new AccountInfo(false, "", "0", note);
        }

        static AccountInfo unverified(String note) {
            return new AccountInfo(false, "", "0", note);
        }
    }
}
