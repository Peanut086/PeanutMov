/**
 * 本地别名表单测（SO-ALIAS 存储层）
 *
 * 覆盖：学习信号的双向写入与各种"不学"围栏（等价/不像/越界/隐私）、
 * 桶内形态上限、脏表读回不炸、清空入口。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { clearAliases, learnPair, lookupAliases } from '@/services/aliasService';
import { settingsService } from '@/services/settingsService';
import { normalizeTitleKey } from '@/sources/mapping/TitleNormalizer';
import { KV_KEY_SEARCH_ALIASES } from '@/shared/constants';

import { readKv, resetAll } from './helpers';

describe('aliasService', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  it('搜索词与点击片名双向可查', async () => {
    expect(await learnPair('狂飙 电视剧', '狂飙')).toBe(true);
    expect(await lookupAliases('狂飙 电视剧')).toContain('狂飙');
    expect(await lookupAliases('狂飙')).toContain('狂飙 电视剧');
  });

  it('形态等价不写（键相同不算别名）', async () => {
    expect(await learnPair('庆余年', '庆余年')).toBe(false);
    expect(await learnPair(' 庆余年 ', '庆余年')).toBe(false);
    expect(await readKv(KV_KEY_SEARCH_ALIASES)).toBeFalsy();
  });

  it('完全不像的形态不学（点击误触防线）', async () => {
    expect(await learnPair('三体', '权力的游戏')).toBe(false);
    // 季号标注在归一后同根，同样落在"等价形态"里，不构成别名
    expect(await learnPair('庆余年 第二季', '庆余年 第三季')).toBe(false);
  });

  it('长度围栏外的词不学', async () => {
    expect(await learnPair('狂', '狂飙')).toBe(false);
    expect(await learnPair('狂'.repeat(41), '狂飙')).toBe(false);
  });

  it('隐私开关打开：既不学也读不到', async () => {
    await learnPair('狂飙 电视剧', '狂飙');
    await settingsService.update({ pauseHistoryRecording: true });
    expect(await learnPair('三体 电视剧', '三体')).toBe(false);
    expect(await lookupAliases('狂飙')).toEqual([]);
  });

  it('单桶形态数封顶，最新写入保留', async () => {
    const forms = ['狂飙 电视剧', '狂飙 版', '狂飙 新编版', '狂飙 节目', '狂飙 热剧', '狂飙 全集', '狂飙 剧场版'];
    for (const form of forms) {
      expect(await learnPair(form, '狂飙')).toBe(true);
    }
    const table = await readKv<Record<string, { titles: string[] }>>(KV_KEY_SEARCH_ALIASES);
    const bucket = table![normalizeTitleKey('狂飙')];
    expect(bucket.titles.length).toBeLessThanOrEqual(6);
    // 封顶淘汰的是最早写入的形态
    expect(bucket.titles).not.toContain(forms[0]);
    expect(bucket.titles).toContain(forms[forms.length - 1]);
  });

  it('脏表读回不炸：坏桶逐项跳过', async () => {
    await kvRepo.set(KV_KEY_SEARCH_ALIASES, {
      broken1: 'not-a-bucket',
      broken2: { canonical: 42 },
      [normalizeTitleKey('狂飙')]: { canonical: '狂飙', titles: ['狂飙 电视剧', 7, '  '], updatedAt: Date.now() },
    });
    expect(await lookupAliases('狂飙')).toEqual(['狂飙 电视剧']);
  });

  it('clearAliases 抹掉整张表', async () => {
    await learnPair('狂飙 电视剧', '狂飙');
    await clearAliases();
    expect(await lookupAliases('狂飙')).toEqual([]);
  });
});
