package com.qoder.cinema;

import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * CastShare —— 首版"投屏/分享"的原生实现（技术方案 10.4）
 *
 * 首版不实现 Chromecast/DLNA 协议，仅用系统 ACTION_SEND 把当前播放内容投到
 * 电视 App / 播放器 App（用户侧的一次点击选择），这也是合规且最少依赖的方案。
 *
 * JS 契约（src/native/castPlugin.ts）：
 * - shareFile({ path, mime, title, text? })   → { started: boolean }
 * - shareUrl ({ url, title, mime? })          → { started: boolean }
 * - openExternal({ url })                      → { started: boolean }（磁力等外部 scheme）
 * - isSupported()                              → { supported: true }
 *
 * `path` 为 App Data 目录（getFilesDir()）下的相对路径；下载文件就落在那里。
 */
@CapacitorPlugin(name = "CastShare")
public class CastSharePlugin extends Plugin {

    private static final String TAG = "CastSharePlugin";
    private static final String FILE_PROVIDER_SUFFIX = ".fileprovider";

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        File file = new File(getContext().getFilesDir(), path);
        if (!file.exists()) {
            // 兼容传入绝对路径的场景
            File absolute = new File(path);
            if (absolute.exists()) {
                file = absolute;
            } else {
                Log.w(TAG, "file not found: " + path);
                call.reject("file not found: " + path);
                return;
            }
        }

        String mime = call.getString("mime", "video/*");
        String title = call.getString("title", file.getName());
        String text = call.getString("text", null);

        try {
            String authority = getContext().getPackageName() + FILE_PROVIDER_SUFFIX;
            Uri uri = FileProvider.getUriForFile(getContext(), authority, file);
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(mime);
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.putExtra(Intent.EXTRA_TITLE, title);
            if (text != null) {
                intent.putExtra(Intent.EXTRA_TEXT, text);
            }
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            getActivity().startActivity(Intent.createChooser(intent, title));
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "shareFile failed", e);
            call.reject("share failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (android.content.ActivityNotFoundException e) {
            // P1-4：设备上没有能处理 magnet:/xxx 的应用
            Log.w(TAG, "openExternal: no activity for " + url, e);
            call.reject("未安装可处理该链接的应用，请先安装下载器（如迅雷/qBittorrent）");
        } catch (Exception e) {
            Log.w(TAG, "openExternal failed", e);
            call.reject("打开失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void shareUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        String title = call.getString("title", "");
        String mime = call.getString("mime", "video/*");

        try {
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/plain".equals(mime) ? "text/plain" : "text/plain");
            intent.putExtra(Intent.EXTRA_SUBJECT, title);
            intent.putExtra(Intent.EXTRA_TEXT, url);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(Intent.createChooser(intent, title.isEmpty() ? url : title));
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "shareUrl failed", e);
            call.reject("share failed: " + e.getMessage());
        }
    }
}
