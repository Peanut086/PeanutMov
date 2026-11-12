/**
 * EXT-06 / FR-68：回看播放器单测
 *
 * - REV-01：首次挂载时 `props.url` 已就绪也必须起播（state 从 idle → loading），
 *   旧实现 `watch` 无 `immediate`，挂载后状态停在 idle（黑屏且无任何提示）；
 * - REV-08：加载失败日志只记 host，不落完整回看地址（安全与隐私）。
 */
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReplayPlayer from '@/components/live/ReplayPlayer.vue';
import { TIMEOUT_REPLAY_START_MS } from '@/shared/constants';

const IDLE_TEXT = '回看地址尚未就绪';
const LOADING_TEXT = '正在连接回看流';

function mountPlayer(url: string | null): VueWrapper {
  return mount(ReplayPlayer, {
    props: {
      url,
      channelName: 'CCTV-1 综合',
      programmeTitle: '新闻联播',
      timeLabel: '11月06日 20:00 – 21:00',
      startAt: Date.now() - 3_600_000,
    },
  });
}

const wrappers: VueWrapper[] = [];

function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

describe('REV-01：ReplayPlayer 首次挂载即加载', () => {
  it('挂载时 url 已就绪 → 进入 loading（不再停在 idle）', async () => {
    const wrapper = track(mountPlayer('https://cdn.example.com/replay/20261106/200000.mp4'));
    await flushPromises();

    expect(wrapper.text()).not.toContain(IDLE_TEXT);
    expect(wrapper.text()).toContain(LOADING_TEXT);
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
  });

  it('url 为空 → 保持 idle 提示', async () => {
    const wrapper = track(mountPlayer(null));
    await flushPromises();

    expect(wrapper.text()).toContain(IDLE_TEXT);
    expect(wrapper.text()).not.toContain(LOADING_TEXT);
  });

  it('url 挂载后由 null → 有值（重试 / 换节目）仍能触发加载', async () => {
    const wrapper = track(mountPlayer(null));
    await flushPromises();
    expect(wrapper.text()).toContain(IDLE_TEXT);

    await wrapper.setProps({ url: 'https://cdn.example.com/replay/20261106/210000.mp4' });
    await flushPromises();

    expect(wrapper.text()).not.toContain(IDLE_TEXT);
    expect(wrapper.text()).toContain(LOADING_TEXT);
  });
});

describe('P1-02：回看起播看门狗（FR-68）', () => {
  const TIMEOUT_TEXT = '起播超时，请检查网络或源是否支持回看';
  const REPLAY_URL = 'https://cdn.example.com/replay/20261106/200000.mp4';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('超时前未进入 playing → 报错并给出重试/返回节目单', async () => {
    vi.useFakeTimers();
    const wrapper = track(mountPlayer(REPLAY_URL));
    await flushPromises();
    expect(wrapper.text()).toContain(LOADING_TEXT);

    vi.advanceTimersByTime(TIMEOUT_REPLAY_START_MS - 1);
    await flushPromises();
    expect(wrapper.text()).toContain(LOADING_TEXT);

    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(wrapper.text()).toContain('回看播放失败');
    expect(wrapper.text()).toContain(TIMEOUT_TEXT);
    expect(wrapper.text()).toContain('重试');
    expect(wrapper.text()).toContain('返回节目单');
  });

  it('playing 后看门狗被撤销，不再误报超时', async () => {
    vi.useFakeTimers();
    const wrapper = track(mountPlayer(REPLAY_URL));
    await flushPromises();
    expect(wrapper.text()).toContain(LOADING_TEXT);

    wrapper.find('video').element.dispatchEvent(new Event('playing'));
    await flushPromises();
    expect(wrapper.text()).not.toContain(LOADING_TEXT);

    vi.advanceTimersByTime(TIMEOUT_REPLAY_START_MS + 1000);
    await flushPromises();
    expect(wrapper.text()).not.toContain(TIMEOUT_TEXT);
  });

  it('卸载后定时器被清理（不产生超时告警）', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn');
    const wrapper = mountPlayer(REPLAY_URL);
    await flushPromises();
    wrapper.unmount();

    vi.advanceTimersByTime(TIMEOUT_REPLAY_START_MS + 1000);
    await flushPromises();
    const timeoutLogs = warnSpy.mock.calls.filter((args) => String(args[1] ?? '').includes('回看起播超时'));
    expect(timeoutLogs.length).toBe(0);
    warnSpy.mockRestore();
  });
});

describe('REV-08：加载失败日志不泄露完整回看 URL', () => {
  it('warn 只包含 host / 频道名 / 节目名，不含路径与 query', async () => {
    const loadSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(function (this: HTMLMediaElement) {
        queueMicrotask(() => this.dispatchEvent(new Event('error')));
      });
    const warnSpy = vi.spyOn(console, 'warn');
    const secretUrl =
      'https://cdn.example.com/secret-account/20261106/200000.mp4?token=SECRET-TOKEN-123';

    const wrapper = track(mountPlayer(secretUrl));
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain('回看播放失败');
    const calls = warnSpy.mock.calls.filter((args) => String(args[1] ?? '').includes('回看加载失败'));
    expect(calls.length).toBe(1);
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).toContain('cdn.example.com');
    expect(serialized).not.toContain('SECRET-TOKEN-123');
    expect(serialized).not.toContain('secret-account');
    expect(serialized).not.toContain(secretUrl);

    loadSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
