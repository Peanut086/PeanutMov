/**
 * 日志行解析器（纯函数）
 *
 * 解析原生 SpiderLogStore 写入的日志格式：
 * `2026-11-04 12:00:00.123 D [main] Tag: message`
 *
 * 续行（无时间戳前缀）归并到上一条的 message。
 */

export type LogLevel = 'D' | 'I' | 'W' | 'E' | 'F';

export interface LogEntry {
  /** 唯一 ID（文件:行号） */
  id: string;
  /** 时间戳（毫秒） */
  ts: number;
  /** 级别 */
  level: LogLevel;
  /** 线程名 */
  thread: string;
  /** 标签 */
  tag: string;
  /** 消息（含续行） */
  message: string;
  /** 原始行 */
  raw: string;
}

const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) ([DIWEF]) \[([^\]]+)\] ([^:]+): (.*)$/;

/**
 * 解析日志文本为条目数组。
 *
 * @param text 日志文件内容（可能含多行）
 * @param fileName 文件名（用于生成 ID）
 * @param startOffset 起始字节偏移（用于生成 ID）
 */
export function parseLogText(text: string, fileName = '', startOffset = 0): LogEntry[] {
  const lines = text.split('\n');
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;
  let lineNo = 0;

  for (const line of lines) {
    if (!line) continue;
    lineNo++;
    const match = LOG_LINE_RE.exec(line);
    if (match) {
      // 新条目
      if (current) entries.push(current);
      const [, tsStr, level, thread, tag, message] = match;
      current = {
        id: `${fileName}:${startOffset + lineNo}`,
        ts: parseTimestamp(tsStr),
        level: level as LogLevel,
        thread,
        tag,
        message,
        raw: line,
      };
    } else if (current) {
      // 续行
      current.message += '\n' + line;
      current.raw += '\n' + line;
    } else {
      // 无时间戳且无当前条目（文件开头或损坏行）
      current = {
        id: `${fileName}:${startOffset + lineNo}`,
        ts: 0,
        level: 'D',
        thread: '',
        tag: '-',
        message: line,
        raw: line,
      };
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * 解析时间戳字符串为毫秒。
 * 格式：`2026-11-04 12:00:00.123`
 */
function parseTimestamp(ts: string): number {
  // 简单实现：直接 new Date()，浏览器会解析
  const d = new Date(ts.replace(' ', 'T'));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * 按级别过滤。
 *
 * @param entries 条目数组
 * @param levels 允许的级别集合（空集合表示全部）
 */
export function filterByLevel(entries: LogEntry[], levels: Set<LogLevel>): LogEntry[] {
  if (levels.size === 0) return entries;
  return entries.filter((e) => levels.has(e.level));
}

/**
 * 按标签过滤。
 *
 * @param entries 条目数组
 * @param tags 允许的标签集合（空集合表示全部）
 */
export function filterByTag(entries: LogEntry[], tags: Set<string>): LogEntry[] {
  if (tags.size === 0) return entries;
  return entries.filter((e) => tags.has(e.tag));
}

/**
 * 按关键字搜索（不区分大小写）。
 *
 * @param entries 条目数组
 * @param keyword 关键字
 */
export function search(entries: LogEntry[], keyword: string): LogEntry[] {
  if (!keyword) return entries;
  const lower = keyword.toLowerCase();
  return entries.filter((e) => e.message.toLowerCase().includes(lower) || e.tag.toLowerCase().includes(lower));
}

/**
 * 提取所有标签及计数。
 */
export function extractTags(entries: LogEntry[]): Map<string, number> {
  const tags = new Map<string, number>();
  for (const e of entries) {
    tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1);
  }
  return tags;
}

/**
 * 格式化条目为可读字符串（用于复制/分享）。
 */
export function formatEntry(entry: LogEntry): string {
  const ts = entry.ts > 0 ? new Date(entry.ts).toISOString() : 'N/A';
  return `${ts} ${entry.level} [${entry.thread}] ${entry.tag}: ${entry.message}`;
}
