/**
 * 轻量事件总线（技术方案 3.9）
 *
 * 用途：Store/UI 订阅数据层变化（`sources:changed`、`history:changed`、`download` 等）。
 * 约束：
 * - 同步派发，处理器异常被捕获并记录日志，不影响其它订阅者；
 * - 订阅返回取消函数；
 * - 不持有 DOM 引用，服务层可直接使用。
 */
import { logger } from '@/shared/logger';

export type AppEventMap = {
  'sources:changed': { reason: 'create' | 'update' | 'remove' | 'enable' | 'reorder' | 'default' | 'import' | 'restore' };
  'sources:health': { sourceId: string; health: string };
  /** 批量测速进度（CHG-05 / AC-107）：起点 {0,total}，逐源 +1，终点 {total,total} */
  'sources:healthProgress': { done: number; total: number };
  'library:changed': { sourceId: string };
  'history:changed': { id: string | null };
  'favorites:changed': { id: string | null };
  'downloads:changed': { id: string | null };
  /** 已下载任务但本地文件/Blob 丢失（AC-78 / REV-23）：UI 提示并提供「重新下载」 */
  'local:missing': { taskId: string; mediaId: string; episodeId: string; text: string };
  'settings:changed': { patch: Record<string, unknown> };
  'toast': { text: string; type: 'info' | 'success' | 'error' };
  /** 播放链路阶段上报（问题一/问题二：进度条 + 重试提示） */
  'play:stage': { stage: 'resolving' | 'preparing' | 'connecting' | 'buffering' | 'retrying' | 'done'; detail?: string };
};

export type AppEventName = keyof AppEventMap;
type Handler<K extends AppEventName> = (payload: AppEventMap[K]) => void;

class EventBus {
  private readonly handlers = new Map<AppEventName, Set<(payload: never) => void>>();

  on<K extends AppEventName>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      this.off(event, handler);
    };
  }

  off<K extends AppEventName>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as (payload: never) => void);
  }

  emit<K extends AppEventName>(event: K, payload: AppEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<K>)(payload);
      } catch (e) {
        logger.warn('事件处理器异常', event, e);
      }
    }
  }

  /** 测试辅助：清空全部订阅 */
  clear(): void {
    this.handlers.clear();
  }
}

export const appEvents = new EventBus();
