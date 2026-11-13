import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { settingsService } from '@/services/settingsService';
import { KV_KEY_SETTINGS } from '@/shared/constants';
import type { AppSettings } from '@/types';

import { resetAll } from './helpers';

/**
 * 第二轮 / 项 4：废弃设置字段的清理
 *
 * `player.subtitle.enabled`、`locale`、`player.defaultQuality` 三个字段全仓零读取：
 * 字幕开关的真实载体是运行时的活动轨 id，项目没有 i18n，起播档位恒为 auto。
 * 类型里删掉还不够 —— 旧库里的残值会随 `{ ...defaults, ...input }` 回流并重新落盘，
 * 因此 sanitize 显式剔除 + schemaVersion 升到 3 触发一次性重写。
 */

async function seedLegacy(): Promise<void> {
  const base = await settingsService.get();
  const legacy = {
    ...base,
    schemaVersion: 2,
    locale: 'zh-CN',
    player: {
      ...base.player,
      defaultQuality: '1080p',
      subtitle: { ...base.player.subtitle, enabled: true },
    },
  } as unknown as AppSettings;
  await kvRepo.set(KV_KEY_SETTINGS, legacy);
  settingsService.__resetCache();
}

describe('废弃设置字段剔除', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('读取旧库时不再给出这三个字段', async () => {
    await seedLegacy();

    const got = await settingsService.get();
    expect(got).not.toHaveProperty('locale');
    expect(got.player).not.toHaveProperty('defaultQuality');
    expect(got.player.subtitle).not.toHaveProperty('enabled');
  });

  it('schemaVersion 迁移把清理后的结果写回 kv（残值不留在盘上）', async () => {
    await seedLegacy();
    await settingsService.get();

    const stored = await kvRepo.get<Record<string, unknown>>(KV_KEY_SETTINGS);
    expect(stored).not.toBeNull();
    expect(stored?.schemaVersion).toBe(3);
    expect(JSON.stringify(stored)).not.toContain('defaultQuality');
    expect(JSON.stringify(stored)).not.toContain('"locale"');
  });

  it('写入路径同样不复活残值，且真实字段照常保存', async () => {
    await seedLegacy();

    const next = await settingsService.update({
      theme: 'light',
      player: { subtitle: { preferredLang: 'zh' } },
    });
    expect(next.theme).toBe('light');
    expect(next.player.subtitle.preferredLang).toBe('zh');
    expect(next).not.toHaveProperty('locale');
    expect(next.player.subtitle).not.toHaveProperty('enabled');
  });

  it('迁移只补默认值，用户已有配置不丢', async () => {
    const base = await settingsService.get();
    await settingsService.update({ theme: 'light', hideDemoContent: true });
    const current = await settingsService.get();
    const legacy = {
      ...current,
      schemaVersion: 2,
      locale: 'zh-CN',
    } as unknown as AppSettings;
    await kvRepo.set(KV_KEY_SETTINGS, legacy);
    settingsService.__resetCache();

    const got = await settingsService.get();
    expect(base.schemaVersion).toBe(3);
    expect(got.theme).toBe('light');
    expect(got.hideDemoContent).toBe(true);
  });
});
