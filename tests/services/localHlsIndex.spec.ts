import { describe, expect, it } from 'vitest';

import type { DownloadHlsIndex } from '@/types';
import { hlsPlaylistFingerprint, parseM3u8 } from '@/services/hlsDownloader';
import { buildLocalHlsManifest, isCompleteLocalHlsIndex } from '@/services/localHlsIndex';

function index(): DownloadHlsIndex {
  return {
    version: 1,
    playlistFingerprint: '12345678',
    targetDuration: 10,
    mediaSequence: 0,
    segments: [
      { index: 0, offset: 0, length: 188, duration: 2, discontinuity: false },
      { index: 1, offset: 188, length: 376, duration: 4, discontinuity: true },
    ],
  };
}

describe('本地 HLS 索引', () => {
  it('把合并 TS 的精确字节范围与 discontinuity 写进可 seek 的清单', () => {
    const manifest = buildLocalHlsManifest(index(), 'downloads/m1/e1.ts');

    expect(manifest).toBe([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXTINF:2.000,',
      '#EXT-X-BYTERANGE:188@0',
      'e1.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.000,',
      '#EXT-X-BYTERANGE:376@188',
      'e1.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'));
    expect(isCompleteLocalHlsIndex(index(), 2, 564)).toBe(true);
  });

  it('解析源清单时把 discontinuity 标记绑定到它后面的那一片', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:2,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:4,
b.ts
#EXT-X-ENDLIST`, 'https://cdn.example.com/media.m3u8');

    expect(playlist.segments.map((segment) => segment.discontinuity)).toEqual([false, true]);
    expect(playlist.discontinuityCount).toBe(1);
  });

  it('discontinuity 数量相同但位置不同也必须得到不同指纹', () => {
    const first = parseM3u8(`#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:2,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:2,
b.ts
#EXTINF:2,
c.ts
#EXT-X-ENDLIST`, 'https://cdn.example.com/media.m3u8');
    const second = parseM3u8(`#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-DISCONTINUITY
#EXTINF:2,
a.ts
#EXTINF:2,
b.ts
#EXTINF:2,
c.ts
#EXT-X-ENDLIST`, 'https://cdn.example.com/media.m3u8');

    expect(first.discontinuityCount).toBe(second.discontinuityCount);
    expect(hlsPlaylistFingerprint(first)).not.toBe(hlsPlaylistFingerprint(second));
  });
});
