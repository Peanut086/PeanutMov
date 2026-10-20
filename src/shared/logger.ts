/**
 * 分级日志（SCF 冻结，PKG-B 只读）
 *
 * - 生产构建关闭 debug（vite 的 `import.meta.env.DEV` 为 false）
 * - 默认对 URL 中的 token/password 参数脱敏（技术方案 13 章）
 * - 不依赖任何第三方日志库
 */
import { redactUrl } from '@/shared/url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isDev(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function debugEnabledByEnv(): boolean {
  try {
    return import.meta.env?.VITE_DEBUG_LOG === '1';
  } catch {
    return false;
  }
}

/** 模块级级别：开发环境 debug，生产 info */
let currentLevel: LogLevel = isDev() || debugEnabledByEnv() ? 'debug' : 'info';

/** 模块级前缀，便于过滤（如 'library'、'download'、'player'） */
let currentScope = 'app';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setLogScope(scope: string): void {
  currentScope = scope;
}

/** 递归脱敏：字符串中的敏感 query 参数、Error 转 message、其余原样 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (typeof value === 'string') return redactUrl(value);
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: isDev() ? value.stack : undefined };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|password|pwd|authorization|cookie|api_?key/i.test(k)) {
        out[k] = v === null || v === undefined ? v : '***';
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, message: string, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
  const prefix = `[${currentScope}]`;
  const payload = args.map((a) => sanitize(a));
  const consoleObj = typeof console !== 'undefined' ? console : undefined;
  if (!consoleObj) return;
  switch (level) {
    case 'debug':
      consoleObj.debug(prefix, message, ...payload);
      break;
    case 'info':
      consoleObj.info(prefix, message, ...payload);
      break;
    case 'warn':
      consoleObj.warn(prefix, message, ...payload);
      break;
    case 'error':
      consoleObj.error(prefix, message, ...payload);
      break;
  }
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** 派生带固定前缀的子 logger */
  scope(name: string): Logger;
}

function makeLogger(scopeName: string): Logger {
  return {
    debug: (message, ...args) => {
      const prev = currentScope;
      currentScope = scopeName;
      emit('debug', message, args);
      currentScope = prev;
    },
    info: (message, ...args) => {
      const prev = currentScope;
      currentScope = scopeName;
      emit('info', message, args);
      currentScope = prev;
    },
    warn: (message, ...args) => {
      const prev = currentScope;
      currentScope = scopeName;
      emit('warn', message, args);
      currentScope = prev;
    },
    error: (message, ...args) => {
      const prev = currentScope;
      currentScope = scopeName;
      emit('error', message, args);
      currentScope = prev;
    },
    scope: (name: string) => makeLogger(`${scopeName}:${name}`),
  };
}

export const logger: Logger = makeLogger('app');
