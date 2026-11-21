/**
 * P2-2：MP4 复检的证据链（文案 + 桥归一化）
 *
 * 复检的判定规则在原生 `MediaRemuxer.probeReport`，这里守住 JS 侧两件最容易坏的事：
 * 1. 线上字段名（原生回 `seekPoints`）与归一化结果（`seeks`）对不上——真出过一次，明细永远为空且静默；
 * 2. 结论文案必须把"凭什么这么说"的数字带出来，同时容忍旧 APK 不返回明细时退回一句话。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describeMediaVerify, verifyRemuxedMedia, type MediaVerifyResult } from '@/native/mediaToolPlugin';

const env = vi.hoisted(() => ({
  native: true,
  registered: true,
  /** 下一次 verifyMedia 的返回值 */
  result: null as Record<string, unknown> | null,
  /** 置为非空时 verifyMedia 直接 reject */
  error: null as Error | null,
  calls: [] as Array<{ path: string; expectedDurationUs?: number }>,
}));

vi.mock('@/shared/platform', () => ({ isNative: () => env.native }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => env.registered },
  registerPlugin: () => ({
    verifyMedia: (options: { path: string; expectedDurationUs?: number }) => {
      env.calls.push(options);
      if (env.error) return Promise.reject(env.error);
      return Promise.resolve(env.result ?? {});
    },
  }),
}));

/** 复检结果样本：体积统一 100 MB，文案断言只看差异字段 */
function probeResult(partial: Partial<MediaVerifyResult>): MediaVerifyResult {
  return { ok: true, probeVerdict: 'pass', outputBytes: 104_857_600, ...partial };
}

describe('describeMediaVerify：复检结论一句人话', () => {
  it('通过：把轨道、分辨率、时长与定位偏差都带进证据', () => {
    const text = describeMediaVerify(
      probeResult({
        ok: true,
        probeVerdict: 'pass',
        trackCount: 2,
        audioTrackCount: 1,
        videoMime: 'video/avc',
        width: 1920,
        height: 1080,
        durationUs: 1_500_000_000,
        seeks: [
          { phase: 'head', requestedUs: 0, sampleUs: 0, deltaUs: 0, sizeBytes: 12_000, hit: true },
          { phase: 'middle', requestedUs: 750_000_000, sampleUs: 750_031_000, deltaUs: 31_000, sizeBytes: 9_000, hit: true },
          { phase: 'tail', requestedUs: 1_499_000_000, sampleUs: 1_498_970_000, deltaUs: -30_000, sizeBytes: 8_000, hit: true },
        ],
      }),
    );
    expect(text).toContain('容器、轨道与首中尾定位都正常');
    expect(text).toContain('100.0 MB');
    expect(text).toContain('轨道 2 · 音频 1');
    expect(text).toContain('1920×1080 avc');
    expect(text).toContain('时长 25:00');
    expect(text).toContain('定位偏差 ≤ 31ms');
  });

  it('旧 APK 不返回明细：退回一句话，不编造证据', () => {
    const text = describeMediaVerify(probeResult({ ok: true, probeVerdict: 'pass' }));
    expect(text).toBe('容器、轨道与首中尾定位都正常（100.0 MB）');
    expect(text).not.toContain('·');
  });

  it('missing：说的是记账体积，而不是文件体积（此刻是 0）', () => {
    const text = describeMediaVerify(probeResult({ ok: false, probeVerdict: 'missing', outputBytes: 0 }));
    expect(text).toContain('文件读不到了（记账 0.0 MB）');
  });

  it('轨道/时长类结论各自对上口径', () => {
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'no-tracks' }))).toContain('解不出可用的视频轨道');
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'no-video-track' }))).toContain('解不出可用的视频轨道');
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'invalid-dimensions' }))).toContain('解不出有效分辨率');
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'no-duration' }))).toContain('读不到时长');
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'probe-error-IllegalArgumentException' }))).toContain(
      '解封装探测报错 IllegalArgumentException',
    );
  });

  it('duration-drift-NN 的 NN 是"实测 ÷ 记账"的百分比，不是差值', () => {
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'duration-drift-72' }))).toContain(
      '实测时长只有记账的 72%，可能缺了尾部内容',
    );
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'duration-drift-125' }))).toContain(
      '实测时长是记账的 125%，时间轴信息可能不可信',
    );
  });

  it('定位落空：点名哪一段找不到，并列出所有落空的段', () => {
    expect(describeMediaVerify(probeResult({ ok: false, probeVerdict: 'tail-seek-miss' }))).toContain(
      '定位不到结尾的采样点',
    );
    const text = describeMediaVerify(
      probeResult({
        ok: false,
        probeVerdict: 'middle-seek-miss',
        seeks: [
          { phase: 'head', requestedUs: 0, sampleUs: 0, deltaUs: 0, sizeBytes: 1000, hit: true },
          { phase: 'middle', requestedUs: 750_000_000, sampleUs: -1, deltaUs: -1, sizeBytes: -1, hit: false },
        ],
      }),
    );
    expect(text).toContain('定位落空：中间');
    expect(text).not.toContain('开头');
    expect(text).not.toContain('定位偏差');
  });

  it('未知结论也要把原始 verdict 透出，不能伪装成健康', () => {
    const text = describeMediaVerify(probeResult({ ok: false, probeVerdict: 'weird-new-verdict' }));
    expect(text).toContain('复检未通过：weird-new-verdict');
  });
});

describe('verifyRemuxedMedia：线上返回 → 归一化结果', () => {
  beforeEach(() => {
    env.native = true;
    env.registered = true;
    env.result = null;
    env.error = null;
    env.calls = [];
  });

  it('认原生真实字段名 seekPoints（读成 seeks 会静默丢掉全部定位证据）', async () => {
    env.result = {
      ok: true,
      probeVerdict: 'pass',
      outputBytes: 104_857_600,
      trackCount: 2,
      audioTrackCount: 1,
      videoMime: 'video/hevc',
      width: 3840,
      height: 2160,
      durationUs: 600_000_000,
      seekPoints: [
        { phase: 'head', requestedUs: 0, sampleUs: 0, deltaUs: 0, sizeBytes: 40_000, hit: true },
        { phase: 'middle', requestedUs: 300_000_000, sampleUs: 300_002_000, deltaUs: 2_000, sizeBytes: 30_000, hit: true },
        { phase: 'tail', requestedUs: 599_000_000, sampleUs: 598_995_000, deltaUs: -5_000, sizeBytes: 20_000, hit: true },
      ],
    };
    const result = await verifyRemuxedMedia('downloads/a.mp4');
    expect(result?.seeks?.map((s) => s.phase)).toEqual(['head', 'middle', 'tail']);
    expect(result?.seeks?.[2]?.deltaUs).toBe(-5_000);
    expect(result?.videoMime).toBe('video/hevc');
    expect(describeMediaVerify(result!)).toContain('定位偏差 ≤ 5ms');
  });

  it('ok 只在 probeVerdict 为 pass 时成立：原生误标 ok 也不放行', async () => {
    env.result = { ok: true, probeVerdict: 'tail-seek-miss', outputBytes: 104_857_600, seekPoints: [] };
    const result = await verifyRemuxedMedia('downloads/a.mp4');
    expect(result?.ok).toBe(false);
    expect(result?.probeVerdict).toBe('tail-seek-miss');
  });

  it('没有 probeVerdict 视为能力缺席（旧 APK 的空实现），返回 null 而不是"没问题"', async () => {
    env.result = {};
    expect(await verifyRemuxedMedia('downloads/a.mp4')).toBeNull();
  });

  it('明细缺字段只丢明细，不丢结论；定位空数组归一成 undefined', async () => {
    env.result = {
      ok: false,
      probeVerdict: 'no-duration',
      outputBytes: 1_000,
      trackCount: '2',
      width: null,
      seekPoints: [],
    };
    const result = await verifyRemuxedMedia('downloads/a.mp4');
    expect(result).toMatchObject({ ok: false, probeVerdict: 'no-duration', outputBytes: 1_000 });
    expect(result?.trackCount).toBeUndefined();
    expect(result?.width).toBeUndefined();
    expect(result?.seeks).toBeUndefined();
    expect(result?.audioTrackCount).toBeUndefined();
  });

  it('expectedDurationUs 只在正数时下发，0/undefined 不污染原生判定', async () => {
    env.result = { ok: true, probeVerdict: 'pass', outputBytes: 1 };
    await verifyRemuxedMedia('downloads/a.mp4');
    await verifyRemuxedMedia('downloads/a.mp4', 0);
    await verifyRemuxedMedia('downloads/a.mp4', -5);
    await verifyRemuxedMedia('downloads/a.mp4', 1_500_000_000);
    expect(env.calls.map((c) => 'expectedDurationUs' in c)).toEqual([false, false, false, true]);
    expect(env.calls[3]).toEqual({ path: 'downloads/a.mp4', expectedDurationUs: 1_500_000_000 });
  });

  it('方法未实现（旧 APK）按能力缺席返回 null；其它错误照抛', async () => {
    env.error = new Error('method not implemented');
    expect(await verifyRemuxedMedia('downloads/a.mp4')).toBeNull();

    env.error = new Error('E_IO: 读取失败');
    await expect(verifyRemuxedMedia('downloads/a.mp4')).rejects.toThrow('读取失败');
  });

  it('Web / 插件未注册时不发调用', async () => {
    env.native = false;
    expect(await verifyRemuxedMedia('downloads/a.mp4')).toBeNull();
    env.native = true;
    env.registered = false;
    expect(await verifyRemuxedMedia('downloads/a.mp4')).toBeNull();
    expect(env.calls).toHaveLength(0);
  });
});
