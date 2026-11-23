/**
 * 一次播放决策链的诊断包（OPT-26 / P2-⑬）
 *
 * 排查「这一集今天播不了」时，事实分散在四个地方：解析在 `libraryService` 分档、
 * 引擎选择在 `PlayerController`、兜底在 `PlayerView.runFailover`、弹幕在 `fetchDanmaku`。
 * 日志虽然都落了，但要用户先连电脑、再从几千行里把这一次起播的那一段挑出来——
 * 真机上多数问题就是这么漏掉的。
 *
 * 这里不新增日志通道，只在**决策发生的那一处**记一条结构化事件（一条链上限 120 条），
 * 导出时把「目标 + 读数 + 链路 + 窗口内日志」拼成一段可直接贴进 issue 的文本。
 * 三条约束：
 *
 * - 窗口按「条目 + 集号」归并：兜底链会换线、换源、重解析，那是**同一次决策链**，
 *   不能因为又跑了一遍 `resolveAndLoad` 就把前面的失败抹掉；换集才开新窗口。
 * - 只记不判：这里不重新推断原因（分档口径在 `sourceFailure`），避免两处结论打架。
 * - 纯内存、不落盘、不上传：诊断包只在用户主动点「导出」时才组装，地址按现有口径脱敏。
 */
import { getBuffer } from '@/shared/logBus';
import { redactUrl } from '@/shared/url';

export const PLAY_TRACE_VERSION = 1;

/** 决策链上的六个环节，与排查时的读法一致 */
export type TraceStage = 'attempt' | 'resolve' | 'engine' | 'error' | 'failover' | 'danmaku' | 'stall';

export type TraceValue = string | number | boolean | null;

export interface TraceEvent {
  at: number;
  stage: TraceStage;
  /** 一句话事实，读的人不必再翻代码就能对上号 */
  text: string;
  fields?: Record<string, TraceValue>;
}

export interface TraceTarget {
  mediaId: string;
  title: string;
  episodeNumber: number | null;
  episodeId: string | null;
  lineId: string | null;
  lineName: string | null;
}

export interface PlayTraceReport {
  version: number;
  generatedAt: number;
  windowStartedAt: number;
  windowMs: number;
  target: TraceTarget | null;
  events: TraceEvent[];
  /** 现场读数（由调用方组装：引擎、位置、地址寿命、缓存口径等） */
  readings: Record<string, TraceValue> | null;
  /** 窗口内的相关日志行（已按现有口径脱敏） */
  logLines: string[];
}

const MAX_EVENTS = 120;
/** 单条事件里字段值的长度上限：诊断包是给人读的，不能变成日志转储 */
const MAX_VALUE_LEN = 160;
const DEFAULT_LOG_LIMIT = 120;

/**
 * 决策链 info 行的前缀白名单。
 *
 * 窗口里的 debug/info 绝大多数与这次起播无关（预热、UI、弹幕心跳）；
 * 这几条前缀恰好是「链路上做过的决定」，捞出来才不用在几千行里翻。
 */
const INFO_PREFIXES = ['兜底链', '播放地址', '在线流停滞', '弹幕', '引擎'];

let events: TraceEvent[] = [];
let target: TraceTarget | null = null;
let windowStartedAt = 0;

function clip(value: TraceValue): TraceValue {
  if (typeof value !== 'string' || value.length <= MAX_VALUE_LEN) return value;
  return `${value.slice(0, MAX_VALUE_LEN)}…（已截断）`;
}

function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}

/** `2026-11-23 14:22:31.500`，与原生落盘格式同口径 */
export function formatTraceTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'N/A';
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds())}`
  );
}

export const playTraceService = {
  /**
   * 一轮起播开始。同条目同集号 = 同一条链（兜底换线/重解析都续写），换集或换条目才开新窗口。
   */
  beginAttempt(next: TraceTarget): boolean {
    const continues =
      target !== null && target.mediaId === next.mediaId && target.episodeNumber === next.episodeNumber;
    if (continues) {
      // 线路/集 id 会随兜底漂移，读数按最新一次为准，但时间轴与已记事件保留
      target = next;
      return false;
    }
    target = next;
    events = [];
    windowStartedAt = Date.now();
    return true;
  },

  note(stage: TraceStage, text: string, fields?: Record<string, TraceValue>): void {
    if (target === null) return;
    const event: TraceEvent = { at: Date.now(), stage, text };
    if (fields && Object.keys(fields).length > 0) {
      const clipped: Record<string, TraceValue> = {};
      for (const [key, value] of Object.entries(fields)) clipped[key] = clip(value);
      event.fields = clipped;
    }
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  },

  targetOf(): TraceTarget | null {
    return target;
  },

  windowStartedAt(): number {
    return windowStartedAt;
  },

  eventsOf(): TraceEvent[] {
    return events.slice();
  },

  /**
   * 组装诊断包。`readings` 由调用方给（这一层拿不到引擎状态与地址寿命的语义），
   * `logLines` 缺省时按窗口时间从日志总线现捞。
   */
  buildReport(opts?: {
    readings?: Record<string, TraceValue> | null;
    logLines?: string[];
    now?: number;
  }): PlayTraceReport {
    const now = opts?.now ?? Date.now();
    return {
      version: PLAY_TRACE_VERSION,
      generatedAt: now,
      windowStartedAt,
      windowMs: Math.max(0, now - windowStartedAt),
      target,
      events: events.slice(),
      readings: opts?.readings ?? null,
      logLines: opts?.logLines ?? collectTraceLogLines(windowStartedAt),
    };
  },

  /** 测试辅助：清空整条链 */
  __reset(): void {
    events = [];
    target = null;
    windowStartedAt = 0;
  },
};

/**
 * 窗口内与这次起播有关的日志行。
 *
 * 取法是「全收 W/E + 只收决策链前缀的 I」：W/E 是用户不会主动看但排查必需的那一半，
 * 决策链 info 行给出的是判断依据。总线里的消息已按 `logBus` 的口径脱敏过，
 * 这里再脱敏一次兜底（第三方桥透传的原文可能带 token）。
 */
export function collectTraceLogLines(sinceAt: number, limit = DEFAULT_LOG_LIMIT): string[] {
  if (!sinceAt) return [];
  const picked: string[] = [];
  for (const entry of getBuffer()) {
    if (entry.ts < sinceAt) continue;
    const isWarnOrError = entry.level === 'W' || entry.level === 'E';
    if (!isWarnOrError && !(entry.level === 'I' && INFO_PREFIXES.some((prefix) => entry.message.startsWith(prefix)))) {
      continue;
    }
    picked.push(`${formatTraceTs(entry.ts)} ${entry.level} [${entry.tag}] ${redactUrl(entry.message)}`);
    if (picked.length >= limit) break;
  }
  return picked;
}

function line(value: string, indent = ''): string {
  return `${indent}${value}\n`;
}

/** 诊断包 → 人读的纯文本（可直接贴进 issue / 群聊） */
export function formatPlayTraceText(report: PlayTraceReport): string {
  const out: string[] = [];
  out.push(line(`PeanutMov 播放诊断（决策链）v${report.version}`));
  out.push(
    line(
      `生成 ${formatTraceTs(report.generatedAt)}｜窗口起点 ${formatTraceTs(report.windowStartedAt)}` +
        `｜跨度 ${(report.windowMs / 1000).toFixed(1)}s`,
    ),
  );

  const t = report.target;
  out.push(line(''));
  out.push(
    line(
      t === null
        ? '【目标】本次会话还没有起播过（没有可复盘的决策链）'
        : `【目标】${t.title}｜${t.episodeNumber === null ? '正片' : `第 ${t.episodeNumber} 集`}` +
            `｜线路「${t.lineName ?? '未记录'}」`,
    ),
  );
  if (t !== null) {
    out.push(line(`media=${t.mediaId} episode=${t.episodeId ?? 'N/A'} line=${t.lineId ?? 'N/A'}`, '  '));
  }

  if (report.readings && Object.keys(report.readings).length > 0) {
    out.push(line('【读数】'));
    for (const [key, value] of Object.entries(report.readings)) {
      out.push(line(`${key}: ${value === null ? 'N/A' : String(value)}`, '  '));
    }
  }

  out.push(line('【链路】'));
  if (report.events.length === 0) out.push(line('（没有记录到决策事件）', '  '));
  for (const event of report.events) {
    const offset = `+${(event.at - report.windowStartedAt)}ms`;
    out.push(line(`${formatTraceTs(event.at)} ${offset.padStart(9)} ${event.stage}｜${event.text}`));
    if (event.fields) {
      for (const [key, value] of Object.entries(event.fields)) {
        out.push(line(`${key}=${value === null ? 'N/A' : String(value)}`, '    '));
      }
    }
  }

  out.push(line('【窗口内相关日志】'));
  if (report.logLines.length === 0) out.push(line('（无 W/E 或决策链 info 行）', '  '));
  for (const text of report.logLines) out.push(line(text, '  '));

  out.push(line(''));
  out.push(line('注：地址按现有日志口径脱敏（token/password 已去掉），host 与路径保留原样。'));
  return out.join('');
}

/**
 * 把诊断包交出去：原生走系统分享面板，取消或失败退到剪贴板，两条都不成才报失败。
 *
 * 返回结果而不是抛错——用户在分享面板按了「取消」不是故障，不该看到红条。
 */
export async function sharePlayTraceText(text: string): Promise<'shared' | 'copied' | 'failed'> {
  try {
    const { isNative } = await import('@/shared/platform');
    if (isNative()) {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: 'PeanutMov 播放诊断', text, dialogTitle: '分享诊断包' });
      return 'shared';
    }
  } catch {
    // 分享面板被用户取消或插件不可用：落到剪贴板，用户至少拿到可粘贴的文本
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
