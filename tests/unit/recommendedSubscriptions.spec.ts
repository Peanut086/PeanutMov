import { describe, expect, it } from 'vitest';

import { recommendedSubscriptions } from '@/data/recommended/recommended';

/**
 * FIX-02 / AC-130 回归：内置推荐订阅清单的可见条数与敏感词口径
 *
 * 旧口径把 `vip` 作用到 URL 上，`*.kstore.vip` 的 3 条托管源被整体剔除，
 * 列表只剩 7 条，跌破 AC-130「数量 8~12」的下限。
 * Q-01 决策 A：敏感词只匹配 `name` / `note`，URL 不做敏感词判定（域名只做协议校验）。
 */
const FORBIDDEN = /破解|盗版|18\+|成人|r18|nsfw|vip|付费|会员/i;

describe('AC-130 内置推荐订阅清单', () => {
  it('可见条数落在 8~12 之间（当前应为 10）', () => {
    const manifest = recommendedSubscriptions();
    expect(manifest.items.length).toBeGreaterThanOrEqual(8);
    expect(manifest.items.length).toBeLessThanOrEqual(12);
    expect(manifest.items).toHaveLength(10);
  });

  it('vip 域名不被误杀：3 条 *.kstore.vip 托管源全部保留', () => {
    const urls = recommendedSubscriptions().items.map((item) => item.url);
    expect(urls).toContain('https://9280.kstore.vip/newwex.json');
    expect(urls).toContain('https://9763.kstore.vip/aowu.json');
    expect(urls).toContain('https://6800.kstore.vip/fish.json');
  });

  it('保留条目的 name / note 对敏感词表零命中（AC-130 原文口径）', () => {
    for (const item of recommendedSubscriptions().items) {
      expect(FORBIDDEN.test(`${item.name} ${item.note}`), `${item.name} 命中敏感词`).toBe(false);
    }
  });

  it('保留条目字段合法：协议为 http(s)、name/url 非空', () => {
    for (const item of recommendedSubscriptions().items) {
      expect(item.name.trim().length).toBeGreaterThan(0);
      expect(item.url).toMatch(/^https?:\/\//i);
    }
  });
});
