import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FIX-02 / AC-130 回归：敏感词作用域（Q-01 决策 A）
 *
 * 用受控清单替换随包 JSON，验证过滤规则本身：
 * - `name` / `note` 命中敏感词 → 剔除；
 * - 只有 URL 主机含敏感词（如 `*.kstore.vip`）→ **保留**；
 * - 非 http(s) 地址 → 剔除。
 */
vi.mock('@/data/recommended/recommended.json', () => ({
  default: {
    version: 99,
    updatedAt: '2026-11-06',
    note: '测试清单',
    items: [
      { name: '正常托管源', url: 'https://9280.kstore.vip/newwex.json', note: 'kstore 托管', tags: ['综合'] },
      { name: 'VIP 专区', url: 'https://vip.example.com/ok.json', note: '普通说明', tags: [] },
      { name: '普通名字', url: 'https://ok.example.com/a.json', note: '含付费说明', tags: [] },
      { name: '另一条', url: 'https://ok.example.com/b.json', note: '会员制', tags: [] },
      { name: '坏协议', url: 'ftp://ok.example.com/c.json', note: '', tags: [] },
      { name: '', url: 'https://ok.example.com/d.json', note: '', tags: [] },
    ],
  },
}));

import { recommendedSubscriptions, resetRecommendedCache } from '@/data/recommended/recommended';

describe('AC-130 敏感词作用域：只匹配 name/note，不匹配 URL', () => {
  beforeEach(() => {
    resetRecommendedCache();
  });

  it('同一清单里只保留唯一合规条目（vip 域名的条目保留，文案命中的剔除）', () => {
    const items = recommendedSubscriptions().items;
    expect(items.map((item) => item.name)).toEqual(['正常托管源']);
    expect(items[0]!.url).toBe('https://9280.kstore.vip/newwex.json');
  });

  it('剔除条目不会以「空壳」形式残留（无 name / 坏协议都出局）', () => {
    const names = recommendedSubscriptions().items.map((item) => item.name);
    expect(names).not.toContain('');
    expect(names).not.toContain('坏协议');
  });
});
