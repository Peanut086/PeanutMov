package com.qoder.cinema;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Process;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 导出包的构建标识头（P1-5）。
 *
 * <p>需求要「仍可按 PID、时间、构件指纹关联」。此前两份真机导出日志的第一行都是
 * {@code ===== spider-2026-11-16.log =====}：拿到日志的人既不知道这是哪个版本、哪台机器
 * 跑出来的，也无法判断「那个修复到底进没进这轮包」——同一个 jar 的名字（md5）不变，
 * 行内容就完全一样，只有版本号能把两轮区分开。
 *
 * <p>jar 名单是这里唯一的「构件指纹」来源：落盘名就是 {@code md5(下载 URL)}，
 * 归因第三方 jar 时对着 {@code CrashExit} 行里的 jarHash 能直接连上。
 * 刻意不写文件 mtime——华为真机上 {@code stat} 的时间不可信（此前排查实测过），
 * 写了只会把人带偏，所以只留体积。
 */
public final class LogBuildIdentity {

    private LogBuildIdentity() {
    }

    private static final int JAR_LIST_MAX = 12;

    /** 一段可直接写进导出文件开头的标识文本 */
    public static String header(Context ctx, String scope, int droppedNoisy, int droppedKey) {
        Info info = new Info();
        info.scope = scope == null || scope.isEmpty() ? "all" : scope;
        info.exportedAt = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
        info.pid = Process.myPid();
        info.model = Build.MODEL;
        info.manufacturer = Build.MANUFACTURER;
        info.hardware = Build.HARDWARE;
        info.release = Build.VERSION.RELEASE;
        info.sdk = Build.VERSION.SDK_INT;
        info.packageId = ctx.getPackageName();
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(info.packageId, 0);
            info.versionName = pi.versionName;
            info.versionCode = Long.toString(readVersionCode(pi));
            info.debug = (pi.applicationInfo != null
                    && (pi.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        } catch (Exception e) {
            info.versionName = "unknown";
            info.versionCode = "unknown";
        }
        info.jars = jarFingerprints(ctx);
        info.droppedNoisy = droppedNoisy;
        info.droppedKey = droppedKey;
        return format(info);
    }

    /** 老接口上 versionCode 会被截断成 int，两个都试一次，拿不到就当未知 */
    private static long readVersionCode(PackageInfo pi) {
        try {
            return pi.getLongVersionCode();
        } catch (Exception ignored) {
            return pi.versionCode;
        }
    }

    /** {@code filesDir/spider-jars/{md5}.jar} → 指纹行（名字即 md5(下载 URL)） */
    private static List<String> jarFingerprints(Context ctx) {
        List<String> out = new ArrayList<>();
        File[] files = new File(ctx.getFilesDir(), "spider-jars").listFiles(
                (dir, name) -> name.endsWith(".jar"));
        if (files == null) return out;
        java.util.Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
        for (int i = 0; i < files.length && i < JAR_LIST_MAX; i++) {
            out.add(files[i].getName() + " size=" + files[i].length());
        }
        if (files.length > JAR_LIST_MAX) {
            out.add("…其余 " + (files.length - JAR_LIST_MAX) + " 个 jar 未列出");
        }
        return out;
    }

    /** 纯格式化：不碰任何 Android API，形态由单测钉死 */
    static final class Info {
        String scope = "all";
        String exportedAt = "";
        int pid;
        String packageId = "";
        String versionName = "";
        String versionCode = "";
        boolean debug;
        String model = "";
        String manufacturer = "";
        String hardware = "";
        String release = "";
        int sdk;
        List<String> jars = new ArrayList<>();
        int droppedNoisy;
        int droppedKey;
    }

    static String format(Info i) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("===== 构建标识 =====\n");
        sb.append("scope=").append(i.scope)
                .append(" exportedAt=").append(i.exportedAt)
                .append(" pid=").append(i.pid).append('\n');
        sb.append("app=").append(i.packageId)
                .append(" versionName=").append(i.versionName)
                .append(" versionCode=").append(i.versionCode)
                .append(" buildType=").append(i.debug ? "debug" : "release").append('\n');
        sb.append("device=").append(i.manufacturer).append('/').append(i.model)
                .append(" hardware=").append(i.hardware)
                .append(" android=").append(i.release)
                .append(" sdk=").append(i.sdk).append('\n');
        sb.append("jars（构件指纹＝文件名 md5(下载 URL)，归因 jar 时与 CrashExit 行的 jarHash 对得上）")
                .append('\n');
        if (i.jars.isEmpty()) {
            sb.append("  - 无（本轮没有已下载的爬虫 jar）\n");
        } else {
            for (String jar : i.jars) sb.append("  - ").append(jar).append('\n');
        }
        // 静默丢弃等于伪造证据链：丢过多少、丢的是哪一类，必须自己说清楚
        sb.append("queue_drops noisy=").append(i.droppedNoisy)
                .append(" key=").append(i.droppedKey)
                .append("（队列满时的丢弃计数，key>0 说明关键行也被挤掉过）\n");
        return sb.toString();
    }
}
