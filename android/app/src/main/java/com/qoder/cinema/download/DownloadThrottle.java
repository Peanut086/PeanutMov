package com.qoder.cinema.download;

/**
 * 原生下载全局令牌桶（EXT-04 / FR-63）
 *
 * 全进程一份额度：所有 RangeDownloader 线程（含多 Range 分段）共享，档位由 JS 侧
 * `settings.download.speedLimit` 经 `MediaTool.setSpeedLimit` 下发。
 *
 * 为什么原生必须自己扣减：JS 侧的 `downloadRateLimiter` 只挂在 `DownloadSink.write()` 上，
 * 原生直链走 OkHttp → RandomAccessFile，完全不经过 JS sink，
 * 所以设置里承诺的「对所有下载任务生效」只有这里补上才成立。
 */
public final class DownloadThrottle {

    private static final DownloadThrottle INSTANCE = new DownloadThrottle();

    /** 单次睡眠上限：让暂停/取消与切档在 200ms 内收敛（AC-149） */
    private static final long MAX_SLEEP_MS = 200;
    /** 桶容量下限：吸收单块 256KB 的粒度误差，避免小块永远凑不满一格 */
    private static final long MIN_BUCKET_BYTES = 64 * 1024;

    private final Object lock = new Object();

    /** 0 表示不限速 */
    private long bytesPerSec = 0;
    private double tokens = 0;
    private long lastRefillAt = System.currentTimeMillis();

    private DownloadThrottle() {
    }

    public static DownloadThrottle shared() {
        return INSTANCE;
    }

    /** 切档清桶（避免旧额度残留），并唤醒等待中的线程立刻按新档位判定 */
    public void setBytesPerSec(long value) {
        synchronized (lock) {
            bytesPerSec = Math.max(0L, value);
            tokens = 0;
            lastRefillAt = System.currentTimeMillis();
            lock.notifyAll();
        }
    }

    public long getBytesPerSec() {
        synchronized (lock) {
            return bytesPerSec;
        }
    }

    /**
     * 消费额度（写盘前调用）。
     *
     * 令牌允许欠账：单块字节数大于桶容量时按差额比例等待，既保证稳态速率，
     * 也不会因为块大于桶而永久阻塞。等待期间释放监视器，分段线程仍能并行判定。
     */
    public void acquire(int bytes) throws InterruptedException {
        if (bytes <= 0) {
            return;
        }
        synchronized (lock) {
            if (bytesPerSec <= 0) {
                return;
            }
            refillLocked();
            tokens -= bytes;
            while (tokens < 0 && bytesPerSec > 0) {
                long deficit = (long) Math.ceil(-tokens);
                long waitMs = Math.min(MAX_SLEEP_MS, Math.max(1L, (deficit * 1000L) / bytesPerSec));
                lock.wait(waitMs);
                refillLocked();
            }
        }
    }

    private void refillLocked() {
        long now = System.currentTimeMillis();
        long elapsed = now - lastRefillAt;
        lastRefillAt = now;
        if (elapsed <= 0 || bytesPerSec <= 0) {
            return;
        }
        long capacity = Math.max(bytesPerSec, MIN_BUCKET_BYTES);
        double gained = (bytesPerSec * (double) elapsed) / 1000.0;
        tokens = Math.min((double) capacity, tokens + gained);
    }
}
