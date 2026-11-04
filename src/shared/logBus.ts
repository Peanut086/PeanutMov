/**
 * JS 日志总线（P1）
 *
 * 职责：
 * 1. 包装 console.*，捕获所有 JS 日志（含 logger.* 和裸 console.*）
 * 2. 捕获 window.onerror / unhandledrejection
 * 3. 环形缓冲（2000 条），供 Web 环境直接查看
 * 4. 批量转发到原生 SpiderLogStore（500ms / 32 条一批）
 * 5. 脱敏（URL token/password、对象 key）
 * 6. 防递归（内部错误不走 logger）
 */
import { logApi, type LogEntry } from '@/native/logs';
import { redactUrl } from '@/shared/url';
import { isNative } from '@/shared/platform';

export type LogLevel = 'D' | 'I' | 'W' | 'E';

export interface LogBusEntry extends LogEntry {
  id: string;
}

const MAX_BUFFER = 2000;
const BATCH_INTERVAL = 500;
const BATCH_SIZE = 32;
const MAX_MESSAGE_LEN = 4096;

let buffer: LogBusEntry[] = [];
let nextId = 1;
let inCapture = false;
let batchTimer: number | null = null;
let batchQueue: LogEntry[] = [];

// 原始 console 引用（防递归）
const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/**
 * 安装 console 捕获（在 main.ts 启动时调用）
 */
export function installConsoleCapture(): void {
  if (typeof console === 'undefined') return;

  console.debug = (...args: unknown[]) => {
    capture('D', args);
    originalConsole.debug(...args);
  };
  console.info = (...args: unknown[]) => {
    capture('I', args);
    originalConsole.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    capture('W', args);
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    capture('E', args);
    originalConsole.error(...args);
  };

  // 全局错误捕获
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      const msg = event.error?.stack || event.message || 'Unknown error';
      capture('E', ['JS:error', msg], true);
    });
    window.addEventListener('unhandledrejection', (event) => {
      const msg = event.reason?.stack || String(event.reason) || 'Unhandled rejection';
      capture('E', ['JS:rejection', msg], true);
    });
  }
}

/**
 * 捕获日志条目
 */
function capture(level: LogLevel, args: unknown[], isError = false): void {
  if (inCapture) return; // 防递归
  inCapture = true;
  try {
    const { tag, message } = parseArgs(args, isError);
    const entry: LogBusEntry = {
      id: String(nextId++),
      level,
      tag,
      message,
      ts: Date.now(),
    };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) {
      buffer = buffer.slice(-MAX_BUFFER);
    }
    batchQueue.push(entry);
    scheduleBatch();
  } catch (e) {
    // 内部错误静默，避免死循环
    originalConsole.error('logBus capture failed', e);
  } finally {
    inCapture = false;
  }
}

/**
 * 解析参数为 tag + message
 */
function parseArgs(args: unknown[], isError: boolean): { tag: string; message: string } {
  if (args.length === 0) return { tag: 'app', message: '' };

  let tag = 'app';
  let messageParts: unknown[] = args;

  // 第一个参数如果是 [scope] 形式，解析为 tag
  if (typeof args[0] === 'string' && /^\[.+\]$/.test(args[0])) {
    tag = (args[0] as string).slice(1, -1);
    messageParts = args.slice(1);
  } else if (isError) {
    tag = 'error';
  }

  const message = messageParts.map((a) => serialize(a)).join(' ');
  return { tag, message: truncate(message, MAX_MESSAGE_LEN) };
}

/**
 * 序列化参数为字符串（脱敏）
 */
function serialize(value: unknown, depth = 0): string {
  if (depth > 4) return '[depth-limit]';
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return redactUrl(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => serialize(v, depth + 1)).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (/token|password|pwd|authorization|cookie|api_?key/i.test(k)) {
        entries.push(`"${k}": "***"`);
      } else {
        entries.push(`"${k}": ${serialize(v, depth + 1)}`);
      }
    }
    return '{' + entries.join(', ') + '}';
  }
  return String(value);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(截断 ${s.length - max} 字节)`;
}

/**
 * 调度批量转发
 */
function scheduleBatch(): void {
  if (batchTimer !== null) return;
  if (batchQueue.length >= BATCH_SIZE) {
    flushBatch();
  } else {
    batchTimer = window.setTimeout(flushBatch, BATCH_INTERVAL);
  }
}

/**
 * 刷新批次
 */
function flushBatch(): void {
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (batchQueue.length === 0) return;
  const batch = batchQueue.splice(0, BATCH_SIZE);
  if (isNative()) {
    logApi.appendLogs(batch, 'JS').catch((e) => {
      originalConsole.warn('appendLogs failed', e);
    });
  }
  // 如果还有剩余，继续调度
  if (batchQueue.length > 0) {
    scheduleBatch();
  }
}

/**
 * 获取当前缓冲（供 Web 环境查看页使用）
 */
export function getBuffer(): LogBusEntry[] {
  return buffer.slice();
}

/**
 * 清空缓冲
 */
export function clearBuffer(): void {
  buffer = [];
  batchQueue = [];
}
