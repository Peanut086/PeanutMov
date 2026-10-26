package com.github.catvod.crawler;

import android.content.Context;

import okhttp3.Dns;

/**
 * TVBox 框架基类 stub。
 *
 * 第三方 jar 里的爬虫类都 `extends com.github.catvod.crawler.Spider` 并调用
 * 父类构造器/静态方法，因此本类必须存在且签名与 TVBox 完全一致，否则
 * `DexClassLoader` 加载爬虫类时会抛 `NoClassDefFoundError`。
 *
 * 本 stub 只提供基类契约，不实现任何行为；实际调用由 `SpiderPlugin` 反射完成。
 *
 * 注意：**静态方法缺失是运行期 `NoSuchMethodError`**（不是加载期 `NoClassDefFoundError`），
 * 表现为「爬虫加载成功、一调用就失败」。新版 jar（潇洒/饭太硬系）大量调用
 * `Spider.safeDns()` 给 okhttp 配 DNS，缺它会让几乎所有爬虫的
 * homeContent/categoryContent/searchContent 全军覆没。
 */
public class Spider {

    public Spider() {
    }

    /**
     * TVBox 的「安全 DNS」：优先系统 DNS，失败时回退到公共 DNS。
     * 爬虫在构造 OkHttpClient 时调用它，签名必须逐字节一致
     * （`()Lokhttp3/Dns;`），否则 jar 内的 invoke-static 会解析失败。
     */
    public static Dns safeDns() {
        return Dns.SYSTEM;
    }

    /**
     * TVBox 让爬虫取宿主 Activity（部分爬虫弹登录框/WebView 用）。
     * 本应用不把 Activity 交给第三方 jar，返回 null 让爬虫走降级分支。
     */
    public static android.app.Activity getActivity() {
        return null;
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
