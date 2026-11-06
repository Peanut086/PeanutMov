import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OPT-05 / EXT-02：网盘设置页能力声明
 *
 * 验收点：4 个非夸克平台卡片都出现「Cookie 直填、账号能力未验证」的明确提示，
 * 夸克卡片不出现限能提示（它具备账号/会员 API）。
 */

const routerBack = vi.fn();

vi.mock('vue-router', () => ({
  useRouter: () => ({ back: routerBack }),
}));

vi.mock('@/native/netdiskPlugin', () => ({
  Netdisk: {
    hasAllFilesAccess: vi.fn().mockResolvedValue({ granted: true }),
    requestAllFilesAccess: vi.fn().mockResolvedValue(undefined),
    writeCookieFile: vi.fn().mockResolvedValue({ success: true, path: '' }),
    readCookieFile: vi.fn().mockResolvedValue({ success: true, exists: false }),
    loginWebView: vi.fn(),
    backupCookieFile: vi.fn().mockResolvedValue({ success: true }),
    restoreCookieFile: vi.fn().mockResolvedValue({ success: true }),
  },
  loginWebView: vi.fn(),
  backupCookieFile: vi.fn().mockResolvedValue(true),
  restoreCookieFile: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/services/netdiskConfig', () => ({
  writeNetdiskConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import NetdiskSettingsView from '@/views/NetdiskSettingsView.vue';
import { COOKIE_ONLY_CAPABILITY_NOTE } from '@/services/netdiskPlatforms';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('NetdiskSettingsView 能力声明（OPT-05 / EXT-02）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routerBack.mockClear();
  });

  it('5 个平台卡片全部渲染', async () => {
    const wrapper = mount(NetdiskSettingsView);
    await flush();

    const names = wrapper.findAll('.platform-name').map(node => node.text());
    expect(names).toEqual(['夸克网盘', 'UC网盘', '123云盘', '天翼云盘', '阿里云盘']);
  });

  it('仅 4 个 cookie-only 平台出现「Cookie 直填、账号能力未验证」提示', async () => {
    const wrapper = mount(NetdiskSettingsView);
    await flush();

    const limited = wrapper.findAll('.platform-note--limited');
    expect(limited).toHaveLength(4);
    for (const node of limited) {
      expect(node.text()).toContain(COOKIE_ONLY_CAPABILITY_NOTE);
      expect(node.text()).toContain('不提供会员/容量信息');
    }

    const cards = wrapper.findAll('.platform-card');
    const quarkCard = cards[0];
    expect(quarkCard.find('.platform-note--limited').exists()).toBe(false);
  });

  it('cookie 未保存时 cookie-only 平台只显示「未登录」，不冒充已登录', async () => {
    const wrapper = mount(NetdiskSettingsView);
    await flush();

    const statuses = wrapper.findAll('.platform-status').map(node => node.text());
    expect(statuses).toEqual(['未登录', '未登录', '未登录', '未登录', '未登录']);
    expect(wrapper.findAll('.platform-status.logged')).toHaveLength(0);
  });
});
