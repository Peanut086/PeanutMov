import { describe, expect, it, vi } from 'vitest';

import type { SubtitleTrack } from '@/types';
import { SubtitleManager } from '@/player/SubtitleManager';

/**
 * 字幕加载失败标记（AC-46 / REV-25 / BUG-19）
 *
 * 断言点：
 * - 加载失败 → `failedTrackIds` 包含该 id，且错误仍抛给上层（Toast），播放不中断
 * - 加载成功 → 不在集合内
 * - 重试成功 → 从集合移除并激活
 * - 切集/换地址（`setTracks`）→ 失败标记被清除
 * - 关闭字幕（null）始终可用
 */
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n第一句\n';

function track(id: string, url = `https://cdn.example.com/${id}.vtt`): SubtitleTrack {
  return { id, label: id, lang: 'zh', url, format: 'vtt', source: 'remote' };
}

describe('SubtitleManager 失败轨道标记（AC-46）', () => {
  it('加载失败（404）→ failedTrackIds 含该 id，错误抛给上层且不激活', async () => {
    const manager = new SubtitleManager({
      fetchText: async () => {
        throw Object.assign(new Error('字幕加载失败(404)'), { name: 'AppError' });
      },
    });
    manager.setTracks([track('zh')]);

    expect(manager.getFailedIds()).toEqual([]);
    await expect(manager.setActive('zh')).rejects.toBeTruthy();

    expect(manager.getFailedIds()).toEqual(['zh']);
    expect(manager.isFailed('zh')).toBe(true);
    // 失败不激活，字幕文本为空（播放继续）
    expect(manager.getActiveId()).toBeNull();
    expect(manager.textAt(2)).toBe('');
  });

  it('加载成功 → 不在失败集合，且可正常取到文本', async () => {
    const manager = new SubtitleManager({ fetchText: async () => ({ text: VTT, format: 'vtt' }) });
    manager.setTracks([track('zh')]);

    await manager.setActive('zh');

    expect(manager.getFailedIds()).toEqual([]);
    expect(manager.isFailed('zh')).toBe(false);
    expect(manager.getActiveId()).toBe('zh');
    expect(manager.textAt(2)).toBe('第一句');
  });

  it('重试成功 → 从失败集合移除并激活', async () => {
    const fetchText = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ text: VTT, format: 'vtt' });
    const manager = new SubtitleManager({ fetchText });
    manager.setTracks([track('zh')]);

    await expect(manager.setActive('zh')).rejects.toBeTruthy();
    expect(manager.getFailedIds()).toEqual(['zh']);

    await manager.retry('zh');

    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(manager.getFailedIds()).toEqual([]);
    expect(manager.getActiveId()).toBe('zh');
    expect(manager.textAt(2)).toBe('第一句');
  });

  it('重试仍失败 → 继续留在失败集合', async () => {
    const manager = new SubtitleManager({
      fetchText: async () => {
        throw new Error('still down');
      },
    });
    manager.setTracks([track('zh')]);

    await expect(manager.setActive('zh')).rejects.toBeTruthy();
    await expect(manager.retry('zh')).rejects.toBeTruthy();

    expect(manager.getFailedIds()).toEqual(['zh']);
    expect(manager.getActiveId()).toBeNull();
  });

  it('一条失败不影响另一条成功（失败按轨独立记录）', async () => {
    const manager = new SubtitleManager({
      fetchText: async (t) => {
        if (t.id === 'en') throw new Error('404');
        return { text: VTT, format: 'vtt' };
      },
    });
    manager.setTracks([track('zh'), track('en')]);

    await expect(manager.setActive('en')).rejects.toBeTruthy();
    await manager.setActive('zh');

    expect(manager.getFailedIds()).toEqual(['en']);
    expect(manager.getActiveId()).toBe('zh');
  });

  it('setTracks 换地址（切集/切线路重载）→ 清除该 id 的失败标记', async () => {
    const manager = new SubtitleManager({
      fetchText: async () => {
        throw new Error('404');
      },
    });
    manager.setTracks([track('remote:0', 'https://cdn.example.com/ep1.vtt')]);
    await expect(manager.setActive('remote:0')).rejects.toBeTruthy();
    expect(manager.isFailed('remote:0')).toBe(true);

    manager.setTracks([track('remote:0', 'https://cdn.example.com/ep2.vtt')]);
    expect(manager.getFailedIds()).toEqual([]);
  });

  it('setTracks 去掉失败轨道 → 集合收敛为空；关闭字幕（null）不受影响', async () => {
    const manager = new SubtitleManager({
      fetchText: async () => {
        throw new Error('404');
      },
    });
    manager.setTracks([track('zh'), track('en')]);
    await expect(manager.setActive('zh')).rejects.toBeTruthy();

    manager.setTracks([track('en')]);
    expect(manager.getFailedIds()).toEqual([]);

    // 关闭字幕始终可用，且不触发任何加载
    await expect(manager.setActive(null)).resolves.toBeUndefined();
    expect(manager.getActiveId()).toBeNull();
  });

  it('clear() 清空失败集合', async () => {
    const manager = new SubtitleManager({
      fetchText: async () => {
        throw new Error('404');
      },
    });
    manager.setTracks([track('zh')]);
    await expect(manager.setActive('zh')).rejects.toBeTruthy();
    expect(manager.isFailed('zh')).toBe(true);

    manager.clear();
    expect(manager.getFailedIds()).toEqual([]);
    expect(manager.getTracks()).toEqual([]);
  });
});
