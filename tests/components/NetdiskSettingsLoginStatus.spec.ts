/**
 * 网盘平台登录态读取（EXT 批次 24：静默失败收口）
 *
 * 原生 `readCookieFile` 被拒（存储权限缺失、/sdcard/TVBox 不可访问）时，旧实现把状态
 * 一律写成 `saved:false / verified:false`，页面显示「未登录」——用户只能得出"我得重新
 * 登录"的错误结论，而真正的问题是根本没读成功。现在区分三态：检测中 / 读取失败 / 未登录。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerBack = vi.fn();
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ back: routerBack }),
}));

vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }));

vi.mock('@/services/netdiskConfig', () => ({
  writeNetdiskConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/native/netdiskPlugin', () => ({
  Netdisk: {
    hasAllFilesAccess: vi.fn(),
    requestAllFilesAccess: vi.fn().mockResolvedValue(undefined),
    writeCookieFile: vi.fn().mockResolvedValue({ success: true, path: '' }),
    readCookieFile: vi.fn(),
    loginWebView: vi.fn(),
    backupCookieFile: vi.fn().mockResolvedValue({ success: true }),
    restoreCookieFile: vi.fn().mockResolvedValue({ success: true }),
  },
  loginWebView: vi.fn(),
  backupCookieFile: vi.fn().mockResolvedValue(true),
  restoreCookieFile: vi.fn().mockResolvedValue(true),
}));

import NetdiskSettingsView from '@/views/NetdiskSettingsView.vue';
import { Netdisk } from '@/native/netdiskPlugin';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

function statusTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.platform-status').map((node) => node.text());
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(NetdiskSettingsView);
  await settle();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  routerBack.mockClear();
  toastMocks.success.mockClear();
  toastMocks.info.mockClear();
  toastMocks.error.mockClear();
  vi.mocked(Netdisk.hasAllFilesAccess).mockResolvedValue({ granted: true });
});

describe('NetdiskSettingsView 登录态三态（批次 24）', () => {
  it('读取被拒 → 显示「状态读取失败」，不再冒充「未登录」', async () => {
    vi.mocked(Netdisk.readCookieFile).mockRejectedValue(new Error('无法访问外部存储'));

    const wrapper = await mountView();
    const texts = statusTexts(wrapper);
    expect(texts).toHaveLength(5);
    for (const text of texts) {
      expect(text).toBe('状态读取失败');
    }
    expect(wrapper.findAll('.platform-status.error')).toHaveLength(5);
    // 未登录字样一次都不该出现
    expect(wrapper.text()).not.toContain('未登录');
  });

  it('文件确实不存在 → 仍显示「未登录」（不被误判成读取失败）', async () => {
    vi.mocked(Netdisk.readCookieFile).mockResolvedValue({ success: false, exists: false });

    const wrapper = await mountView();
    expect(statusTexts(wrapper)).toEqual([
      '未登录',
      '未登录',
      '未登录',
      '未登录',
      '未登录',
    ]);
    expect(wrapper.findAll('.platform-status.error')).toHaveLength(0);
  });

  it('读取挂起时是「检测中…」，不预设任何结论', async () => {
    vi.mocked(Netdisk.readCookieFile).mockImplementation(() => new Promise(() => undefined));

    const wrapper = mount(NetdiskSettingsView);
    await settle(2);
    expect(statusTexts(wrapper)).toEqual([
      '检测中…',
      '检测中…',
      '检测中…',
      '检测中…',
      '检测中…',
    ]);
    wrapper.unmount();
  });

  it('夸克读到昵称 → 「已登录（昵称）」，其余 cookie-only 平台只说已保存', async () => {
    vi.mocked(Netdisk.readCookieFile).mockImplementation(async ({ platform }) =>
      platform === 'quark'
        ? { success: true, exists: true, content: JSON.stringify({ a: '小明', b: 'VIP' }) }
        : { success: true, exists: true, content: 'cookie=1' },
    );

    const wrapper = await mountView();
    expect(statusTexts(wrapper)).toEqual([
      '已登录（小明）',
      'Cookie 已保存',
      'Cookie 已保存',
      'Cookie 已保存',
      'Cookie 已保存',
    ]);
    expect(wrapper.findAll('.platform-status.logged')).toHaveLength(1);
  });

  it('单个平台读失败只影响该卡片，其它平台状态照常', async () => {
    vi.mocked(Netdisk.readCookieFile).mockImplementation(async ({ platform }) => {
      if (platform === 'uc') throw new Error('读取挂了');
      return { success: true, exists: false };
    });

    const wrapper = await mountView();
    expect(statusTexts(wrapper)).toEqual([
      '未登录',
      '状态读取失败',
      '未登录',
      '未登录',
      '未登录',
    ]);
    expect(wrapper.findAll('.platform-status.error')).toHaveLength(1);
  });
});
