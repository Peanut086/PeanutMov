import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProgressSnapshot } from '@/player/ProgressReporter';
import { ProgressReporter } from '@/player/ProgressReporter';

/**
 * ProgressReporter 测试（AC-50 / AC-51 / 技术方案 9.4）
 *
 * 断言：
 * - 最小写库间隔 4s（避免 5s 采样产生双写）
 * - pause / flush 立即写入
 * - duration <= 0 不写入
 * - ≥95% 视为完结：positionSec=0, finished=true
 * - resumePosition 仅在 5%~95% 之间续播
 */
describe('ProgressReporter', () => {
  let clock = 0;
  let saved: ProgressSnapshot[];

  function make(overrides: Partial<ConstructorParameters<typeof ProgressReporter>[0]> = {}): ProgressReporter {
    saved = [];
    return new ProgressReporter({
      save: (snapshot) => {
        saved.push(snapshot);
      },
      now: () => clock,
      ...overrides,
    });
  }

  beforeEach(() => {
    clock = 1_000_000;
    saved = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('duration 无效时不写入', async () => {
    const reporter = make();
    reporter.update(30, 0);
    await reporter.flush();
    reporter.update(30, Number.NaN);
    await reporter.flush();
    expect(saved).toHaveLength(0);
    reporter.dispose();
  });

  it('flush 立即写入当前位置与时长', async () => {
    const reporter = make();
    reporter.update(300, 1000);
    await reporter.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.positionSec).toBe(300);
    expect(saved[0]?.durationSec).toBe(1000);
    expect(saved[0]?.progress).toBeCloseTo(0.3, 5);
    expect(saved[0]?.finished).toBe(false);
    reporter.dispose();
  });

  it('位置未变化时 flush 不重复写库（避免与 5s 采样双写）', async () => {
    const reporter = make();
    reporter.update(100, 1000);
    await reporter.flush();
    expect(saved).toHaveLength(1);

    clock += 1000;
    await reporter.flush();
    expect(saved).toHaveLength(1);
    reporter.dispose();
  });

  it('位置变化时 flush 不受 4s 间隔限制（退出必须反映最新位置）', async () => {
    const reporter = make();
    reporter.update(100, 1000);
    await reporter.flush();
    expect(saved).toHaveLength(1);

    clock += 1000;
    reporter.update(110, 1000);
    await reporter.flush();
    expect(saved).toHaveLength(2);
    expect(saved[1]?.positionSec).toBe(110);
    reporter.dispose();
  });

  it('周期采样：每 5s 触发一次，且受 4s 最小间隔约束', async () => {
    const reporter = make();
    reporter.update(50, 1000);
    await reporter.flush(); // 建立 lastWriteAt 基线
    expect(saved).toHaveLength(1);

    reporter.update(55, 1000);
    clock += 2000; // 距上次写库仅 2s → tick 应跳过
    await reporter.tick();
    expect(saved).toHaveLength(1);

    reporter.update(80, 1000);
    clock += 4000; // 累计 6s → 允许写
    await reporter.tick();
    expect(saved).toHaveLength(2);
    expect(saved[1]?.positionSec).toBe(80);
    reporter.dispose();
  });

  it('start() 后按 5s 周期自动采样并写入', async () => {
    const reporter = make();
    reporter.update(50, 1000);
    reporter.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    clock += 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(saved[0]?.positionSec).toBe(50);
    reporter.dispose();
  });

  it('结束（finish）：≥95% 写 finished=true 且 position=0', async () => {
    const reporter = make();
    reporter.update(960, 1000);
    await reporter.finish();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.finished).toBe(true);
    expect(saved[0]?.positionSec).toBe(0);
    expect(saved[0]?.progress).toBe(1);
    reporter.dispose();
  });

  it('flush 在 95% 以上同样按完结落库（AC-51：进度 96% 重进从头）', async () => {
    const reporter = make();
    reporter.update(960, 1000);
    await reporter.flush();
    expect(saved[0]?.finished).toBe(true);
    expect(saved[0]?.positionSec).toBe(0);
    reporter.dispose();
  });

  it('95% 以下 flush 保留真实位置', async () => {
    const reporter = make();
    reporter.update(940, 1000);
    await reporter.flush();
    expect(saved[0]?.finished).toBe(false);
    expect(saved[0]?.positionSec).toBe(940);
    reporter.dispose();
  });

  it('snapshot 不做取整，progress 为 0~1', () => {
    const reporter = make();
    reporter.update(250.5, 1000);
    const snap = reporter.snapshot();
    expect(snap.positionSec).toBe(250.5);
    expect(snap.progress).toBeCloseTo(0.2505, 5);
    reporter.dispose();
  });

  it('resumePosition：5%~95% 内续播，边界与越界从 0 开始', () => {
    expect(ProgressReporter.resumePosition(300, 1000)).toBe(300);
    expect(ProgressReporter.resumePosition(50, 1000)).toBe(0); // 恰好 5% → 不续播
    expect(ProgressReporter.resumePosition(20, 1000)).toBe(0);
    expect(ProgressReporter.resumePosition(950, 1000)).toBe(0); // 恰好 95% → 完结
    expect(ProgressReporter.resumePosition(960, 1000)).toBe(0);
    expect(ProgressReporter.resumePosition(1200, 1000)).toBe(0);
    expect(ProgressReporter.resumePosition(100, 0)).toBe(0);
    expect(ProgressReporter.resumePosition(Number.NaN, 1000)).toBe(0);
  });

  it('save 抛错不阻断后续写入', async () => {
    let calls = 0;
    const reporter = new ProgressReporter({
      save: () => {
        calls += 1;
        throw new Error('db down');
      },
      now: () => clock,
    });
    reporter.update(100, 1000);
    await reporter.flush();
    expect(calls).toBe(1);

    clock += 5000;
    reporter.update(200, 1000);
    await reporter.flush();
    expect(calls).toBe(2);
    reporter.dispose();
  });

  it('dispose 后不再写入', async () => {
    const reporter = make();
    reporter.update(100, 1000);
    reporter.dispose();
    await reporter.flush();
    expect(saved).toHaveLength(0);
  });
});
