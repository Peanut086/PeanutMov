import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { isNativeDownloadAvailable } from '@/native/downloadPlugin';
import type {
  NativeDownloadStatus,
  NativeDownloadTask,
  NativeProgressEvent,
} from '@/native/downloadPlugin';

// Mock isNative to return false (web environment)
vi.mock('@/shared/platform', () => ({
  isNative: vi.fn(() => false),
}));

describe('Native 下载插件（Phase 1）', () => {
  beforeEach(async () => {
    await resetAll();
    vi.clearAllMocks();
  });

  describe('可用性检测', () => {
    it('isNativeDownloadAvailable() 在 Web 环境返回 false', async () => {
      const available = await isNativeDownloadAvailable();
      expect(available).toBe(false);
    });
  });

  describe('接口契约', () => {
    it('导出函数存在', async () => {
      const module = await import('@/native/downloadPlugin');
      expect(typeof module.isNativeDownloadAvailable).toBe('function');
      expect(typeof module.nativeDownloadStart).toBe('function');
      expect(typeof module.nativeDownloadPause).toBe('function');
      expect(typeof module.nativeDownloadCancel).toBe('function');
      expect(typeof module.nativeDownloadGetStatus).toBe('function');
      expect(typeof module.onProgress).toBe('function');
      expect(typeof module.onCompleted).toBe('function');
      expect(typeof module.onError).toBe('function');
    });

    it('onProgress 返回取消订阅函数', async () => {
      const module = await import('@/native/downloadPlugin');
      const unsubscribe = module.onProgress(() => {});
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });

    it('onCompleted 返回取消订阅函数', async () => {
      const module = await import('@/native/downloadPlugin');
      const unsubscribe = module.onCompleted(() => {});
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });

    it('onError 返回取消订阅函数', async () => {
      const module = await import('@/native/downloadPlugin');
      const unsubscribe = module.onError(() => {});
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('类型定义', () => {
    it('NativeDownloadTask 接口正确', () => {
      const task: NativeDownloadTask = {
        taskId: 'test-1',
        url: 'https://example.com/video.mp4',
        filePath: 'downloads/video.mp4',
        headers: { 'User-Agent': 'test' },
        startBytes: 0,
        totalBytes: 1000000,
      };
      expect(task.taskId).toBe('test-1');
    });

    it('NativeDownloadStatus 接口正确', () => {
      const status: NativeDownloadStatus = {
        taskId: 'test-1',
        state: 'downloading',
        downloadedBytes: 500000,
        totalBytes: 1000000,
        speedBps: 100000,
        errorCode: undefined,
        errorMessage: undefined,
      };
      expect(status.state).toBe('downloading');
    });

    it('NativeProgressEvent 接口正确', () => {
      const event: NativeProgressEvent = {
        taskId: 'test-1',
        downloadedBytes: 500000,
        totalBytes: 1000000,
        speedBps: 100000,
      };
      expect(event.speedBps).toBe(100000);
    });
  });
});
