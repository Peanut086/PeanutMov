import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-4：后台线路探测的成功口径
 *
 * 旧口径「resolvePlay 有答 = 线路可播」在真机上永远停在第一条死线路（那个域名连 DNS
 * 都解析不了）。现在补第二种证据：地址空读。判死要换下一条继续探，判不出来则维持原样，
 * 免得把「探测方式受限」写成「线路挂了」。
 */

const h = vi.hoisted(() => {
  const verdicts: string[] = [];
  const healthLog: Array<Record<string, unknown>> = [];
  const probe = vi.fn(async () => {
    const verdict = verdicts.shift() ?? 'alive';
    return { verdict, latencyMs: 320, status: verdict === 'dead' ? null : 206, viaProxy: true };
  });
  const resolvePlay = vi.fn(async ({ episodeId, lineId }: { episodeId: string; lineId: string }) => ({
    url: episodeId === 'demo:m1:local' ? 'file:///sdcard/x.mp4' : 'https://cdn.example.com/a.m3u8',
    isLocal: episodeId === 'demo:m1:local',
    headers: {},
    format: 'hls',
    subtitles: [],
    lineId,
    quality: null,
    expiresAt: null,
  }));
  return { verdicts, healthLog, probe, resolvePlay };
});

vi.mock('@/native/network', () => ({ isOnline: () => true }));

vi.mock('@/services/lineRanking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/lineRanking')>();
  return { ...actual, rankLines: ({ lines }: { lines: unknown[] }): unknown[] => lines };
});

vi.mock('@/services/urlLivenessProbe', () => ({ probeUrlLiveness: h.probe }));

vi.mock('@/services/lineHealthService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/lineHealthService')>();
  return {
    ...actual,
    lineHealthService: {
      ...actual.lineHealthService,
      recordSuccess: (key: string): void => {
        h.healthLog.push({ kind: 'ok', key });
      },
      recordFail: (key: string, errorCode: string, opts?: { immediate?: boolean }): void => {
        h.healthLog.push({ kind: 'fail', key, errorCode, immediate: opts?.immediate });
      },
    },
  };
});

vi.mock('@/services/libraryService', () => ({ libraryService: { resolvePlay: h.resolvePlay } }));

const { probeLines } = await import('@/services/lineProbeService');

function makeCtx(episodeId = 'demo:m1:e1') {
  const lines = [
    { id: 'src-a:m1:0', mediaId: 'src-a:m1', sourceId: 'src-a', name: '线路 1', quality: null, format: 'mp4', index: 0 },
    { id: 'src-a:m1:1', mediaId: 'src-a:m1', sourceId: 'src-a', name: '线路 2', quality: null, format: 'mp4', index: 1 },
  ];
  return {
    item: { id: 'src-a:m1', sourceId: 'src-a', sourceItemId: 'm1' } as never,
    lines: lines as never,
    targetEpisode: { id: episodeId, lineId: lines[0]!.id, mediaId: 'src-a:m1' } as never,
    historyEpisodeId: null,
  };
}

describe('probeLines 的地址级证据', () => {
  beforeEach(() => {
    h.verdicts.length = 0;
    h.healthLog.length = 0;
    h.probe.mockClear();
    h.resolvePlay.mockClear();
  });

  it('首条探活判死 → 单次沉底并继续探下一条，成功落到第二条', async () => {
    h.verdicts.push('dead', 'alive');

    const result = await probeLines(makeCtx());

    expect(result).toEqual({ probedCount: 2, successLineId: 'src-a:m1:1', allFailed: false });
    expect(h.healthLog).toEqual([
      { kind: 'fail', key: 'src-a|m1|线路 1', errorCode: 'E_SOURCE_UNAVAILABLE', immediate: true },
      { kind: 'ok', key: 'src-a|m1|线路 2' },
    ]);
  });

  it('探活判不出来（unknown）仍算通过，也不给线路记失败', async () => {
    h.verdicts.push('unknown');

    const result = await probeLines(makeCtx());

    expect(result.successLineId).toBe('src-a:m1:0');
    expect(h.healthLog).toEqual([{ kind: 'ok', key: 'src-a|m1|线路 1' }]);
  });

  it('全部线路探活判死 → allFailed，且每条都单独沉底', async () => {
    h.verdicts.push('dead', 'dead');

    const result = await probeLines(makeCtx());

    expect(result).toEqual({ probedCount: 2, successLineId: null, allFailed: true });
    expect(h.healthLog.filter((r) => r.kind === 'fail')).toHaveLength(2);
  });

  it('本地已下载的地址不探活，直接算可播（零流量）', async () => {
    const result = await probeLines(makeCtx('demo:m1:local'));

    expect(result.successLineId).toBe('src-a:m1:0');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.healthLog).toEqual([{ kind: 'ok', key: 'src-a|m1|线路 1' }]);
  });
});
