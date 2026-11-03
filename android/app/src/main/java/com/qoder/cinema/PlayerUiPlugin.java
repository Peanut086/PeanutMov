package com.qoder.cinema;

import android.os.Build;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.CapacitorWebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 播放页全屏窗口控制。
 *
 * 刘海屏机型横屏时系统会给窗口留出 displayCutout 安全边距（华为 Mate 50 Pro 实测
 * 左侧 104px），WebView 被挤进剩余区域，窗口背景（浅色 AppCompat 主题 #FAFAFA）
 * 从左侧露出，表现为全屏后一条白色竖条。
 *
 * 全屏期间关闭 decor 的系统栏适配并进入沉浸态，让 WebView（及原生 surface）
 * 铺满整块屏幕；退出时恢复，避免状态栏/刘海适配影响其它页面。
 */
@CapacitorPlugin(name = "PlayerUi")
public class PlayerUiPlugin extends Plugin {

    /** 进入沉浸前的刘海布局模式；-1 = 尚未记录 */
    private int savedCutoutMode = -1;

    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean immersive = Boolean.TRUE.equals(call.getBoolean("immersive", false));
        getBridge().executeOnMainThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, window.getDecorView());
            if (immersive) {
                WindowCompat.setDecorFitsSystemWindows(window, false);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    WindowManager.LayoutParams attrs = window.getAttributes();
                    if (savedCutoutMode < 0) savedCutoutMode = attrs.layoutInDisplayCutoutMode;
                    attrs.layoutInDisplayCutoutMode =
                            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                    window.setAttributes(attrs);
                }
                controller.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsetsCompat.Type.systemBars());
                applyWebViewInsets(true);
            } else {
                applyWebViewInsets(false);
                WindowCompat.setDecorFitsSystemWindows(window, true);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && savedCutoutMode >= 0) {
                    WindowManager.LayoutParams attrs = window.getAttributes();
                    attrs.layoutInDisplayCutoutMode = savedCutoutMode;
                    window.setAttributes(attrs);
                    savedCutoutMode = -1;
                }
                controller.show(WindowInsetsCompat.Type.systemBars());
            }
            ViewCompat.requestApplyInsets(window.getDecorView());
            call.resolve();
        });
    }

    /**
     * Android 15+ Capacitor 的 adjustMarginsForEdgeToEdge:'auto' 会给 WebView 加
     * 系统栏/刘海边距；全屏时接管该监听清零，退出时交还给 Capacitor。
     */
    private void applyWebViewInsets(boolean immersive) {
        if (!(getBridge().getWebView() instanceof CapacitorWebView web)) return;
        if (immersive) {
            ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
                ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
                if (mlp.leftMargin != 0 || mlp.topMargin != 0 || mlp.rightMargin != 0 || mlp.bottomMargin != 0) {
                    mlp.setMargins(0, 0, 0, 0);
                    v.setLayoutParams(mlp);
                }
                return WindowInsetsCompat.CONSUMED;
            });
        } else {
            ViewCompat.setOnApplyWindowInsetsListener(web, null);
            web.edgeToEdgeHandler(getBridge());
        }
    }
}
