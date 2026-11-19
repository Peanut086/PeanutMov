import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-6：连接层失败的归因
 *
 * 真机实测：设备在线（`navigator.onLine === true`），死源任务却写着
 * 「网络不可用，请检查网络后重试」——用户被引导去查 WiFi，问题其实在那条线路。
 * `fetch` 对「域名解析不了」和「设备断网」抛的是同一个 TypeError，
 * 所以归因必须在抛出侧就做完（列表、错误面板、重试按钮读同一份语义）。
 */

let online = true;

vi.mock('@/native/network', () => ({
  isOnline: () => online,
}));

const { AppError } = await import('@/shared/errors');
const { classifyConnectivityError } = await import('@/services/connectivityError');
describe('classifyConnectivityError（连接失败归因）', () => {
  beforeEach(() => {
    online = true;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('在线 + fetch 层 TypeError → 归因到线路，并点明本机网络正常', () => {
    const e = classifyConnectivityError(new TypeError('Failed to fetch'));
    expect(e.code).toBe('E_SOURCE_UNAVAILABLE');
    expect(e.message).toContain('本机网络正常');
    expect(e.message).not.toContain('请检查网络');
    expect(e.retryable).toBe(true);
  });

  it('离线 → 保留 E_NETWORK（原文案本来就是对的）', () => {
    online = false;
    const e = classifyConnectivityError(new TypeError('Failed to fetch'));
    expect(e.code).toBe('E_NETWORK');
    expect(e.message).toBe('网络不可用，请检查网络后重试');
  });

  it('超时/取消/4xx 不改写语义', () => {
    for (const input of [
      new AppError('E_TIMEOUT'),
      new AppError('E_ABORTED'),
      new AppError('E_HTTP_403'),
      new AppError('E_SOURCE_UNAVAILABLE', '该源正忙（上一次调用约 12 秒后结束），请稍后重试'),
    ]) {
      const e = classifyConnectivityError(input);
      expect(e.code).toBe(input.code);
      expect(e.message).toBe(input.message);
      expect(e).toBe(input);
    }
  });

  it('自定义 E_NETWORK 文案（如停滞/分片不完整）不动它——那不是连接归因问题', () => {
    const e = classifyConnectivityError(new AppError('E_NETWORK', '下载停滞超过 30s，自动中断'));
    expect(e.code).toBe('E_NETWORK');
    expect(e.message).toBe('下载停滞超过 30s，自动中断');
  });

  it('保留 detail/httpStatus，原始异常仍可追', () => {
    const raw = new TypeError('Failed to fetch');
    const e = classifyConnectivityError(raw, '该源');
    expect(e.message).toContain('该源暂时不可用');
    expect(e.detail).toContain('Failed to fetch');
    expect((e as { cause?: unknown }).cause).toBe(raw);
  });

  it('非 fetch 措辞的异常同样按 E_NETWORK 回退（沿用 `toAppError` 口径），在线时一并归因到线路', () => {
    // try 块里只包了 fetch 本身，所以这条回退路径在调用点上是成立的；
    // 断言写出来是为了记录：归因发生在「连接没建立」这一层，不是逐字识别异常类型。
    const e = classifyConnectivityError(new TypeError('x is not a function'));
    expect(e.code).toBe('E_SOURCE_UNAVAILABLE');
  });
});
