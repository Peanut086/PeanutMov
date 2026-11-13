import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3-24：设置写入的静默失败收口
 *
 * 页面上曾有 9 处 `void settings.update(...)`：IDB 写失败（配额满、数据库异常）时
 * UI 早已按新值渲染完，用户以为改成功了，下次进来又变回旧值——没有任何地方告诉他。
 * 现在统一走 `updateNonBlocking`：不等落盘（交互照旧顺滑），但失败必须经全局
 * `toast` 事件出声，并记进 `settingsStore.error`。
 */
import { appEvents } from '@/services/events';
import { settingsService } from '@/services/settingsService';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AppSettings } from '@/types';

interface ToastPayload {
  text: string;
  type: string;
}

describe('settingsStore.updateNonBlocking', () => {
  let seen: ToastPayload[] = [];
  let off: () => void;

  beforeEach(() => {
    setActivePinia(createPinia());
    appEvents.clear();
    seen = [];
    off = appEvents.on('toast', (payload) => seen.push(payload as ToastPayload));
  });

  it('写库失败：发出 error toast，错误形状记进 store', async () => {
    vi.spyOn(settingsService, 'update').mockRejectedValue(new Error('indexeddb aborted'));

    const store = useSettingsStore();
    store.updateNonBlocking({ player: { resizeMode: 'cover' } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]!.type).toBe('error');
    expect(seen[0]!.text).toContain('本地数据读写失败');
    expect(store.error?.code).toBe('E_DB');
  });

  it('调用方不会被拒绝打断（fire-and-forget 仍然安全）', async () => {
    vi.spyOn(settingsService, 'update').mockRejectedValue(new Error('indexeddb aborted'));

    const store = useSettingsStore();
    expect(() => store.updateNonBlocking({ player: { resizeMode: 'cover' } })).not.toThrow();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
  });

  it('正向对照：写成功一条 toast 都不发，设置落到新值', async () => {
    const next = { theme: 'light', player: { resizeMode: 'cover' } } as unknown as AppSettings;
    vi.spyOn(settingsService, 'update').mockResolvedValue(next);

    const store = useSettingsStore();
    store.updateNonBlocking({ player: { resizeMode: 'cover' } });
    await vi.waitFor(() => expect(store.ready).toBe(true));

    expect(seen).toHaveLength(0);
    expect(store.error).toBeNull();
    expect(store.player?.resizeMode).toBe('cover');
  });

  it('被 await 的 update() 仍然原样抛出（不改既有语义，收口只针对不等落盘的调用）', async () => {
    vi.spyOn(settingsService, 'update').mockRejectedValue(new Error('boom'));

    const store = useSettingsStore();
    await expect(store.update({ player: { resizeMode: 'cover' } })).rejects.toThrow('boom');
    expect(seen).toHaveLength(0);
  });

  afterEach(() => {
    off();
  });
});
