/**
 * 源忙闸门的重试按钮（OPT-26 P0-③-2）
 *
 * 「该源正忙」以前是一句没有出口的话：按钮一直能点，点下去挤的还是同一个爬虫实例
 * （真机 12:18 / 12:24 的连点形态），而忙态文案又承诺了「稍后会自动重试」。
 * 这里把那句承诺钉成界面行为——倒计时来自 `retryAfterMs`（真实占用读数），
 * 倒计时内禁用，归零自动重试一次且只有一次。
 */
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlayerErrorPanel from '@/components/player/PlayerErrorPanel.vue';
import type { AppErrorShape, ErrorCode } from '@/types';

function shape(code: ErrorCode, retryAfterMs?: number): AppErrorShape {
  return {
    code,
    message: code === 'E_SOURCE_BUSY' ? '该源正忙（上一次调用仍未结束），请稍后重试' : '源响应超时',
    detail: '半日App',
    retryable: true,
    httpStatus: null,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function mountPanel(error: AppErrorShape) {
  return mount(PlayerErrorPanel, { props: { error } });
}

/** 闸门文案落在「重试」那颗按钮上：面板里唯一带 data-test 的 CTA */
function retryOf(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.get('[data-test="retry-cta"]');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('播放错误面板的源忙重试闸门', () => {
  it('闸门还剩 5 秒：重试禁用并念真实秒数，到点自动重试且只自动投一次', async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel(shape('E_SOURCE_BUSY', 5_000));

    expect(retryOf(wrapper).attributes('disabled')).toBeDefined();
    expect(retryOf(wrapper).text()).toBe('约 5 秒后可重试');
    // 闸门只拦「重试」：换线路这条出口任何时候都得能走
    expect(wrapper.get('button.pl-cta--ghost').attributes('disabled')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(retryOf(wrapper).text()).toBe('约 1 秒后可重试');

    await vi.advanceTimersByTimeAsync(1_200);
    expect(retryOf(wrapper).text()).toBe('重试');
    expect(retryOf(wrapper).attributes('disabled')).toBeUndefined();
    expect(wrapper.emitted('retry')).toHaveLength(1);

    // 到点之后不再有第二次自动重试（同一份错误不补投）
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('探测被这次点击打断（retryAfterMs = 0）：不拦用户，也不凭空编一个倒计时', async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel(shape('E_SOURCE_BUSY', 0));

    expect(retryOf(wrapper).attributes('disabled')).toBeUndefined();
    expect(retryOf(wrapper).text()).toBe('重试');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(wrapper.emitted('retry')).toBeUndefined();
  });

  it('非源忙的错误一律不倒计时：retryAfterMs 只在忙态上有意义', async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel(shape('E_TIMEOUT', 30_000));

    expect(retryOf(wrapper).attributes('disabled')).toBeUndefined();
    expect(retryOf(wrapper).text()).toBe('重试');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper.emitted('retry')).toBeUndefined();
  });

  it('到点后一次点击发一次 retry：自动重试不吞掉用户的手', async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel(shape('E_SOURCE_BUSY', 2_000));
    expect(retryOf(wrapper).attributes('disabled')).toBeDefined();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(wrapper.emitted('retry')).toHaveLength(1);

    await retryOf(wrapper).trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(2);
  });

  it('闸门换档：新的占用读数重新计时，旧倒计时不接着念', async () => {
    vi.useFakeTimers();
    const wrapper = mountPanel(shape('E_SOURCE_BUSY', 8_000));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(retryOf(wrapper).text()).toBe('约 4 秒后可重试');

    // 排队重投又撞了一次闸门：秒数必须跟着最新的那次占用走
    await wrapper.setProps({ error: shape('E_SOURCE_BUSY', 3_000) });
    expect(retryOf(wrapper).text()).toBe('约 3 秒后可重试');

    await vi.advanceTimersByTimeAsync(3_500);
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });
});
