package com.qoder.cinema;

import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.community.keepawake.KeepAwakePlugin;

/**
 * App 入口 Activity。
 *
 * `CastShare` 是本工程内的自建插件（源码在 `app/src/main/java`），
 * Capacitor CLI 生成 `assets/capacitor.plugins.json` 时只扫描 npm 插件包，
 * 不会登记它，因此必须在 `super.onCreate()` **之前**手动注册：
 * BridgeActivity.onCreate 里会 `bridgeBuilder.create()` 冻结插件列表，
 * 之后再调用 `registerPlugin` 不会生效（REV-21）。
 *
 * startActivity 守卫：jar 爬虫（ftyguard 系列）会层层解包 ContextWrapper
 * 拿到本 Activity 再直调 startActivity 拉起系统设置页申请权限——
 * SpiderPlugin.GuardedSpiderContext（拦传入 context）与 MainApplication
 * （拦反射取 Application）都拦不到这条路径，必须在 Activity 层兜底。
 * 应用自身从不打开系统设置页，过滤 `android.settings.*` 是安全的。
 *
 * @author xyp
 */
public class MainActivity extends BridgeActivity {

    /** 开屏→首帧的交接时长（ms）：长了像卡住，短了像硬切 */
    private static final long SPLASH_HANDOFF_MS = 220L;

    /** 渲染进程崩溃后 recreate 时用于恢复崩溃前的 URL，避免回到空白页 */
    private static String pendingRestoreUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CastSharePlugin.class);
        registerPlugin(SpiderPlugin.class);
        registerPlugin(DrpyPlugin.class);
        registerPlugin(SnifferPlugin.class);
        registerPlugin(LocalProxyPlugin.class);
        // v1.8/CHG-25：ExoPlayer PoC 类自 v1.7 就存在但漏注册，接线后才暴露（插件桥 404）
        registerPlugin(ExoPlayerPlugin.class);
        // Phase 1：Native 下载器插件
        registerPlugin(DownloadPlugin.class);
        // EXT-04 / API-17：MediaTool（HLS→MP4 转封装）；本地插件不进 capacitor.plugins.json，
        // 必须在 super.onCreate() 之前注册，否则桥 404（REV-21）
        registerPlugin(MediaToolPlugin.class);
        // 网盘 cookie 写入/回读/登录页（src/native/netdiskPlugin.ts 调用；本地插件不会进 capacitor.plugins.json）
        registerPlugin(NetdiskPlugin.class);
        // AC-53：屏幕常亮插件（播放视频时防止熄屏）
        registerPlugin(KeepAwakePlugin.class);
        // 全屏播放时切换 edge-to-edge 沉浸模式（消除刘海留白竖条）
        registerPlugin(PlayerUiPlugin.class);
        // P2-2：提醒投递诊断 + 系统授权页入口（src/native/notificationScheduler.ts 调用）
        registerPlugin(ReminderPlugin.class);
        // S-01：core-splashscreen 依赖一直装着，但没人调 installSplashScreen()，于是
        // postSplashScreenTheme 从未生效——Activity 全程挂在开屏主题上，窗口背景成了开屏图层。
        // 必须在 super.onCreate() 之前安装（它会就地切换主题）。
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        // 首帧画好时由我们接手揭开开屏：只做 alpha+scale，与前端动效口径一致，避免硬切。
        splashScreen.setOnExitAnimationListener(provider -> {
            View icon = provider.getIconView();
            if (icon == null || animatorsDisabled()) {
                provider.remove();
                return;
            }
            icon.animate()
                    .alpha(0f)
                    .scaleX(1.06f)
                    .scaleY(1.06f)
                    .setDuration(SPLASH_HANDOFF_MS)
                    .withEndAction(provider::remove)
                    .start();
        });
        super.onCreate(savedInstanceState);

        // 默认 WebView 会按系统「字体大小」缩放文字，而设计 tokens 的 padding / 图标 / 高度是
        // 固定 px，放大后胶囊按钮里图标和文字会挤成一团，故锁定为 100%。
        getBridge().getWebView().getSettings().setTextZoom(100);

        // 华为 WebView 132 在特定场景（冷启动 + 程序化 focus）下渲染进程会 SIGSEGV，
        // Capacitor BridgeWebViewClient.onRenderProcessGone 默认返回 false → Activity 被
        // crashpad 以 SIGTRAP 终止（闪退）。注册 listener 返回 true 拦截默认行为，
        // 用 recreate 重建 WebView 进程，恢复崩溃前 URL。
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                pendingRestoreUrl = view.getUrl();
                Toast.makeText(
                    MainActivity.this,
                    "渲染进程异常，正在恢复…",
                    Toast.LENGTH_SHORT
                ).show();
                recreate();
                return true;
            }
        });

        // recreate 恢复：把崩溃前的 URL 回灌给 WebView
        if (pendingRestoreUrl != null) {
            final String url = pendingRestoreUrl;
            pendingRestoreUrl = null;
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
        }

        // B5：DEBUG 版原生崩溃测试入口（用于验证 tombstone 落盘）
        boolean isDebuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (isDebuggable && getIntent() != null && getIntent().getBooleanExtra("xcrash-test", false)) {
            android.util.Log.w("MainActivity", "xcrash-test triggered, crashing in 1s...");
            getBridge().getWebView().postDelayed(() -> {
                xcrash.XCrash.testNativeCrash(true);
            }, 1000);
        }
    }

    /** 系统把动画时长缩放关掉（无障碍/开发者选项）时不做交接动效，直接揭开 */
    private boolean animatorsDisabled() {
        return Settings.Global.getFloat(getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
    }

    @Override
    public void startActivity(Intent intent) {
        if (MainApplication.shouldBlockSettingsJump(intent)) return;
        super.startActivity(intent);
    }

    @Override
    public void startActivity(Intent intent, Bundle options) {
        if (MainApplication.shouldBlockSettingsJump(intent)) return;
        super.startActivity(intent, options);
    }

    @Override
    public void startActivityForResult(Intent intent, int requestCode) {
        if (MainApplication.shouldBlockSettingsJump(intent)) return;
        super.startActivityForResult(intent, requestCode);
    }

}
