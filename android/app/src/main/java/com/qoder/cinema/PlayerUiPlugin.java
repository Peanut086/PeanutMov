package com.qoder.cinema;

import android.content.Context;
import android.media.AudioManager;
import android.os.Build;
import android.provider.Settings;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.CapacitorWebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 播放页窗口与系统能力控制。
 *
 * 两件事：
 * 1) 全屏沉浸。刘海屏机型横屏时系统会给窗口留出 displayCutout 安全边距（华为 Mate 50 Pro
 *    实测左侧 104px），WebView 被挤进剩余区域，窗口背景（浅色 AppCompat 主题 #FAFAFA）
 *    从左侧露出，表现为全屏后一条白色竖条。全屏期间关闭 decor 的系统栏适配并进入沉浸态，
 *    让 WebView（及原生 surface）铺满整块屏幕；退出时恢复，避免状态栏/刘海适配影响其它页面。
 * 2) 播放页手势直控亮度和音量（技术方案 API-12 的"二期"）。亮度走窗口属性
 *    {@code screenBrightness}：只影响本 App 窗口、不需要任何权限，退出播放交还系统值；
 *    音量走媒体流档位，与实体音量键是同一份状态，因此改完会留给其它 App（产品确认的语义）。
 */
@CapacitorPlugin(name = "PlayerUi")
public class PlayerUiPlugin extends Plugin {

    /** 进入沉浸前的刘海布局模式；-1 = 尚未记录 */
    private int savedCutoutMode = -1;

    /** 媒体流：实体音量键调的就是它，播放页手势与之保持一致 */
    private static final int VOLUME_STREAM = AudioManager.STREAM_MUSIC;

    /** 是否已用窗口属性覆盖屏幕背光；未覆盖时 clearWindowBrightness 无事可做 */
    private boolean brightnessOverridden = false;

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

    /* ---------- 亮度 / 音量（API-12 二期） ---------- */

    /** 一次性读取系统亮度与媒体音量，供播放页进入时做起点 */
    @PluginMethod
    public void getSystemLevels(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("brightnessRatio", readBrightnessRatio());
            ret.put("volumePercent", readVolumePercent());
            call.resolve(ret);
        });
    }

    /** 只读媒体音量：实体按键可能在本页不知情的情况下改动档位，手势按下前用它校准基准 */
    @PluginMethod
    public void getSystemVolume(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("volumePercent", readVolumePercent());
            call.resolve(ret);
        });
    }

    /** 设置本窗口背光 0~1（不影响系统设置，也不影响其它 App） */
    @PluginMethod
    public void setWindowBrightness(PluginCall call) {
        Double ratio = call.getDouble("ratio");
        if (ratio == null || !Double.isFinite(ratio)) {
            call.reject("ratio required");
            return;
        }
        float value = (float) Math.max(0d, Math.min(1d, ratio));
        getBridge().executeOnMainThread(() -> {
            Window window = getActivity().getWindow();
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.screenBrightness = value;
            window.setAttributes(attrs);
            brightnessOverridden = true;
            call.resolve();
        });
    }

    /** 交还屏幕背光：窗口覆盖随播放页结束失效，系统设置（含自动亮度）重新接管 */
    @PluginMethod
    public void clearWindowBrightness(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (brightnessOverridden) {
                Window window = getActivity().getWindow();
                WindowManager.LayoutParams attrs = window.getAttributes();
                attrs.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                window.setAttributes(attrs);
                brightnessOverridden = false;
            }
            call.resolve();
        });
    }

    /**
     * 设置系统媒体音量，回传实际生效百分比。
     *
     * 档位是离散的（常见 0~25 档），前端传 37% 可能落到 40%；以读回值为准，
     * HUD 才不会显示一个和真实响度不符的数字。
     */
    @PluginMethod
    public void setSystemVolume(PluginCall call) {
        Double percent = call.getDouble("percent");
        if (percent == null || !Double.isFinite(percent)) {
            call.reject("percent required");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            AudioManager am = audioManager();
            int max = am == null ? 0 : am.getStreamMaxVolume(VOLUME_STREAM);
            if (max <= 0) {
                call.reject("媒体音量不可用");
                return;
            }
            int target = Math.round(clampPercent(percent) * max / 100f);
            try {
                // flags=0：不弹系统音量条，播放页自己画 HUD
                am.setStreamVolume(VOLUME_STREAM, target, 0);
            } catch (RuntimeException e) {
                call.reject("设置系统音量失败：" + e.getMessage());
                return;
            }
            JSObject ret = new JSObject();
            ret.put("volumePercent", readVolumePercent());
            call.resolve(ret);
        });
    }

    /**
     * 当前屏幕背光 0~1；-1 = 读不到。
     *
     * 说明：`Display#getBrightness()` 不在公开 SDK 里（android.jar 没有
     * {@code android.hardware.display.Display}，废弃的 {@code android.view.Display} 也没有亮度方法），
     * 反射又会被非白名单限制，所以只走两条公开路径：
     * 1) 本窗口已覆盖背光时以覆盖值为准——Settings 读到的是系统值，和画面实际亮度不符；
     * 2) 否则读 {@code Settings.System.SCREEN_BRIGHTNESS}（0~255，读不需要权限；
     *    自动亮度下部分 ROM 返回 -1，由调用方整体降级为遮罩方案）。
     */
    private float readBrightnessRatio() {
        float override = getActivity().getWindow().getAttributes().screenBrightness;
        if (override >= 0f) return Math.min(1f, override);
        try {
            int raw = Settings.System.getInt(
                    getActivity().getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
            if (raw > 0) return Math.min(1f, raw / 255f);
        } catch (Exception ignored) {
            // 读不到由调用方降级为遮罩方案
        }
        return -1f;
    }

    /** 当前媒体音量 0~100；-1 = 不可用（拿不到 AudioManager 或最大档位为 0） */
    private int readVolumePercent() {
        AudioManager am = audioManager();
        if (am == null) return -1;
        int max = am.getStreamMaxVolume(VOLUME_STREAM);
        if (max <= 0) return -1;
        return clampPercent(am.getStreamVolume(VOLUME_STREAM) * 100f / max);
    }

    private AudioManager audioManager() {
        return (AudioManager) getActivity().getSystemService(Context.AUDIO_SERVICE);
    }

    private static int clampPercent(double percent) {
        return (int) Math.max(0d, Math.min(100d, Math.round(percent)));
    }
}
