import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { SourceHealth } from '@/types';
import HealthBadge from '@/components/source/HealthBadge.vue';
import { HEALTH_TIER_LABELS } from '@/shared/healthTier';
import type { HealthTier } from '@/shared/healthTier';

/**
 * HealthBadge 测试（技术方案 17.3 / AC-106 / FR-47）
 *
 * - 传 `tier`：6 档文案 + 色调 + 延迟毫秒数（`bad` 保留具体故障文案）
 * - 不传 `tier`：既有 6 态 health 映射零回归
 * - `withText=false` 时用 sr 文案，`aria-label` 与可见文案一致
 *
 * 阈值字面量（300/800/2000）不出现在本文件：分级由 `healthTierOf` 负责，
 * 组件只消费档位，故此处直接以 tier 驱动断言。
 */

const ALL_TIERS: HealthTier[] = ['fast', 'good', 'fair', 'slow', 'bad', 'unknown'];

function mountBadge(props: Record<string, unknown>) {
  return mount(HealthBadge, { props: { health: 'ok' as SourceHealth, ...props } });
}

describe('HealthBadge · tier 模式（CHG-05）', () => {
  it('六档文案来自 HEALTH_TIER_LABELS', () => {
    for (const tier of ALL_TIERS) {
      const wrapper = mountBadge({ tier, latencyMs: 128 });
      // bad 例外：显示具体故障文案（见下一条用例），此处只断言非空
      const text = wrapper.find('.health-badge').text();
      expect(text.length).toBeGreaterThan(0);
      if (tier !== 'bad') expect(text).toContain(HEALTH_TIER_LABELS[tier]);
      wrapper.unmount();
    }
  });

  it('六档色调映射：fast=紫 / good=绿 / fair=黄 / slow=灰 / bad=红 / unknown=中性', () => {
    const expected: Record<HealthTier, string> = {
      fast: 'health-badge--fast',
      good: 'health-badge--success',
      fair: 'health-badge--warning',
      slow: 'health-badge--neutral',
      bad: 'health-badge--danger',
      unknown: 'health-badge--neutral',
    };
    for (const tier of ALL_TIERS) {
      const wrapper = mountBadge({ tier, latencyMs: 128 });
      expect(wrapper.find('.health-badge').classes()).toContain(expected[tier]);
      wrapper.unmount();
    }
  });

  it('fast 档使用紫色 token 类而非硬编码颜色', () => {
    const wrapper = mountBadge({ tier: 'fast', latencyMs: 128 });
    expect(wrapper.find('.health-badge').classes()).toContain('health-badge--fast');
    expect(wrapper.find('.health-badge').attributes('data-tier')).toBe('fast');
  });

  it('可用档位追加延迟毫秒数（例：极速 128ms）', () => {
    expect(mountBadge({ tier: 'fast', latencyMs: 128 }).text()).toBe('极速 128ms');
    expect(mountBadge({ tier: 'good', latencyMs: 620 }).text()).toBe('快速 620ms');
    expect(mountBadge({ tier: 'fair', latencyMs: 1500 }).text()).toBe('一般 1500ms');
    expect(mountBadge({ tier: 'slow', latencyMs: 2500 }).text()).toBe('较慢 2500ms');
  });

  it('延迟取整为整数毫秒', () => {
    expect(mountBadge({ tier: 'fast', latencyMs: 128.6 }).text()).toBe('极速 129ms');
  });

  it('bad 档显示 health 的具体故障文案，不显示延迟', () => {
    const cases: Array<[SourceHealth, string]> = [
      ['auth_failed', '认证失败'],
      ['timeout', '连接超时'],
      ['unreachable', '无法连接'],
      ['bad_config', '配置有误'],
    ];
    for (const [health, label] of cases) {
      const wrapper = mountBadge({ tier: 'bad', health, latencyMs: 500 });
      expect(wrapper.text()).toBe(label);
      wrapper.unmount();
    }
  });

  it('unknown 档不显示延迟', () => {
    expect(mountBadge({ tier: 'unknown', health: 'unknown', latencyMs: 128 }).text()).toBe('未检测');
  });

  it('延迟为 null / 负数 / 非有限数时不显示毫秒数', () => {
    for (const latencyMs of [null, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const wrapper = mountBadge({ tier: 'fast', latencyMs });
      expect(wrapper.text()).toBe('极速');
      wrapper.unmount();
    }
  });

  it('aria-label 与可见文案一致', () => {
    const wrapper = mountBadge({ tier: 'good', latencyMs: 620 });
    expect(wrapper.find('.health-badge').attributes('aria-label')).toBe('快速 620ms');
  });

  it('withText=false 时用 sr 文案输出同内容', () => {
    const wrapper = mountBadge({ tier: 'fast', latencyMs: 128, withText: false });
    expect(wrapper.find('.health-badge__sr').text()).toBe('极速 128ms');
    expect(wrapper.find('.health-badge').attributes('aria-label')).toBe('极速 128ms');
  });
});

describe('HealthBadge · 无 tier 向后兼容', () => {
  const legacy: Array<[SourceHealth, string, string]> = [
    ['ok', '正常', 'health-badge--success'],
    ['auth_failed', '认证失败', 'health-badge--danger'],
    ['timeout', '连接超时', 'health-badge--info'],
    ['unreachable', '无法连接', 'health-badge--danger'],
    ['bad_config', '配置有误', 'health-badge--warning'],
    ['unknown', '未检测', 'health-badge--neutral'],
  ];

  it('6 态文案与色调与 v1.1 一致（忽略 latencyMs）', () => {
    for (const [health, label, tone] of legacy) {
      const wrapper = mountBadge({ health, latencyMs: 128 });
      expect(wrapper.text()).toBe(label);
      expect(wrapper.find('.health-badge').classes()).toContain(tone);
      wrapper.unmount();
    }
  });

  it('data-tier 缺省，不渲染档位语义', () => {
    const wrapper = mountBadge({ health: 'ok' });
    expect(wrapper.find('.health-badge').attributes('data-tier')).toBeUndefined();
    expect(wrapper.find('.health-badge').attributes('data-tier')).not.toBe('fast');
  });

  it('withText=false 沿用 sr 文案', () => {
    const wrapper = mountBadge({ health: 'timeout', withText: false });
    expect(wrapper.find('.health-badge__sr').text()).toBe('连接超时');
  });

  it('neutral 底色改用 --color-border token（不再硬编码 rgba）', () => {
    const wrapper = mountBadge({ health: 'unknown' });
    const style = wrapper.find('.health-badge').classes();
    expect(style).toContain('health-badge--neutral');
    // 组件内不得出现硬编码 rgba 背景
    expect(wrapper.html()).not.toContain('rgba(255, 255, 255, 0.08)');
  });
});
