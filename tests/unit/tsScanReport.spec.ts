/**
 * FIX-PLAY-C3：TS 自检结论文案
 *
 * describeTsScan 是把原生扫描结果讲成人话的唯一出口，数字口径必须和
 * `TsScanResult` 字段严格一致——这里纯函数可测，UI 只做展示。
 */
import { describe, expect, it } from 'vitest';

import { describeTsScan, type TsScanResult } from '@/native/mediaToolPlugin';

function scan(partial: Partial<TsScanResult>): TsScanResult {
  return {
    ok: true,
    verdict: 'ok',
    fileSize: 104_857_600,
    packetSize: 188,
    alignedStart: 0,
    totalPackets: 557_753,
    badPackets: 0,
    firstBadOffset: -1,
    tailBytes: 0,
    ...partial,
  };
}

describe('describeTsScan', () => {
  it('ok：给出体积与包数，188 字节包长不啰嗦', () => {
    const text = describeTsScan(scan({}));
    expect(text).toContain('文件结构健康');
    expect(text).toContain('100.0 MB');
    expect(text).toContain('557753');
    expect(text).not.toContain('包长');
  });

  it('ok + 192 字节包长（时间戳流）要说明', () => {
    expect(describeTsScan(scan({ packetSize: 192 }))).toContain('包长 192 字节');
  });

  it('corrupt：坏包数/总数与首处偏移都给出来', () => {
    const text = describeTsScan(scan({ ok: false, verdict: 'corrupt', badPackets: 7, firstBadOffset: 95_000 }));
    expect(text).toContain('7/557753');
    expect(text).toContain('偏移 95000 字节');
  });

  it('truncated/not-ts/prefix 各有对应话术', () => {
    expect(describeTsScan(scan({ ok: false, verdict: 'truncated', tailBytes: 90 }))).toContain('只剩 90 字节');
    expect(describeTsScan(scan({ ok: false, verdict: 'not-ts' }))).toContain('不是标准 TS 分片数据');
    expect(describeTsScan(scan({ ok: false, verdict: 'prefix', alignedStart: 4 }))).toContain('混入 4 字节');
  });
});
