import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/platform', () => ({ isNative: () => true }));

const getRecentExits = vi.fn();

vi.mock('@/native/spiderPlugin', () => ({
  Spider: { getRecentExits: () => getRecentExits() },
}));

import { SPIDER_COOLDOWN_MS, SPIDER_QUARANTINE_MS } from '@/shared/constants';
import {
  __resetSourceBlockState,
  clearSourceBlock,
  evidenceForJar,
  getSourceBlock,
  isSourceBlocked,
  noteSourceBlocked,
  recentExitEvidence,
  releaseBlocksAfterRestore,
  sourceBlockSnapshot,
} from '@/services/sourceBlockState';

/**
 * 爬虫保护态的前端镜像（P0-1）
 *
 * 止血点是"别再反复敲原生已经拒绝的门"：自动预热、失败换线、自动换源都读这张表。
 * 因此表必须满足三件事——只镜像真实拒绝、到兜底时长自己松手、恢复只松软档。
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  __resetSourceBlockState();
  getRecentExits.mockReset();
});

afterEach(() => {
  __resetSourceBlockState();
  vi.useRealTimers();
});

describe('保护态记录与放行', () => {
  it('冷却档按兜底时长松手，隔离档要等 7 天', () => {
    noteSourceBlocked('s1', 'cooldown', 'spider busy');
    noteSourceBlocked('s2', 'quarantined', 'jar crash');
    expect(isSourceBlocked('s1')).toBe(true);

    vi.advanceTimersByTime(SPIDER_COOLDOWN_MS - 1);
    expect(isSourceBlocked('s1')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isSourceBlocked('s1')).toBe(false);
    expect(getSourceBlock('s1')).toBeNull();

    // 隔离档用的是 7 天窗口：过了十个冷却时长仍在拦；用绝对时间避免与上面的推进累计
    vi.setSystemTime(1_700_000_000_000 + SPIDER_QUARANTINE_MS - 1);
    expect(isSourceBlocked('s2')).toBe(true);
    vi.setSystemTime(1_700_000_000_000 + SPIDER_QUARANTINE_MS + 1);
    expect(isSourceBlocked('s2')).toBe(false);
  });

  it('空 sourceId 不进表；成功调用立刻解除', () => {
    noteSourceBlocked('', 'cooldown');
    expect(sourceBlockSnapshot()).toEqual([]);

    noteSourceBlocked('s3', 'safe_mode');
    expect(isSourceBlocked('s3')).toBe(true);
    clearSourceBlock('s3');
    expect(isSourceBlocked('s3')).toBe(false);
  });

  it('快照只含未到期条目：冷却已过期不再出现，隔离档仍在表里', () => {
    noteSourceBlocked('a', 'cooldown');
    noteSourceBlocked('b', 'quarantined', 'boom');
    vi.advanceTimersByTime(SPIDER_COOLDOWN_MS + 1);
    expect(sourceBlockSnapshot().map((row) => row.sourceId)).toEqual(['b']);
    // 再读一次结果不变（过期条目不留残账）
    expect(sourceBlockSnapshot().map((row) => row.sourceId)).toEqual(['b']);
    expect(getSourceBlock('a')).toBeNull();
  });
});

describe('恢复只松软档（P0-1 红线：恢复不绕过隔离）', () => {
  it('清掉冷却与安全模式，保留 jar 隔离', () => {
    noteSourceBlocked('cool', 'cooldown');
    noteSourceBlocked('safe', 'safe_mode');
    noteSourceBlocked('jar', 'quarantined');

    expect(releaseBlocksAfterRestore()).toBe(2);
    expect(isSourceBlocked('cool')).toBe(false);
    expect(isSourceBlocked('safe')).toBe(false);
    expect(isSourceBlocked('jar')).toBe(true);
  });

  it('没有软档时返回 0，不动隔离表', () => {
    noteSourceBlocked('jar', 'quarantined');
    expect(releaseBlocksAfterRestore()).toBe(0);
    expect(isSourceBlocked('jar')).toBe(true);
  });
});

describe('退出现场读数（隔离面板的「依据」）', () => {
  const evidence = {
    pid: 1,
    tid: 2,
    jarHash: ' abc123 ',
    api: 'home',
    phase: 'load',
    exitReason: 'SIGSEGV',
    signal: 'SEGV',
    fromPreviousProcess: false,
    at: 1,
  };

  it('60 秒内复用缓存，force 才重新读', async () => {
    getRecentExits.mockResolvedValue({ items: [evidence] });
    expect(await recentExitEvidence()).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(await recentExitEvidence()).toHaveLength(1);
    expect(getRecentExits).toHaveBeenCalledTimes(1);
    await recentExitEvidence(true);
    expect(getRecentExits).toHaveBeenCalledTimes(2);
  });

  it('按构件指纹匹配；api 缺失或通配也算命中，不同 api 不算', async () => {
    getRecentExits.mockResolvedValue({
      items: [{ ...evidence, api: 'detail' }],
    });
    expect(await evidenceForJar('abc123')).not.toBeNull();
    expect(await evidenceForJar('abc123', 'detail')).not.toBeNull();
    expect(await evidenceForJar('abc123', 'home')).toBeNull();
    expect(await evidenceForJar('')).toBeNull();
  });

  it('原生读数失败按「无依据」处理，不阻塞恢复入口', async () => {
    getRecentExits.mockRejectedValue(new Error('plugin missing'));
    expect(await recentExitEvidence(true)).toEqual([]);
    expect(await evidenceForJar('abc123', 'home')).toBeNull();
  });
});
