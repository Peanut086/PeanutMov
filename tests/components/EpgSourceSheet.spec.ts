/**
 * EPG 源管理弹层（EpgSourceSheet）单测 —— EXT-06 P2 复审整改
 *
 * - REV-29：`limits` 初值必须与 `src/shared/constants.ts` 同源
 *   （旧实现硬编码 maxEnabled=3，与 EPG_SOURCE_ENABLED_MAX=5 不一致，
 *   服务端 limits 回来前文案与实际上限互相打架）
 * - REV-30：探测成功的提示不能被 `resetForm()` 立刻清空
 *
 * 服务层全部 mock：本文件只验证弹层的初值与反馈时序，不触网、不读写 IndexedDB。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EpgSource } from '@/types';

vi.mock('@/services/epgSourceService', () => ({
  epgSourceService: {
    list: vi.fn(),
    limits: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
    remove: vi.fn(),
  },
}));

import EpgSourceSheet from '@/components/live/EpgSourceSheet.vue';
import { epgSourceService } from '@/services/epgSourceService';
import { EPG_SOURCE_ENABLED_MAX, EPG_SOURCE_MAX } from '@/shared/constants';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

function source(overrides: Partial<EpgSource> = {}): EpgSource {
  return {
    id: 'epg-user-1',
    name: '公益 EPG',
    endpoint: 'https://epg.example.com/epg.php',
    protocol: 'diyp',
    matchMode: 'auto',
    priority: 2,
    enabled: true,
    builtin: false,
    lastProbeAt: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const wrappers: VueWrapper[] = [];

function mountSheet(): VueWrapper {
  const wrapper = mount(EpgSourceSheet, {
    props: { modelValue: true },
    global: {
      stubs: {
        BottomSheet: {
          props: ['modelValue'],
          template: '<div class="sheet"><slot /></div>',
        },
        LoadingSpinner: true,
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.mocked(epgSourceService.list).mockReset();
  vi.mocked(epgSourceService.limits).mockReset();
  vi.mocked(epgSourceService.add).mockReset();
});

describe('REV-29：limits 初值与常量同源', () => {
  it('服务端 limits 未返回前，文案已按常量显示上限（不出现硬编码的 3）', async () => {
    // 首屏请求挂起：模拟「弹层已渲染、limits 还没回来」的真实时序
    vi.mocked(epgSourceService.list).mockReturnValue(new Promise(() => undefined));
    vi.mocked(epgSourceService.limits).mockReturnValue(new Promise(() => undefined));

    const wrapper = mountSheet();
    await settle(2);

    const meta = wrapper.find('.epg-src__meta');
    expect(meta.exists()).toBe(true);
    expect(meta.text()).toContain(`已启用 0 / ${EPG_SOURCE_ENABLED_MAX}`);
    expect(meta.text()).toContain(`已添加 0 / ${EPG_SOURCE_MAX}`);
    // 反向验证：旧硬编码 3 会让下面两条断言直接转红
    expect(EPG_SOURCE_ENABLED_MAX).toBe(5);
  });

  it('启用数达到上限时按常量给出的数字提示（上限文案与常量一致）', async () => {
    // 上限校验只在「启用」方向生效，因此必须准备 N 个已启用源 + 1 个未启用源，
    // 点未启用的那个才会撞到 atEnabledLimit（点已启用的只会走停用分支）。
    const many = [
      ...Array.from({ length: EPG_SOURCE_ENABLED_MAX }, (_, index) =>
        source({ id: `epg-user-${index}`, name: `源 ${index + 1}` }),
      ),
      source({ id: 'epg-user-off', name: '未启用源', enabled: false }),
    ];
    vi.mocked(epgSourceService.list).mockResolvedValue(many);
    vi.mocked(epgSourceService.limits).mockResolvedValue({
      maxSources: EPG_SOURCE_MAX,
      maxEnabled: EPG_SOURCE_ENABLED_MAX,
    });

    const wrapper = mountSheet();
    await settle();

    const toggles = wrapper.findAll('.epg-src__toggle');
    expect(toggles).toHaveLength(EPG_SOURCE_ENABLED_MAX + 1);
    await toggles[EPG_SOURCE_ENABLED_MAX]!.trigger('click');
    await settle();

    // 已达到启用上限：拒绝启用并提示具体数字
    expect(wrapper.find('.epg-src__error').text()).toContain(
      `最多同时启用 ${EPG_SOURCE_ENABLED_MAX} 个 EPG 源`,
    );
    // 反向验证：源列表长度未被改动（未真的启用第 N+1 个）
    expect(wrapper.findAll('.epg-src__toggle')).toHaveLength(EPG_SOURCE_ENABLED_MAX + 1);
  });
});

describe('REV-30：探测成功提示不被 resetForm 清空', () => {
  it('提交成功后表单收起，且「探测通过：X」仍然可见', async () => {
    vi.mocked(epgSourceService.list).mockResolvedValue([]);
    vi.mocked(epgSourceService.limits).mockResolvedValue({
      maxSources: EPG_SOURCE_MAX,
      maxEnabled: EPG_SOURCE_ENABLED_MAX,
    });
    vi.mocked(epgSourceService.add).mockResolvedValue(source());

    const wrapper = mountSheet();
    await settle();

    await wrapper.find('.epg-src__add').trigger('click');
    await wrapper.find('#epg-src-name').setValue('公益 EPG');
    await wrapper.find('#epg-src-url').setValue('https://epg.example.com/epg.php');
    await wrapper.find('.epg-src__form .btn--primary').trigger('click');
    await settle();

    expect(vi.mocked(epgSourceService.add)).toHaveBeenCalledTimes(1);
    const ok = wrapper.find('.epg-src__ok');
    expect(ok.exists()).toBe(true);
    expect(ok.text()).toBe('探测通过：公益 EPG');
    // 表单已收起
    expect(wrapper.find('.epg-src__form').exists()).toBe(false);
    expect(wrapper.find('.epg-src__add').exists()).toBe(true);
  });

  it('探测失败时只显示错误、不显示成功提示', async () => {
    vi.mocked(epgSourceService.list).mockResolvedValue([]);
    vi.mocked(epgSourceService.limits).mockResolvedValue({
      maxSources: EPG_SOURCE_MAX,
      maxEnabled: EPG_SOURCE_ENABLED_MAX,
    });
    vi.mocked(epgSourceService.add).mockRejectedValue(new Error('probe failed'));

    const wrapper = mountSheet();
    await settle();

    await wrapper.find('.epg-src__add').trigger('click');
    await wrapper.find('#epg-src-name').setValue('坏源');
    await wrapper.find('#epg-src-url').setValue('https://epg.example.com/bad.php');
    await wrapper.find('.epg-src__form .btn--primary').trigger('click');
    await settle();

    expect(wrapper.find('.epg-src__ok').exists()).toBe(false);
    expect(wrapper.find('.epg-src__error').exists()).toBe(true);
  });
});
