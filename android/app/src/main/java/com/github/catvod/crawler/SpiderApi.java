package com.github.catvod.crawler;

/**
 * TVBox 框架 `SpiderApi` stub。
 *
 * 爬虫通过它回填运行环境信息（本地代理地址、端口）并输出日志。
 * `SpiderPlugin` 持有唯一实例，在 `initApi` 时注入爬虫。
 */
public class SpiderApi {

    private static volatile SpiderApi instance;

    private String address = "127.0.0.1";
    private String port = "0";
    private SpiderDebug debug = new SpiderDebug();

    public static SpiderApi get() {
        if (instance == null) {
            synchronized (SpiderApi.class) {
                if (instance == null) instance = new SpiderApi();
            }
        }
        return instance;
    }

    /** 本地代理地址（TVBox 用它给爬虫拼 proxy 流地址） */
    public String getAddress() {
        return address;
    }

    /**
     * TVBox 的 `getAddress(boolean)`：部分爬虫据此决定要不要走本地代理。
     * 本应用没有本地代理服务，一律返回直连地址。
     */
    public String getAddress(boolean proxy) {
        return address;
    }

    public String getPort() {
        return port;
    }

    /**
     * 批量请求（TVBox 用它一次拉多个 URL 做并发探测）。
     * 未实现：返回空数组 JSON，让爬虫走单请求降级。
     */
    public String multiReq(com.google.gson.JsonArray urls) {
        log("multiReq not supported, fallback to single request");
        return "[]";
    }

    /** 爬虫日志：桥接到 Android logcat，由 JS 侧按需读取 */
    public void log(String msg) {
        debug.log(msg);
    }

    /** 爬虫要求 WebView 嗅探时调用；首版不支持，返回空串让爬虫走降级 */
    public String webParse(String html, String url) {
        log("webParse not supported: " + url);
        return "";
    }

    public SpiderDebug getDebug() {
        return debug;
    }
}
