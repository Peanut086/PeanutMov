package com.qoder.cinema;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String TAG = "AppUpdatePlugin";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    @PluginMethod
    public void getCurrentVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("versionName", info.versionName);
            result.put("versionCode", info.getLongVersionCode());
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("读取当前应用版本失败", error);
        }
    }

    @PluginMethod
    public void canInstallPackages(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(result);
    }

    @PluginMethod
    public void openUnknownSourcesSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:" + getContext().getPackageName()))
                .putExtra(MainApplication.EXTRA_OWN_SETTINGS_JUMP, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException error) {
            AppLog.w(TAG, "unknown sources settings unavailable", error);
            call.reject("系统未提供安装未知应用设置页");
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String relativePath = call.getString("path");
        String expectedSha256 = call.getString("sha256");
        long expectedVersionCode = call.getData().optLong("versionCode", -1L);
        if (relativePath == null || relativePath.trim().isEmpty()
                || expectedSha256 == null || expectedVersionCode <= 0L) {
            call.reject("APK_PATH_SHA256_VERSION_REQUIRED");
            return;
        }

        try {
            File apk = resolveApk(relativePath);
            verifyApk(apk, expectedSha256, expectedVersionCode);
            if (!getContext().getPackageManager().canRequestPackageInstalls()) {
                call.reject("INSTALL_PERMISSION_REQUIRED");
                return;
            }

            Uri uri = FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, APK_MIME)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Activity activity = getActivity();
            if (activity != null) {
                activity.startActivity(intent);
            } else {
                getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }

            JSObject result = new JSObject();
            result.put("started", true);
            call.resolve(result);
        } catch (UpdateException error) {
            call.reject(error.code + ": " + error.getMessage());
        } catch (ActivityNotFoundException error) {
            AppLog.w(TAG, "package installer unavailable", error);
            call.reject("系统未提供可用的安装器");
        } catch (Exception error) {
            AppLog.w(TAG, "APK verification or install failed", error);
            call.reject("APK_VERIFY_OR_INSTALL_FAILED: " + error.getMessage());
        }
    }

    private File resolveApk(String relativePath) throws UpdateException {
        try {
            File root = getContext().getFilesDir().getCanonicalFile();
            File target = new File(root, relativePath).getCanonicalFile();
            if (!target.toPath().startsWith(root.toPath())
                    || !target.isFile()
                    || !target.getName().endsWith(".apk")) {
                throw new UpdateException("INVALID_APK_PATH", "APK 必须位于应用私有目录");
            }
            return target;
        } catch (UpdateException error) {
            throw error;
        } catch (Exception error) {
            throw new UpdateException("INVALID_APK_PATH", "APK 路径无效");
        }
    }

    private void verifyApk(File apk, String expectedSha256, long expectedVersionCode) throws UpdateException {
        final byte[] expectedHash;
        try {
            expectedHash = hexToBytes(expectedSha256);
        } catch (IllegalArgumentException error) {
            throw new UpdateException("INVALID_APK_SHA256", "更新清单中的 SHA256 无效");
        }

        try {
            byte[] actualHash = sha256(apk);
            if (!MessageDigest.isEqual(expectedHash, actualHash)) {
                throw new UpdateException("APK_HASH_MISMATCH", "下载文件校验失败，请重新下载");
            }
        } catch (UpdateException error) {
            throw error;
        } catch (Exception error) {
            throw new UpdateException("APK_HASH_FAILED", "无法校验下载文件");
        }

        PackageManager packageManager = getContext().getPackageManager();
        PackageInfo archive = packageManager.getPackageArchiveInfo(
                apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (archive == null || archive.packageName == null) {
            throw new UpdateException("INVALID_APK", "下载文件不是有效的 APK");
        }
        if (!getContext().getPackageName().equals(archive.packageName)) {
            throw new UpdateException("APK_PACKAGE_MISMATCH", "更新包与当前应用不匹配");
        }
        if (archive.getLongVersionCode() != expectedVersionCode) {
            throw new UpdateException("APK_VERSION_MISMATCH", "更新包版本与清单不一致");
        }

        try {
            PackageInfo installed = packageManager.getPackageInfo(
                    getContext().getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (archive.getLongVersionCode() <= installed.getLongVersionCode()) {
                throw new UpdateException("APK_VERSION_NOT_NEWER", "更新包版本不高于当前版本");
            }
            Set<String> archiveCertificates = certificateDigests(archive);
            Set<String> installedCertificates = certificateDigests(installed);
            boolean signatureMatches = archiveCertificates.stream()
                    .anyMatch(installedCertificates::contains);
            if (!signatureMatches) {
                throw new UpdateException("APK_SIGNATURE_MISMATCH", "更新包签名与当前应用不一致");
            }
        } catch (UpdateException error) {
            throw error;
        } catch (Exception error) {
            throw new UpdateException("APK_SIGNATURE_FAILED", "无法验证更新包签名");
        }
    }

    private static Set<String> certificateDigests(PackageInfo info) throws NoSuchAlgorithmException {
        Set<String> digests = new HashSet<>();
        SigningInfo signingInfo = info.signingInfo;
        if (signingInfo == null) return digests;
        Signature[] signatures = signingInfo.hasMultipleSigners()
                ? signingInfo.getApkContentsSigners()
                : signingInfo.getSigningCertificateHistory();
        if (signatures == null) return digests;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (Signature signature : signatures) {
            digests.add(toHex(digest.digest(signature.toByteArray())));
        }
        return digests;
    }

    private static byte[] sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        return digest.digest();
    }

    private static byte[] hexToBytes(String value) {
        if (value == null || !value.matches("(?i)[0-9a-f]{64}")) {
            throw new IllegalArgumentException("invalid SHA-256");
        }
        byte[] bytes = new byte[32];
        for (int i = 0; i < bytes.length; i += 1) {
            bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) {
            value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        }
        return value.toString();
    }

    private static final class UpdateException extends Exception {
        final String code;

        UpdateException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
