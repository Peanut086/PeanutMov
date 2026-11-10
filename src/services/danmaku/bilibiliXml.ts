/**
 * B 站弹幕 XML 解析（纯函数）
 *
 * `<d p="time,mode,size,color,timestamp,pool,uid,rowid">文本</d>`；
 * 兼容 CIDATA 包裹与属性引号缺失的宽松形态。
 */
import { danmakuPerf } from '@/shared/danmakuPerf';
import type { DanmakuComment } from '@/types';

/** 模式映射（dandanplay/B 站惯例：1~3 滚动、4 底部、5 顶部） */
export function modeOf(raw: number): DanmakuComment['mode'] {
  if (raw === 4) return 'bottom';
  if (raw === 5) return 'top';
  return 'scroll';
}

function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/gi, '&');
}

export function parseBilibiliXml(xml: string): DanmakuComment[] {
  const perfStart = performance.now();
  const out: DanmakuComment[] = [];
  const pattern = /<d\s+[^>]*p\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/d\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const parts = (match[1] ?? '').split(',');
    const text = unescapeXmlText(match[2] ?? '').trim();
    const time = Number.parseFloat(parts[0] ?? '');
    if (!Number.isFinite(time) || text.length === 0) continue;
    const rawMode = Number.parseInt(parts[1] ?? '1', 10) || 1;
    const color = Number.parseInt(parts[3] ?? '16777215', 10) || 0xffffff;
    out.push({ time, mode: modeOf(rawMode), color, text });
  }
  danmakuPerf.recordLoadPhase('bilibili.parseXml', performance.now() - perfStart, out.length);
  return out;
}
