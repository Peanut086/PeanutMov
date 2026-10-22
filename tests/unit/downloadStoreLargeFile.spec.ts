import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDownloadStore } from '@/stores/downloadStore';
import { downloadService } from '@/services/downloadService';
import { DOWNLOAD_WEB_SIZE_WARN_BYTES } from '@/shared/constants';
import type { CreateDownloadInput } from '@/types';
import { resetAll } from './helpers';

/**
 * REV-07 / AC-76：Web 端 1GB 前置提示
 *
 * `downloadService.preflightSize` 用 HEAD 取 `Content-Length`，
 * `needsAppForLargeFile` 只在非原生且 >1GB 时为真。这里只验证 store 的编排
 * （预检 → 阈值判定 → 文案），不重复断言 service 的内部实现。
 */
const GB = 1024 * 1024 * 1024;

function makeInput(url: string): CreateDownloadInput {
  return {
    sourceId: 'src-1',
    mediaId: 'media-1',
    episodeId: 'ep-1',
    episodeNumber: 1,
    title: '测试影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url,
    format: 'mp4',
  };
}

describe('downloadStore.checkLargeFile（REV-07 / AC-76）', () => {
  beforeEach(async () => {
    await resetAll();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Web 端单文件超过 1GB → 返回改用 App 的提示', async () => {
    vi.spyOn(downloadService, 'preflightSize').mockResolvedValue(GB + 1024);
    const store = useDownloadStore();

    const hint = await store.checkLargeFile([makeInput('https://cdn.example.com/big.mp4')]);

    expect(hint).toContain('1GB');
    expect(hint).toContain('App');
    expect(hint).toContain('1 个文件');
  });

  it('小于阈值 → 无提示（null）', async () => {
    vi.spyOn(downloadService, 'preflightSize').mockResolvedValue(512 * 1024 * 1024);
    const store = useDownloadStore();

    expect(await store.checkLargeFile([makeInput('https://cdn.example.com/small.mp4')])).toBeNull();
  });

  it('多个文件时给出超限数量与最大体积', async () => {
    vi.spyOn(downloadService, 'preflightSize')
      .mockResolvedValueOnce(GB + 1)
      .mockResolvedValueOnce(2 * GB)
      .mockResolvedValueOnce(1024);
    const store = useDownloadStore();

    const hint = await store.checkLargeFile([
      makeInput('https://cdn.example.com/a.mp4'),
      makeInput('https://cdn.example.com/b.mp4'),
      makeInput('https://cdn.example.com/c.mp4'),
    ]);

    expect(hint).toContain('2 个文件');
    expect(hint).toContain(`${2 * GB} 字节`);
  });

  it('体积未知（HEAD 被禁 / 无 Content-Length）→ 放行不提示', async () => {
    vi.spyOn(downloadService, 'preflightSize').mockResolvedValue(null);
    const store = useDownloadStore();

    expect(await store.checkLargeFile([makeInput('https://cdn.example.com/unknown.mp4')])).toBeNull();
  });

  it('预检抛错不阻断下载 → 返回 null', async () => {
    vi.spyOn(downloadService, 'preflightSize').mockRejectedValue(new Error('CORS blocked'));
    const store = useDownloadStore();

    expect(await store.checkLargeFile([makeInput('https://cdn.example.com/x.mp4')])).toBeNull();
  });

  it('空入参直接返回 null，不发任何 HEAD 请求', async () => {
    const spy = vi.spyOn(downloadService, 'preflightSize');
    const store = useDownloadStore();

    expect(await store.checkLargeFile([])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('阈值与常量一致（1GB）', async () => {
    expect(DOWNLOAD_WEB_SIZE_WARN_BYTES).toBe(GB);
  });
});
