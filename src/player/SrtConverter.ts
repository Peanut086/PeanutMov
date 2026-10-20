/**
 * SRT → WebVTT 转换（纯函数，可单测）
 *
 * 处理要点（技术方案 9.2）：
 * - 去掉 UTF-8 BOM
 * - `\r\n` / `\r` 统一为 `\n`
 * - 时间轴 `00:00:01,500 --> 00:00:03,000` → `00:00:01.500 --> 00:00:03.000`
 * - 保留多行文本与 HTML 标签
 * - 可选 `position` 等附加参数会被保留（去掉逗号冲突）
 */

const BOM = '\uFEFF';

/** 规范化换行与 BOM */
export function normalizeText(input: string): string {
  const withoutBom = input.startsWith(BOM) ? input.slice(1) : input;
  return withoutBom.replace(/\r\n?/g, '\n');
}

/** 单个时间戳 `00:00:01,500` → `00:00:01.500`；已是点号则原样 */
export function convertTimecode(raw: string): string {
  const trimmed = raw.trim();
  // 支持可选的毫秒位（2 位补零到 3 位）
  return trimmed.replace(/(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})/g, (_m, hms: string, ms: string) => {
    return `${hms}.${ms.padEnd(3, '0')}`;
  });
}

/**
 * 把 SRT 文本转换为 WebVTT。
 * 输入为空或没有任何合法 cue 时，返回只含 `WEBVTT` 头的字符串。
 */
export function srtToVtt(input: string): string {
  const text = normalizeText(input ?? '');
  const blocks = text.split(/\n{2,}/);
  const cues: string[] = [];

  for (const rawBlock of blocks) {
    const lines = rawBlock.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ''));
    if (lines.length === 0) continue;

    // 定位时间轴行（SRT 的序号行可能缺失）
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex < 0) continue;

    const timing = lines[timingIndex] ?? '';
    const [startRaw, endPart = ''] = timing.split('-->');
    if (!startRaw || !endPart) continue;

    // 结束时间可能带附加参数（如 `line:90%`），拆出首个 token
    const endTokens = endPart.trim().split(/\s+/);
    const endRaw = endTokens[0] ?? '';
    if (!endRaw) continue;
    const extra = endTokens.slice(1).join(' ');

    const start = convertTimecode(startRaw);
    const end = convertTimecode(endRaw);
    const body = lines.slice(timingIndex + 1).join('\n').trim();
    if (body.length === 0) continue;

    cues.push(`${start} --> ${end}${extra ? ` ${extra}` : ''}\n${body}`);
  }

  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length > 0 ? '\n' : ''}`;
}

/**
 * 解析 VTT（或已转换的 SRT）为 cue 数组，供 `SubtitleManager` 自行渲染。
 *
 * 只处理最常见结构：`[id]\n start --> end [settings]\n text`；忽略 NOTE/STYLE/REGION。
 */
export interface ParsedCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** `00:01:02.500` / `01:02.500` / `62.5` → 秒 */
export function parseTimestamp(raw: string): number {
  const value = raw.trim();
  if (value.length === 0) return NaN;
  const parts = value.split(':');
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]?.replace(',', '.'));
    if (![h, m, s].every((n) => Number.isFinite(n))) return NaN;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]?.replace(',', '.'));
    if (![m, s].every((n) => Number.isFinite(n))) return NaN;
    return m * 60 + s;
  }
  const only = Number(value.replace(',', '.'));
  return Number.isFinite(only) ? only : NaN;
}

export function parseVtt(input: string): ParsedCue[] {
  const text = normalizeText(input ?? '');
  const body = text.replace(/^WEBVTT[^\n]*\n?/, '');
  const blocks = body.split(/\n{2,}/);
  const cues: ParsedCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length === 0) continue;
    const first = (lines[0] ?? '').trim();
    if (first.startsWith('NOTE') || first.startsWith('STYLE') || first.startsWith('REGION')) continue;

    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex] ?? '';
    const [startRaw, endPart = ''] = timing.split('-->');
    const endRaw = endPart.trim().split(/\s+/)[0] ?? '';
    const startSec = parseTimestamp(startRaw ?? '');
    const endSec = parseTimestamp(endRaw);
    const content = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim();
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || content.length === 0) continue;
    cues.push({ startSec, endSec, text: content });
  }

  cues.sort((a, b) => a.startSec - b.startSec);
  return cues;
}

/** 二进制/文本 → 字符串的编码探测（UTF-8 → GBK） */
export function decodeSubtitle(buffer: ArrayBuffer): string {
  const utf8 = tryDecode(buffer, 'utf-8', true);
  if (utf8 !== null) return utf8;
  const gbk = tryDecode(buffer, 'gbk', true);
  if (gbk !== null) return gbk;
  // 最后兜底：宽容解码（避免整条字幕不可用）
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

function tryDecode(buffer: ArrayBuffer, label: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(buffer);
  } catch {
    return null;
  }
}
