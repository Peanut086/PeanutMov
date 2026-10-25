package com.qoder.cinema;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

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
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CastSharePlugin.class);
        registerPlugin(SpiderPlugin.class);
        registerPlugin(DrpyPlugin.class);
        registerPlugin(SnifferPlugin.class);
        registerPlugin(LocalProxyPlugin.class);
        // v1.8/CHG-25：ExoPlayer PoC 类自 v1.7 就存在但漏注册，接线后才暴露（插件桥 404）
        registerPlugin(ExoPlayerPlugin.class);
        super.onCreate(savedInstanceState);
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
