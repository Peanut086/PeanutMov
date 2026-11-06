package com.qoder.cinema;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * NetdiskPlugin —— 网盘账号登录与 cookie 持久化
 *
 * P0: 临时写文件入口（验证权限链路）
 * P1: 登录 WebView、校验、回读自检
 * P2: 多平台抽象
 * P3: 启动静默校验、过期提示、备份自愈
 */
@CapacitorPlugin(name = "Netdisk")
public class NetdiskPlugin extends Plugin {

    private static final String TAG = "NetdiskPlugin";
    private static final String TVBOX_DIR = "TVBox";

    /**
     * 检查是否拥有「所有文件访问」权限
     */
    @PluginMethod
    public void hasAllFilesAccess(PluginCall call) {
        boolean granted = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            granted = Environment.isExternalStorageManager();
        } else {
            // Android 10 及以下：检查 WRITE_EXTERNAL_STORAGE
            granted = getContext().checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    /**
     * 请求「所有文件访问」权限（跳转系统设置页）
     */
    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "Failed to launch settings", e);
                call.reject("无法打开设置页: " + e.getMessage());
            }
        } else {
            // Android 10 及以下：运行时权限请求（需配合 MainActivity 的 onRequestPermissionsResult）
            // 简化处理：直接 resolve，由前端检查 hasAllFilesAccess
            call.resolve();
        }
    }

    /**
     * P0 临时方法：写入 cookie 文件到 /sdcard/TVBox/<platform>_cookie.txt
     *
     * @param platform 平台名（quark/uc/123/tianyi/ali）
     * @param content  JSON 内容（无尾部换行）
     */
    @PluginMethod
    public void writeCookieFile(PluginCall call) {
        String platform = call.getString("platform");
        String content = call.getString("content");
        if (platform == null || content == null) {
            call.reject("缺少 platform 或 content 参数");
            return;
        }

        File dir = getTvBoxDir();
        if (dir == null) {
            call.reject("无法访问外部存储");
            return;
        }

        File file = new File(dir, platform + "_cookie.txt");
        try {
            // 原子写入：先写 tmp 再 rename
            File tmp = new File(dir, platform + "_cookie.txt.tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            try {
                fos.write(content.getBytes("UTF-8"));
                fos.flush();
            } finally {
                fos.close();
            }
            if (file.exists()) file.delete();
            if (!tmp.renameTo(file)) {
                tmp.delete();
                call.reject("重命名失败");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("path", file.getAbsolutePath());
            call.resolve(ret);
        } catch (IOException e) {
            Log.e(TAG, "Failed to write cookie file", e);
            call.reject("写入失败: " + e.getMessage());
        }
    }

    /**
     * 读取 cookie 文件（用于回读自检）
     */
    @PluginMethod
    public void readCookieFile(PluginCall call) {
        String platform = call.getString("platform");
        if (platform == null) {
            call.reject("缺少 platform 参数");
            return;
        }

        File dir = getTvBoxDir();
        if (dir == null) {
            call.reject("无法访问外部存储");
            return;
        }

        File file = new File(dir, platform + "_cookie.txt");
        if (!file.exists()) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("exists", false);
            call.resolve(ret);
            return;
        }

        try {
            FileInputStream fis = new FileInputStream(file);
            byte[] bytes = new byte[(int) file.length()];
            try {
                fis.read(bytes);
            } finally {
                fis.close();
            }
            String content = new String(bytes, "UTF-8");
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("exists", true);
            ret.put("content", content);
            ret.put("path", file.getAbsolutePath());
            call.resolve(ret);
        } catch (IOException e) {
            Log.e(TAG, "Failed to read cookie file", e);
            call.reject("读取失败: " + e.getMessage());
        }
    }

    /**
     * 启动登录页（P1）
     *
     * DEV-04 / AND-06 / AND-07：改为等待登录页返回结果，
     * 返回 { success, verified, nickname, memberType, note }。
     * - success=false：用户取消或登录校验失败（未写 cookie 文件）
     * - verified=false：cookie 已保存但账号信息未验证（夸克以外平台）
     *
     * @param platform 平台名（quark/uc/123/tianyi/ali）
     * @param loginUrl 登录 URL
     */
    @PluginMethod
    public void loginWebView(PluginCall call) {
        String platform = call.getString("platform");
        String loginUrl = call.getString("loginUrl");
        if (platform == null || loginUrl == null) {
            call.reject("缺少 platform 或 loginUrl 参数");
            return;
        }

        Intent intent = new Intent(getContext(), NetdiskLoginActivity.class);
        intent.putExtra("platform", platform);
        intent.putExtra("loginUrl", loginUrl);
        startActivityForResult(call, intent, "handleLoginResult");
    }

    /**
     * 登录页结果回调（AND-06/07）。
     *
     * 登录页内部已完成 cookie 抓取、响应体校验与落盘；这里只做结果透传，
     * 不写文件、不判定成功。RESULT_CANCELED 时不会存在新的 cookie 文件。
     */
    @ActivityCallback
    private void handleLoginResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            Log.w(TAG, "Login result callback without pending call");
            return;
        }

        JSObject ret = new JSObject();
        ret.put("success", result.getResultCode() == android.app.Activity.RESULT_OK);

        Intent data = result.getData();
        if (data != null) {
            ret.put("platform", data.getStringExtra("platform"));
            ret.put("verified", data.getBooleanExtra("verified", false));
            ret.put("nickname", data.getStringExtra("nickname"));
            ret.put("memberType", data.getStringExtra("memberType"));
            ret.put("note", data.getStringExtra("note"));
        } else {
            ret.put("verified", false);
        }

        call.resolve(ret);
    }

    /**
     * P3-3: 备份 cookie 文件到应用私有目录
     *
     * @param platform 平台名
     */
    @PluginMethod
    public void backupCookieFile(PluginCall call) {
        String platform = call.getString("platform");
        if (platform == null) {
            call.reject("缺少 platform 参数");
            return;
        }

        File tvBoxDir = getTvBoxDir();
        if (tvBoxDir == null) {
            call.reject("无法访问外部存储");
            return;
        }

        File source = new File(tvBoxDir, platform + "_cookie.txt");
        if (!source.exists()) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("exists", false);
            call.resolve(ret);
            return;
        }

        try {
            File backupDir = new File(getContext().getFilesDir(), "netdisk_backup");
            if (!backupDir.exists()) {
                backupDir.mkdirs();
            }
            File backup = new File(backupDir, platform + "_cookie.txt");

            FileInputStream fis = new FileInputStream(source);
            FileOutputStream fos = new FileOutputStream(backup);
            try {
                byte[] buffer = new byte[8192];
                int len;
                while ((len = fis.read(buffer)) != -1) {
                    fos.write(buffer, 0, len);
                }
            } finally {
                fis.close();
                fos.close();
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("path", backup.getAbsolutePath());
            call.resolve(ret);
        } catch (IOException e) {
            Log.e(TAG, "Failed to backup cookie file", e);
            call.reject("备份失败: " + e.getMessage());
        }
    }

    /**
     * P3-3: 从备份恢复 cookie 文件
     *
     * @param platform 平台名
     */
    @PluginMethod
    public void restoreCookieFile(PluginCall call) {
        String platform = call.getString("platform");
        if (platform == null) {
            call.reject("缺少 platform 参数");
            return;
        }

        File backupDir = new File(getContext().getFilesDir(), "netdisk_backup");
        File backup = new File(backupDir, platform + "_cookie.txt");
        if (!backup.exists()) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("exists", false);
            call.resolve(ret);
            return;
        }

        File tvBoxDir = getTvBoxDir();
        if (tvBoxDir == null) {
            call.reject("无法访问外部存储");
            return;
        }

        try {
            File target = new File(tvBoxDir, platform + "_cookie.txt");
            File tmp = new File(tvBoxDir, platform + "_cookie.txt.tmp");

            FileInputStream fis = new FileInputStream(backup);
            FileOutputStream fos = new FileOutputStream(tmp);
            try {
                byte[] buffer = new byte[8192];
                int len;
                while ((len = fis.read(buffer)) != -1) {
                    fos.write(buffer, 0, len);
                }
            } finally {
                fis.close();
                fos.close();
            }

            if (target.exists()) target.delete();
            if (!tmp.renameTo(target)) {
                tmp.delete();
                call.reject("恢复失败：重命名失败");
                return;
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("path", target.getAbsolutePath());
            call.resolve(ret);
        } catch (IOException e) {
            Log.e(TAG, "Failed to restore cookie file", e);
            call.reject("恢复失败: " + e.getMessage());
        }
    }

    /**
     * 获取 /sdcard/TVBox 目录（TVBox jar 爬虫约定路径）
     */
    private File getTvBoxDir() {
        try {
            File ext = Environment.getExternalStorageDirectory();
            if (ext == null) return null;
            File dir = new File(ext, TVBOX_DIR);
            if (!dir.exists()) {
                if (!dir.mkdirs()) {
                    Log.w(TAG, "Failed to create TVBox dir");
                    return null;
                }
            }
            return dir;
        } catch (Exception e) {
            Log.e(TAG, "Failed to get TVBox dir", e);
            return null;
        }
    }
}
