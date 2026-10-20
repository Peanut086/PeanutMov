import { describe, expect, it } from 'vitest';

import {
  convertTimecode,
  decodeSubtitle,
  normalizeText,
  parseTimestamp,
  parseVtt,
  srtToVtt,
} from '@/player/SrtConverter';
import { SubtitleManager } from '@/player/SubtitleManager';

/**
 * SRT → WebVTT 转换与解析（AC-45）
 *
 * 覆盖：BOM、CRLF、逗号毫秒、多行文本、序号缺失、附加参数、
 * VTT 解析、二分查找命中与时间偏移。
 */
const SRT_SAMPLE = `1
00:00:01,500 --> 00:00:03,000
你好，世界

2
00:00:03,500 --> 00:00:05,250
第二行字幕
第二行的第二句
`;

describe('SrtConverter', () => {
  it('去除 BOM 并统一换行为 \\n', () => {
    const input = '\uFEFF1\r\n00:00:01,500 --> 00:00:03,000\r\n文本\r\n';
    const normalized = normalizeText(input);
    expect(normalized.startsWith('\uFEFF')).toBe(false);
    expect(normalized.includes('\r')).toBe(false);
  });

  it('时间戳逗号转点号，2 位毫秒补齐 3 位', () => {
    expect(convertTimecode('00:00:01,500')).toBe('00:00:01.500');
    expect(convertTimecode('00:01:02,5')).toBe('00:01:02.500');
    expect(convertTimecode('00:00:01.500')).toBe('00:00:01.500');
  });

  it('输出合法 WEBVTT 头，且 cue 起点为 1.5s（AC-45 核心断言）', () => {
    const vtt = srtToVtt(SRT_SAMPLE);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.000');
    expect(vtt).toContain('你好，世界');
    // 不应残留逗号毫秒
    expect(vtt).not.toMatch(/\d{2},\d{3}/);

    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.startSec).toBeCloseTo(1.5, 3);
    expect(cues[0]?.endSec).toBeCloseTo(3, 3);
    expect(cues[0]?.text).toBe('你好，世界');
  });

  it('保留多行文本', () => {
    const cues = parseVtt(srtToVtt(SRT_SAMPLE));
    expect(cues[1]?.text).toBe('第二行字幕\n第二行的第二句');
  });

  it('缺少序号行也能解析', () => {
    const srt = '00:00:02,000 --> 00:00:04,000\n无序号\n';
    const cues = parseVtt(srtToVtt(srt));
    expect(cues).toHaveLength(1);
    expect(cues[0]?.startSec).toBe(2);
  });

  it('保留时间轴附加参数（如 line:90%）', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000 line:90%\n顶部字幕\n';
    const vtt = srtToVtt(srt);
    expect(vtt).toContain('line:90%');
    expect(parseVtt(vtt)[0]?.text).toBe('顶部字幕');
  });

  it('空输入返回仅含头的 VTT', () => {
    expect(srtToVtt('').trim()).toBe('WEBVTT');
    expect(parseVtt('WEBVTT\n')).toHaveLength(0);
  });

  it('忽略 NOTE 块与无文本 cue', () => {
    const vtt = 'WEBVTT\n\nNOTE 注释\n忽略我\n\n00:00:01.000 --> 00:00:02.000\n\n';
    expect(parseVtt(vtt)).toHaveLength(0);
  });

  it('parseTimestamp 支持 h:mm:ss / mm:ss / 秒', () => {
    expect(parseTimestamp('01:02:03.500')).toBeCloseTo(3723.5, 3);
    expect(parseTimestamp('02:03.500')).toBeCloseTo(123.5, 3);
    expect(parseTimestamp('12.5')).toBeCloseTo(12.5, 3);
    expect(Number.isNaN(parseTimestamp('abc'))).toBe(true);
  });

  it('decodeSubtitle 正确识别 UTF-8 BOM 中文（AC-45 不乱码）', () => {
    const text = '中文测试';
    const bytes = new TextEncoder().encode(`\uFEFF${text}`);
    const decoded = decodeSubtitle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(decoded.replace('\uFEFF', '')).toBe(text);
  });
});

describe('SubtitleManager', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n第一句\n\n00:00:05.000 --> 00:00:07.000\n第二句\n';

  function makeManager(): SubtitleManager {
    return new SubtitleManager({
      fetchText: async () => ({ text: vtt, format: 'vtt' }),
    });
  }

  it('切换轨道后按时间命中对应字幕', async () => {
    const manager = makeManager();
    manager.setTracks([
      { id: 'zh', label: '简体中文', lang: 'zh', url: 'x', format: 'vtt', source: 'remote' },
    ]);
    await manager.setActive('zh');

    expect(manager.textAt(2)).toBe('第一句');
    expect(manager.textAt(4)).toBe('');
    expect(manager.textAt(5.5)).toBe('第二句');
    expect(manager.textAt(0.5)).toBe('');
  });

  it('offsetSec 平移查找基准，且不修改 cue 原始时间', async () => {
    const manager = makeManager();
    manager.setTracks([{ id: 'zh', label: '中文', lang: 'zh', url: 'x', format: 'vtt', source: 'remote' }]);
    await manager.setActive('zh');

    manager.setOffset(2);
    // 偏移 +2s：真实时间 0 落在 cue(1~3) 的窗口内；真实时间 -1 → 1 恰好是起点
    expect(manager.textAt(0)).toBe('第一句');
    expect(manager.textAt(-1)).toBe('第一句');
    // 真实时间 -3 → -1，早于 cue 起点
    expect(manager.textAt(-3)).toBe('');
    // cue 原始时间未被修改（AC-45 的 OriginalTime 完整性）
    expect(manager.getCues('zh')[0]?.startSec).toBe(1);
  });

  it('关闭字幕（null）后不再返回文本，播放不受影响', async () => {
    const manager = makeManager();
    manager.setTracks([{ id: 'zh', label: '中文', lang: 'zh', url: 'x', format: 'vtt', source: 'remote' }]);
    await manager.setActive('zh');
    expect(manager.textAt(2)).not.toBe('');
    await manager.setActive(null);
    expect(manager.textAt(2)).toBe('');
    expect(manager.getActiveId()).toBeNull();
  });

  it('字幕内容无法解析时抛 E_PARSE（不阻断播放）', async () => {
    const manager = new SubtitleManager({ fetchText: async () => ({ text: 'not a vtt', format: 'vtt' }) });
    manager.setTracks([{ id: 'bad', label: '坏字幕', lang: 'zh', url: 'x', format: 'vtt', source: 'remote' }]);
    await expect(manager.setActive('bad')).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('拉取网络失败时抛 E_NETWORK', async () => {
    const manager = new SubtitleManager({
      fetchText: async () => {
        throw new Error('boom');
      },
    });
    manager.setTracks([{ id: 'zh', label: '中文', lang: 'zh', url: 'x', format: 'vtt', source: 'remote' }]);
    await expect(manager.setActive('zh')).rejects.toMatchObject({ code: 'E_NETWORK' });
  });
});
