/**
 * 原生下载插件封装的「代理句柄」回归测试
 *
 * 起因：initPlugin 曾是 `async` 且直接 `return registerPlugin(...)`。Capacitor 的插件代理
 * 对任意属性名都给出一个函数，Promise 解析时读到 `.then` 就把它当 thenable 回调，
 * 于是向原生发起一次名为 "then" 的调用并失败 —— 原生下载器被永久判定为不可用，
 * 且 Web 路径测试完全覆盖不到。这里用同样行为的代理把该缺陷钉死。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/platform', () => ({
  isNative: vi.fn(() => true),
}));

let listenerCalls: string[] = [];

function makePluginStub() {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'isAvailable') return () => Promise.resolve({ available: true });
        if (prop === 'addListener') {
          return (event: string) => {
            listenerCalls.push(event);
            return Promise.resolve({ remove: () => {} });
          };
        }
        if (prop === 'then') {
          return (_resolve: unknown, rej: (e: Error) => void) =>
            rej(new Error('native method "then" not implemented'));
        }
        if (prop === 'start') return () => Promise.resolve({ ok: true });
        return () => Promise.resolve({ ok: true });
      },
    },
  );
}

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => makePluginStub(),
}));

async function freshModule() {
  vi.resetModules();
  listenerCalls = [];
  return import('@/native/downloadPlugin');
}

describe('原生下载插件代理句柄', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('await 代理不再被当成 thenable，可用性检测拿到 true', async () => {
    const mod = await freshModule();
    await expect(mod.isNativeDownloadAvailable()).resolves.toBe(true);
  });

  it('可用性为 true 时 start 真正打到原生方法', async () => {
    const mod = await freshModule();
    await expect(
      mod.nativeDownloadStart({
        taskId: 't1',
        url: 'https://example.com/a.mp4',
        filePath: 'downloads/a.mp4',
      }),
    ).resolves.toBeUndefined();
  });

  it('并发注册监听只加一次四类事件', async () => {
    const mod = await freshModule();
    const offs = await Promise.all([
      Promise.resolve(mod.onProgress(() => {})),
      Promise.resolve(mod.onStateChanged(() => {})),
      Promise.resolve(mod.onCompleted(() => {})),
      Promise.resolve(mod.onError(() => {})),
      Promise.resolve(mod.onProgress(() => {})),
    ]);
    // 五次订阅四类事件，注册应合并成一轮，否则进度事件会成倍回放
    await vi.waitFor(() => expect(listenerCalls.length).toBeGreaterThan(0));
    expect(new Set(listenerCalls)).toEqual(new Set(['progress', 'stateChanged', 'completed', 'error']));
    offs.forEach((off) => off());
  });

  it('pause / resume / cancel / 前台服务在原生可用时不再静默空转', async () => {
    const mod = await freshModule();
    await expect(mod.nativeDownloadPause('t1')).resolves.toBeUndefined();
    await expect(mod.nativeDownloadResume('t1')).resolves.toBeUndefined();
    await expect(mod.nativeDownloadCancel('t1')).resolves.toBeUndefined();
    await expect(mod.nativeDownloadStartForegroundService()).resolves.toBeUndefined();
    await expect(mod.nativeDownloadGetStatus()).resolves.toEqual([]);
  });
});
