/**
 * 日志管理 API 封装
 *
 * 把原生 `Spider` 插件的日志方法包成业务侧可直接调用的薄层，
 * 统一处理"插件缺失 / Web 环境 / 调用失败"等异常路径，返回 `{ ok, reason }`
 * 或带默认值的结构，调用方（SettingsView）无需 try/catch。
 */
import { Spider } from '@/native/spiderPlugin';
import { logger, setLogLevel } from '@/shared/logger';

export interface DebugLogStatus {
  enabled: boolean;
  fileCount: number;
  totalBytes: number;
  retentionDays: number;
}

export interface CleanResult {
  cleanedCount: number;
  freedBytes: number;
}

export interface LogFile {
  name: string;
  size: number;
  mtime: number;
}

export interface ExportResult {
  uri: string;
  path: string;
  size: number;
}

export interface TailResult {
  file: string;
  size: number;
  offset: number;
  text: string;
  reset: boolean;
}

export interface RangeResult {
  file: string;
  /** 全文字符数 */
  size: number;
  /** 下一次读取的字符偏移 */
  offset: number;
  /** eof 时的明文字节游标（readTail 续读用），gz 为 -1 */
  byteOffset: number;
  text: string;
  eof: boolean;
}

export interface LogEntry {
  level: 'D' | 'I' | 'W' | 'E';
  tag: string;
  message: string;
  ts: number;
}

export interface CrashEvent {
  id: string;
  /** native / java / anr / killed / lomem / exit */
  kind: string;
  ts: number;
  source: string;
  title: string;
  detail: string;
}

/** 单事件全文：native `getCrashDetail` 只回 id/kind/ts/source/title/text，列表用的摘要字段不在其中 */
export interface CrashEventDetail extends Omit<CrashEvent, 'detail'> {
  text: string;
}

const EMPTY_STATUS: DebugLogStatus = {
  enabled: false,
  fileCount: 0,
  totalBytes: 0,
  retentionDays: 0,
};

export const logApi = {
  /** 获取日志状态（开关、文件数、总字节、保留天数） */
  async getStatus(): Promise<DebugLogStatus> {
    try {
      const r = await Spider.getDebugLogStatus();
      return {
        enabled: r.enabled ?? false,
        fileCount: r.fileCount ?? 0,
        totalBytes: r.totalBytes ?? 0,
        retentionDays: r.retentionDays ?? 7,
      };
    } catch (e) {
      logger.warn('获取日志状态失败', e);
      return { ...EMPTY_STATUS };
    }
  },

  /** 设置日志开关（同步更新 JS logger 级别） */
  async setEnabled(enabled: boolean): Promise<boolean> {
    try {
      const r = await Spider.setDebugLog({ enabled });
      const result = r.enabled ?? enabled;
      // P1：JS logger 级别联动（详细日志启用时允许 debug，否则 info）
      setLogLevel(result ? 'debug' : 'info');
      return result;
    } catch (e) {
      logger.warn('设置日志开关失败', e);
      throw e;
    }
  },

  /** 清理过期日志 */
  async clean(): Promise<CleanResult> {
    try {
      return await Spider.cleanLogs();
    } catch (e) {
      logger.warn('清理日志失败', e);
      throw e;
    }
  },

  /** 清空全部日志 */
  async clearAll(): Promise<void> {
    try {
      await Spider.clearAllLogs();
    } catch (e) {
      logger.warn('清空日志失败', e);
      throw e;
    }
  },

  /** 列出所有日志文件 */
  async listFiles(): Promise<LogFile[]> {
    try {
      const r = await Spider.listLogFiles();
      return r.files ?? [];
    } catch (e) {
      logger.warn('列出日志文件失败', e);
      return [];
    }
  },

  /** 导出日志（scope: all/crash/today/recent1h，合并为单文件，返回 FileProvider URI） */
  async export(scope: 'all' | 'crash' | 'today' | 'recent1h' = 'all'): Promise<ExportResult> {
    try {
      return await Spider.exportLogs({ scope });
    } catch (e) {
      logger.warn('导出日志失败', e);
      throw e;
    }
  },

  /** 增量读取日志文件尾部 */
  async readTail(file?: string, offset = 0, maxBytes = 256 * 1024): Promise<TailResult> {
    try {
      return await Spider.readLogTail({ file, offset, maxBytes });
    } catch (e) {
      logger.warn('读取日志失败', e);
      return { file: '', size: 0, offset: 0, text: '', reset: true };
    }
  },

  /** 全量读取日志文件（.gz 解压），按字符分块拉取 */
  async readRange(
    file?: string,
    offset = 0,
    maxBytes = 256 * 1024,
  ): Promise<RangeResult> {
    try {
      return await Spider.readLogRange({ file, offset, maxBytes });
    } catch (e) {
      logger.warn('全量读取日志失败', e);
      return { file: '', size: 0, offset: 0, byteOffset: -1, text: '', eof: true };
    }
  },

  /** 批量写入 JS 侧日志 */
  async appendLogs(entries: LogEntry[], source = 'JS'): Promise<void> {
    try {
      await Spider.appendLogs({ entries, source });
    } catch (e) {
      logger.warn('写入日志失败', e);
    }
  },

  /** 崩溃/退出事件列表（轻量卡片） */
  async getCrashEvents(): Promise<CrashEvent[]> {
    try {
      const r = await Spider.getCrashEvents();
      return r.events ?? [];
    } catch (e) {
      logger.warn('获取崩溃事件失败', e);
      return [];
    }
  },

  /** 单个崩溃事件全文 */
  async getCrashDetail(id: string): Promise<CrashEventDetail | null> {
    try {
      return await Spider.getCrashDetail({ id });
    } catch (e) {
      logger.warn('获取崩溃详情失败', e);
      return null;
    }
  },

  /** 单事件取证导出（返回可分享的文件路径） */
  async exportCrashEvent(id: string, windowMinutes = 5): Promise<ExportResult> {
    try {
      return await Spider.exportCrashEvent({ id, windowMinutes });
    } catch (e) {
      logger.warn('导出崩溃事件失败', e);
      throw e;
    }
  },
};

/**
 * P1：启动时恢复 JS logger 级别（根据原生存储的开关状态）
 * 在 bootstrap 中调用（initSettings 之后）
 */
export async function restoreLogLevel(): Promise<void> {
  try {
    const status = await logApi.getStatus();
    if (status.enabled) {
      setLogLevel('debug');
    }
  } catch (e) {
    // 静默失败，不影响启动
  }
}
