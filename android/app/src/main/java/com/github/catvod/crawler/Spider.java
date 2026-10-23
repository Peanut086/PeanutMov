package com.github.catvod.crawler;

import android.content.Context;

/**
 * TVBox 框架基类 stub。
 *
 * 第三方 jar 里的爬虫类都 `extends com.github.catvod.crawler.Spider` 并调用
 * 父类构造器，因此本类必须存在且签名与 TVBox 完全一致，否则
 * `DexClassLoader` 加载爬虫类时会抛 `NoClassDefFoundError`。
 *
 * 本 stub 只提供基类契约，不实现任何行为；实际调用由 `SpiderPlugin` 反射完成。
 */
public class Spider {

    public Spider() {
    }

    public void init(Context context) {
    }

    public void init(Context context, String ext) {
    }

    public void initApi(SpiderApi api) {
    }

    public String homeContent(boolean filter) {
        return null;
    }

    public String homeVideoContent() {
        return null;
    }

    public String categoryContent(String tid, String pg, boolean filter, java.util.HashMap<String, String> extend) {
        return null;
    }

    public String detailContent(java.util.List<String> ids) {
        return null;
    }

    public String searchContent(String key, boolean quick) {
        return null;
    }

    public String playerContent(String flag, String id, java.util.List<String> vipFlags) {
        return null;
    }

    public boolean manualVideoCheck() {
        return false;
    }

    public boolean isVideoFormat(String url) {
        return false;
    }

    public Object[] proxy(java.util.Map<String, String> params) {
        return new Object[0];
    }

    public String action(String action) {
        return null;
    }
}
