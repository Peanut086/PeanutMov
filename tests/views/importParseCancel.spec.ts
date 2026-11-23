/**
 * P0-2：导入页的「取消」解析
 *
 * store 层的 signal 接线由 `tests/unit/importStore.spec.ts` 锁；这里锁的是用户那一段：
 * 1. 「取消」只在解析中出现（没在等就不该多一个按钮）；
 * 2. 点它解析状态立刻归位，abort 真的传到请求层，而不是把按钮变灰继续等；
 * 3. 取消后请求即使晚到也不落地、不写错误（旧口径会留下"已取消"错误面板）；
 * 4. 解析中直接离开页面 = 同样中止，订阅请求不在后台跑满 10s 预算；
 * 5. 解析中输入框与「获取」一起禁用，取消是改地址的唯一通路——所以这个按钮不是装饰。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ query: {} }),
}));

import ImportSubscriptionView from '@/views/ImportSubscriptionView.vue';
import { importService } from '@/services/importService';
import { useImportStore } from '@/stores/importStore';
import type { ImportPreview } from '@/types';

import { resetAll } from '../unit/helpers';

const SUB_URL = 'https://a.example.com/sub.json';

function fakePreview(sourceUrl: string | null): ImportPreview {
  return {
    origin: 'url',
    sourceUrl,
    fileName: null,
    fetchedAt: Date.now(),
    name: '我的订阅',
    total: 0,
    entries: [],
    globalIssues: [],
    repos: [],
    lives: [],
  };
}

/** 受控解析：记下每次拿到的 signal，由测试决定何时返回 */
function holdPreview(signals: AbortSignal[], gates: Array<() => void>) {
  return vi.spyOn(importService, 'previewFromUrl').mockImplementation(async (url, signal) => {
    signals.push(signal as AbortSignal);
    await new Promise<void>((resolve) => gates.push(resolve));
    return fakePreview(url ?? null);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountView(wrapperUrl = SUB_URL): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const wrapper = mount(ImportSubscriptionView);
  await settle();
  await wrapper.find('#sub-url').setValue(wrapperUrl);
  return wrapper;
}

function fetchButton(wrapper: VueWrapper) {
  return wrapper.findAll('.import-fetch')[0]!;
}

function cancelButton(wrapper: VueWrapper) {
  return wrapper.findAll('.import-fetch').find((node) => node.text().replace(/\s+/g, '') === '取消');
}

async function startParse(wrapper: VueWrapper, signals: AbortSignal[]): Promise<void> {
  await fetchButton(wrapper).trigger('click');
  await vi.waitFor(() => expect(signals).toHaveLength(1));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
});

describe('解析取消（P0-2）', () => {
  it('解析中才出现「取消」，点下去立刻归位并把 abort 传到请求层', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    holdPreview(signals, gates);
    const wrapper = await mountView();
    const store = useImportStore();

    expect(cancelButton(wrapper), '未解析时不该有多余的取消按钮').toBeUndefined();
    await startParse(wrapper, signals);
    expect(store.parsing).toBe(true);
    expect(fetchButton(wrapper).text()).toContain('获取中');
    expect(fetchButton(wrapper).attributes('disabled')).toBeDefined();
    expect(cancelButton(wrapper), '解析中必须能取消').toBeTruthy();

    await cancelButton(wrapper)!.trigger('click');
    await settle();

    expect(signals[0]?.aborted, '取消要把 abort 交给请求层').toBe(true);
    expect(store.parsing).toBe(false);
    expect(store.error).toBeNull();
    expect(store.preview).toBeNull();
    expect(cancelButton(wrapper), '取消后按钮要收回去').toBeUndefined();
    expect(fetchButton(wrapper).text()).toContain('获取');
  });

  it('取消后请求晚到也不落地、不写错误', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    holdPreview(signals, gates);
    const wrapper = await mountView();
    const store = useImportStore();
    await startParse(wrapper, signals);
    await cancelButton(wrapper)!.trigger('click');
    await settle();

    gates.forEach((open) => open());
    await settle();

    expect(store.preview).toBeNull();
    expect(store.error).toBeNull();
    expect(store.parsing).toBe(false);
  });

  it('解析中离开页面：在途请求一并中止', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    holdPreview(signals, gates);
    const wrapper = await mountView();
    await startParse(wrapper, signals);

    wrapper.unmount();

    expect(signals[0]?.aborted).toBe(true);
    expect(useImportStore().parsing).toBe(false);
    gates.forEach((open) => open());
    await settle();
  });

  it('解析中输入框与获取按钮一起禁用：改地址必须先取消，取消后才能重新发起', async () => {
    const signals: AbortSignal[] = [];
    const gates: Array<() => void> = [];
    holdPreview(signals, gates);
    const wrapper = await mountView();
    const store = useImportStore();
    await startParse(wrapper, signals);

    expect(fetchButton(wrapper).attributes('disabled')).toBeDefined();
    expect(wrapper.find('#sub-url').attributes('disabled')).toBeDefined();
    // 唯一出路是取消——没有它，页面会锁死到 10s 预算跑完
    await cancelButton(wrapper)!.trigger('click');
    await settle();
    expect(wrapper.find('#sub-url').attributes('disabled')).toBeUndefined();

    await wrapper.find('#sub-url').setValue('https://b.example.com/sub.json');
    await fetchButton(wrapper).trigger('click');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    gates.forEach((open) => open());
    await vi.waitFor(() => expect(store.parsing).toBe(false));
    expect(store.preview?.sourceUrl).toBe('https://b.example.com/sub.json');
    expect(store.error).toBeNull();
  });
});
