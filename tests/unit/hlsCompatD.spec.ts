/**
 * FIX-PLAY-D1/D2/D3：源侧清单兼容
 *
 * 直接过真实解析入口 `parseM3u8`，锁三件事：
 * - BYTERANGE 缺省偏移按规范隐式续接上一个 range 终点（旧实现一律当 0）
 * - BYTERANGE 暂存是函数局部状态，跨解析不残留（旧实现挂函数对象上会串话）
 * - METHOD 大小写归一：`aes-128` 变体既不能被当成"未加密"跳过，也不能漏过解密分支
 * 外加 DISCONTINUITY 边界计数。
 */
import { describe, expect, it } from 'vitest';

import { parseM3u8 } from '@/services/hlsDownloader';

const BASE = 'https://cdn.example.com/v/index.m3u8';

function media(lines: string[]): string {
  return ['#EXTM3U', ...lines].join('\n');
}

describe('BYTERANGE 兼容（FIX-PLAY-D2）', () => {
  it('缺省偏移 = 上一个 range 的终点；显式 @0 仍是 0', () => {
    const p = parseM3u8(
      media([
        '#EXT-X-BYTERANGE:652@0',
        'big.ts',
        '#EXT-X-BYTERANGE:1000',
        'big.ts',
        '#EXT-X-BYTERANGE:2000',
        'big.ts',
        '#EXT-X-BYTERANGE:300@0',
        'other.ts',
      ]),
      BASE,
    );
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { offset: 0, length: 652 },
      { offset: 652, length: 1000 },
      { offset: 1652, length: 2000 },
      { offset: 0, length: 300 },
    ]);
  });

  it('上一条 BYTERANGE 没等到 URL 就结束时，不污染下一次解析', () => {
    // 旧实现把暂存挂在 parseMediaPlaylist 函数对象上：上一条以 BYTERANGE 结尾时，
    // 残留会落到这一条的第一个裸 URL 上，凭空给分片加 Range 头。
    try {
      parseM3u8(media(['#EXTINF:10', '#EXT-X-BYTERANGE:999@100']), BASE); // 无 URL 分片 → 抛 E_PARSE
    } catch {
      /* 预期抛错，重点在下一条不被污染 */
    }
    const p = parseM3u8(media(['#EXTINF:10', 'first.ts', '#EXTINF:10', 'second.ts']), BASE);
    expect(p.segments[0]!.byteRange).toBeUndefined();
    expect(p.segments[1]!.byteRange).toBeUndefined();
  });
});

describe('METHOD 大小写归一（FIX-PLAY-D3）', () => {
  it('小写 aes-128 解析为大写 AES-128，下载侧解密分支可命中', () => {
    const p = parseM3u8(
      media(['#EXT-X-KEY:METHOD=aes-128,URI="k.bin"', '#EXTINF:10', 'seg.ts']),
      BASE,
    );
    expect(p.segments[0]!.key?.method).toBe('AES-128');
    expect(p.segments[0]!.key?.uri).toBe('https://cdn.example.com/v/k.bin');
  });

  it('NONE 的任意大小写都等价于无密钥', () => {
    const p = parseM3u8(
      media(['#EXT-X-KEY:METHOD="none"', '#EXTINF:10', 'seg.ts']),
      BASE,
    );
    expect(p.segments[0]!.key).toBeUndefined();
  });
});

describe('DISCONTINUITY 计数（FIX-PLAY-D1）', () => {
  it('统计边界数但不改变分片序列', () => {
    const p = parseM3u8(
      media([
        '#EXTINF:10',
        'a.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10',
        'b.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10',
        'c.ts',
      ]),
      BASE,
    );
    expect(p.segments.map((s) => s.url)).toEqual([
      'https://cdn.example.com/v/a.ts',
      'https://cdn.example.com/v/b.ts',
      'https://cdn.example.com/v/c.ts',
    ]);
    expect(p.discontinuityCount).toBe(2);
  });

  it('没有边界时为 0', () => {
    const p = parseM3u8(media(['#EXTINF:10', 'a.ts']), BASE);
    expect(p.discontinuityCount).toBe(0);
  });
});
