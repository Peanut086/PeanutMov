package com.qoder.cinema;

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
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CastSharePlugin.class);
        registerPlugin(SpiderPlugin.class);
        registerPlugin(DrpyPlugin.class);
        registerPlugin(SnifferPlugin.class);
        registerPlugin(LocalProxyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
