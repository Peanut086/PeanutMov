/**
 * P3-23：滑块落盘防抖接通
 *
 * 之前 `useDebounce` 写好了却无人引用，真正每帧触发的两处（网盘下载线程数、
 * 弹幕样式面板）各自为政：前者一次拖动写 N 遍 IDB + 原生配置文件，后者手搓定时器
 * 且卸载时把挂起的那次写丢掉。这里钉住三件事：
 * 1. 拖动过程中不写盘（显示值必须跟手）；
 * 2. 一次拖动只落最后一次的值；
 * 3. 提前离开页面不丢最后一次写入。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routerBack: vi.fn(),
  writeNetdiskConfig: vi.fn(async (): Promise<void> => undefined),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ back: mocks.routerBack }) }));

vi.mock('@/services/netdiskConfig', () => ({ writeNetdiskConfig: mocks.writeNetdiskConfig }));

vi.mock('@/composables/useToast', () => ({ useToast: () => mocks.toast }));

vi.mock('@/native/netdiskPlugin', () => ({
  Netdisk: {
    hasAllFilesAccess: vi.fn(async () => ({ granted: true })),
    requestAllFilesAccess: vi.fn(async () => undefined),
    writeCookieFile: vi.fn(async () => ({ success: true, path: '' })),
    readCookieFile: vi.fn(async () => ({ success: true, exists: false })),
    loginWebView: vi.fn(),
    backupCookieFile: vi.fn(async () => true),
    restoreCookieFile: vi.fn(async () => true),
  },
  loginWebView: vi.fn(),
  backupCookieFile: vi.fn(async () => true),
  restoreCookieFile: vi.fn(async () => true),
}));

import DanmakuStylePanel from '@/components/player/DanmakuStylePanel.vue';
import NetdiskSettingsView from '@/views/NetdiskSettingsView.vue';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 挂上设置写入探针（store 单例，组件拿到的就是同一个实例）。
 * `updateNonBlocking` 在 store 内部直接调本地的 `update`，代理上拦不住，
 * 所以按调用方真正用到的那个方法名来打桩。
 */
function watchSettingsWrite(method: 'update' | 'updateNonBlocking' = 'update') {
  return vi.spyOn(useSettingsStore(), method);
}

function threadSlider(wrapper: VueWrapper): { setValue(v: string): Promise<void>; shown(): string } {
  const input = wrapper.find<HTMLInputElement>('.thread-slider');
  const item = (input.element.closest('.config-item') as HTMLElement) ?? document.body;
  return {
    setValue: (v) => input.setValue(v),
    shown: () => item.querySelector('.config-value')?.textContent?.trim() ?? '',
  };
}

/**
 * 「下载参数」默认折叠，线程数滑块在展开后的内容里。
 * 展开同时把计数清零：`onMounted` 自己会写一次 netdisk 配置文件，
 * 不清掉的话「拖动只写一次」会被挂载期的那一次污染。
 */
async function openAdvanced(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.advanced-header').trigger('click');
  await vi.advanceTimersByTimeAsync(50);
  mocks.writeNetdiskConfig.mockClear();
  mocks.toast.success.mockClear();
  mocks.toast.info.mockClear();
  mocks.toast.error.mockClear();
}

describe('网盘下载线程数的落盘', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    mocks.writeNetdiskConfig.mockClear();
    mocks.toast.success.mockClear();
    mocks.toast.info.mockClear();
    mocks.toast.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('拖动 5 帧只写一次，且写的是最终值', async () => {
    const update = watchSettingsWrite();
    // 假定时器下真实 IDB 事件排不进本轮 clock，这里只验「写几次、写什么」，落盘本身另有 store 用例
    update.mockResolvedValue(undefined);
    const wrapper = mount(NetdiskSettingsView);
    await openAdvanced(wrapper);

    const slider = threadSlider(wrapper);
    for (const v of ['1', '2', '3', '4', '5']) await slider.setValue(v);

    expect(update).not.toHaveBeenCalled();
    expect(slider.shown()).toBe('5');

    await vi.advanceTimersByTimeAsync(300);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].netdisk).toEqual({ quality: 'auto', threadCount: 5 });
    expect(mocks.writeNetdiskConfig).toHaveBeenCalledTimes(1);
  });

  it('拖到一半就离开页面，挂起的最后一次仍然落盘', async () => {
    const update = watchSettingsWrite();
    const wrapper = mount(NetdiskSettingsView);
    await openAdvanced(wrapper);

    await threadSlider(wrapper).setValue('7');
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(0);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].netdisk).toEqual({ quality: 'auto', threadCount: 7 });
  });

  it('落盘失败：出声提示，显示值回滚到真正存下的那个', async () => {
    const update = watchSettingsWrite();
    update.mockRejectedValue(new Error('indexeddb busy'));
    const wrapper = mount(NetdiskSettingsView);
    await openAdvanced(wrapper);

    const slider = threadSlider(wrapper);
    await slider.setValue('6');
    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.writeNetdiskConfig).not.toHaveBeenCalled();
    // 没写进去的值不能继续挂在界面上：草稿作废，回落到存储里的默认 4
    expect(slider.shown()).toBe('4');
  });

  it('不动滑块就不会写盘（防抖不是定时轮询）', async () => {
    const update = watchSettingsWrite();
    const wrapper = mount(NetdiskSettingsView);
    await openAdvanced(wrapper);
    await vi.advanceTimersByTimeAsync(1000);

    expect(wrapper.find('.thread-slider').exists()).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('弹幕样式面板的落盘', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fontSizeSlider(wrapper: VueWrapper) {
    return wrapper.findAll<HTMLInputElement>('input[type="range"]')[0]!;
  }

  it('拖动字号 4 帧只写一次，标题实时跟手', async () => {
    const update = watchSettingsWrite('updateNonBlocking');
    const wrapper = mount(DanmakuStylePanel, { props: { open: true } });

    const slider = fontSizeSlider(wrapper);
    for (const v of ['12', '14', '18', '22']) await slider.setValue(v);

    expect(wrapper.find('.panel-field span').text()).toBe('字号 22px');
    expect(update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].danmaku).toMatchObject({ fontSize: 22 });
  });

  it('未落盘就退出播放页，最后一次样式不丢', async () => {
    const update = watchSettingsWrite('updateNonBlocking');
    const wrapper = mount(DanmakuStylePanel, { props: { open: true } });

    await fontSizeSlider(wrapper).setValue('30');
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(0);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].danmaku).toMatchObject({ fontSize: 30 });
  });

  it('面板关闭（open=false）时不写盘', async () => {
    const update = watchSettingsWrite('updateNonBlocking');
    const wrapper = mount(DanmakuStylePanel, { props: { open: false } });

    await vi.advanceTimersByTimeAsync(1000);

    expect(update).not.toHaveBeenCalled();
    expect(wrapper.find('.danmaku-style-panel').exists()).toBe(false);
  });
});
