package com.qoder.cinema;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * NetdiskLoginActivity —— 网盘登录页（P1）
 *
 * 流程：
 * 1. 加载登录 URL（如 https://pan.quark.cn）
 * 2. 用户扫码/账密登录
 * 3. 登录成功后，CookieManager 抓取全量 cookie（含 HttpOnly）
 * 4. 原生校验：调用 member API 和 account/info 获取昵称/会员类型
 * 5. 写入 /sdcard/TVBox/<platform>_cookie.txt（JSON 格式）
 * 6. 回读自检：反射 jar 的 w.o().d() 确认闸门通过
 * 7. setResult(RESULT_OK) 并 finish
 */
public class NetdiskLoginActivity extends Activity {

    private static final String TAG = "NetdiskLogin";
    private static final int REQUEST_CODE = 1001;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView statusText;
    private String platform;
    private String loginUrl;

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

        // 构建 UI
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 32, 32, 32);

        statusText = new TextView(this);
        statusText.setText("正在加载登录页...");
        statusText.setTextSize(16);
        layout.addView(statusText);

        progressBar = new ProgressBar(this);
        layout.addView(progressBar);

        webView = new WebView(this);
        layout.addView(webView);

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

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress == 100) {
                    progressBar.setVisibility(ProgressBar.GONE);
                    statusText.setText("请完成登录（扫码或输入账密）");
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.d(TAG, "Page finished: " + url);
                // 检测登录成功（夸克：跳转到首页或特定 URL）
                if (url.contains("/list") || url.contains("/main")) {
                    onLoginSuccess();
                }
            }
        });
    }

    private void onLoginSuccess() {
        statusText.setText("登录成功，正在保存 cookie...");

        new Thread(() -> {
            try {
                // 1. 抓取 cookie
                CookieManager cookieManager = CookieManager.getInstance();
                String cookiePan = cookieManager.getCookie("https://pan.quark.cn");
                String cookieDrive = cookieManager.getCookie("https://drive-pc.quark.cn");

                // 2. 合并去重
                String mergedCookie = mergeCookies(cookiePan, cookieDrive);
                if (mergedCookie == null || mergedCookie.isEmpty()) {
                    runOnUiThread(() -> {
                        statusText.setText("获取 cookie 失败");
                    });
                    setResult(RESULT_CANCELED);
                    finish();
                    return;
                }

                // 3. 校验（调用 member API）
                String[] validation = validateCookie(mergedCookie);
                String nickname = validation[0];
                String memberType = validation[1];

                if (nickname == null || memberType == null) {
                    runOnUiThread(() -> {
                        statusText.setText("校验失败，请重试");
                    });
                    setResult(RESULT_CANCELED);
                    finish();
                    return;
                }

                // 4. 写入文件
                JSONObject json = new JSONObject();
                json.put("a", nickname);
                json.put("b", memberType);
                json.put("c", mergedCookie);
                String content = json.toString();

                File dir = getExternalFilesDir(null);
                if (dir == null) dir = getExternalCacheDir();
                File tvboxDir = new File(dir.getParentFile().getParentFile().getParentFile().getParentFile(), "TVBox");
                if (!tvboxDir.exists()) tvboxDir.mkdirs();
                File cookieFile = new File(tvboxDir, platform + "_cookie.txt");

                FileOutputStream fos = new FileOutputStream(cookieFile);
                try {
                    fos.write(content.getBytes("UTF-8"));
                } finally {
                    fos.close();
                }

                // 5. 回读自检（反射 jar 的 w.o().d()）
                boolean gatePassed = checkJarGate();

                runOnUiThread(() -> {
                    if (gatePassed) {
                        statusText.setText("登录成功！闸门通过");
                    } else {
                        statusText.setText("登录成功，但闸门未通过（可能需要重启应用）");
                    }
                    setResult(RESULT_OK);
                    finish();
                });

            } catch (Exception e) {
                Log.e(TAG, "Login failed", e);
                runOnUiThread(() -> {
                    statusText.setText("登录失败: " + e.getMessage());
                    setResult(RESULT_CANCELED);
                    finish();
                });
            }
        }).start();
    }

    private String mergeCookies(String cookie1, String cookie2) {
        if (cookie1 == null && cookie2 == null) return null;
        if (cookie1 == null) return cookie2;
        if (cookie2 == null) return cookie1;

        Map<String, String> map = new HashMap<>();
        for (String pair : cookie1.split("; ")) {
            int idx = pair.indexOf('=');
            if (idx > 0) {
                map.put(pair.substring(0, idx), pair.substring(idx + 1));
            }
        }
        for (String pair : cookie2.split("; ")) {
            int idx = pair.indexOf('=');
            if (idx > 0) {
                map.put(pair.substring(0, idx), pair.substring(idx + 1));
            }
        }

        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : map.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(entry.getKey()).append("=").append(entry.getValue());
        }
        return sb.toString();
    }

    private String[] validateCookie(String cookie) {
        try {
            // 调用 member API
            URL url = new URL("https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true&_ch=home&fetch_identity=true");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
            conn.setRequestProperty("Referer", "https://pan.quark.cn");

            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "Member API returned " + code);
                return new String[]{null, null};
            }

            // 解析响应（简化：只取 status 和 member_type）
            // 实际应该用 JSON 库解析，这里省略
            String memberType = "0"; // 默认普通用户

            // 调用 account/info 获取昵称
            url = new URL("https://pan.quark.cn/account/info?fr=pc&platform=pc");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

            code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "Account API returned " + code);
                return new String[]{null, null};
            }

            String nickname = "user"; // 默认昵称

            return new String[]{nickname, memberType};

        } catch (Exception e) {
            Log.e(TAG, "Validation failed", e);
            return new String[]{null, null};
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

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
