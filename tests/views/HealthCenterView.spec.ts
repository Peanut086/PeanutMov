/**
 * 健康中心页面 + 四个子组件单测（EXT-01）
 *
 * 文件范围限制下（仅允许 tests/views/HealthCenterView.spec.ts 与
 * tests/services/healthCenterService.spec.ts），四个新建组件的用例集中在本文件。
 *
 * 页面用例只做「装配」验证：批量动作在 store 层被 spy 替换，
 * 不触发真实网络探测；数据来源用 `sourceRepo` 直接播种。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
}));

import HealthCenterView from '@/views/HealthCenterView.vue';
import BatchActions from '@/components/health/BatchActions.vue';
import FailureDistribution from '@/components/health/FailureDistribution.vue';
import HealthSummary from '@/components/health/HealthSummary.vue';
import HealthTrend from '@/components/health/HealthTrend.vue';

import { sourceRepo } from '@/db/repositories/sourceRepo';
import { sourceService } from '@/services/sourceService';
import {
  buildTrendSeries,
  failureDistributionOf,
  type HealthCenterSummary,
  type HealthTrendPoint,
} from '@/services/healthCenterService';
import { useSourceStore } from '@/stores/sourceStore';
import { useUiStore } from '@/stores/uiStore';
import type { Source } from '@/types';

import { resetAll } from '../unit/helpers';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 等 IndexedDB / 微任务链路落定（loadHealthCenter 内部有多次 await） */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

function makeSource(overrides: Partial<Source> = {}): Source {
  const now = Date.now();
  return {
    id: overrides.id ?? 'source-1',
    key: overrides.key ?? overrides.id ?? 'source-1',
    name: overrides.name ?? '测试源',
    type: 'site',
    enabled: overrides.enabled ?? true,
    builtin: false,
    sort: overrides.sort ?? 0,
    baseUrl: 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: overrides.health ?? 'unknown',
    healthCheckedAt: overrides.healthCheckedAt ?? null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 4 个源：1 健康 / 1 超时（启用）/ 1 未检测 / 1 无法连接（已禁用） */
async function seedSources(): Promise<void> {
  await sourceRepo.save(makeSource({ id: 'a-ok', name: '正常源', health: 'ok' }));
  await sourceRepo.save(
    makeSource({ id: 'b-timeout', name: '超时源', health: 'timeout', healthCheckedAt: Date.now() }),
  );
  await sourceRepo.save(makeSource({ id: 'c-unknown', name: '未检测源', health: 'unknown' }));
  await sourceRepo.save(
    makeSource({ id: 'd-dead', name: '死源', health: 'unreachable', enabled: false }),
  );
}

function findButton(wrapper: VueWrapper, text: string): DOMWrapper<Element> {
  const found = wrapper.findAll('button').find((node) => node.text().includes(text));
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
}

const BASE_SUMMARY: HealthCenterSummary = {
  total: 6,
  healthy: 4,
  failed: 1,
  unknown: 1,
  disabled: 2,
};

describe('HealthSummary（EXT-01 汇总卡）', () => {
  it('默认态渲染四项计数与已禁用副标题', () => {
    const wrapper = mount(HealthSummary, { props: { summary: BASE_SUMMARY } });
    expect(wrapper.findAll('.health-summary__tile')).toHaveLength(4);
    expect(wrapper.findAll('.health-summary__value').map((node) => node.text())).toEqual([
      '6',
      '4',
      '1',
      '1',
    ]);
    expect(wrapper.text()).toContain('其中 2 个已禁用');
  });

  it('空数据：保留 0 值并给出引导', () => {
    const wrapper = mount(HealthSummary, {
      props: { summary: { total: 0, healthy: 0, failed: 0, unknown: 0, disabled: 0 } },
    });
    expect(wrapper.text()).toContain('尚未添加任何源');
  });

  it('加载中：四个骨架块占位', () => {
    const wrapper = mount(HealthSummary, { props: { summary: BASE_SUMMARY, loading: true } });
    expect(wrapper.findAll('.skeleton')).toHaveLength(4);
  });
});

function trendPoints(): HealthTrendPoint[] {
  return buildTrendSeries(
    [{ date: '2026-11-06', total: 4, healthy: 3, failed: 1, unknown: 0 }],
    new Date(2026, 10, 6, 12, 0).getTime(),
  );
}

describe('HealthTrend（EXT-01 趋势图）', () => {
  it('渲染 7 个槽位，已采集日显示健康率，未采集日只显示占位', () => {
    const wrapper = mount(HealthTrend, { props: { points: trendPoints() } });
    expect(wrapper.findAll('.health-trend__col')).toHaveLength(7);
    expect(wrapper.findAll('.health-trend__bar')).toHaveLength(1);
    expect(wrapper.find('.health-trend__bar').classes()).toContain('health-trend__bar--warning');
    expect(wrapper.text()).toContain('75%');
    expect(wrapper.text()).toContain('已采集 1/7 天');
  });

  it('空数据：全未采集时给出说明', () => {
    const wrapper = mount(HealthTrend, {
      props: { points: buildTrendSeries([], new Date(2026, 10, 6, 12, 0).getTime()) },
    });
    expect(wrapper.text()).toContain('暂无历史趋势');
  });

  it('并发/异常数据：只取最后 7 个点，色调按健康率分档', () => {
    const points: HealthTrendPoint[] = [
      { date: '2026-10-29', label: '10-29', total: 1, healthy: 1, failed: 0, unknown: 0, recorded: true, healthRate: 100 },
      { date: '2026-10-30', label: '10-30', total: 1, healthy: 0, failed: 1, unknown: 0, recorded: true, healthRate: 0 },
      { date: '2026-10-31', label: '10-31', total: 10, healthy: 9, failed: 1, unknown: 0, recorded: true, healthRate: 90 },
      { date: '2026-11-01', label: '11-01', total: 10, healthy: 6, failed: 4, unknown: 0, recorded: true, healthRate: 60 },
      { date: '2026-11-02', label: '11-02', total: 10, healthy: 3, failed: 7, unknown: 0, recorded: true, healthRate: 30 },
      { date: '2026-11-03', label: '11-03', total: 0, healthy: 0, failed: 0, unknown: 0, recorded: false, healthRate: 0 },
      { date: '2026-11-04', label: '11-04', total: 10, healthy: 8, failed: 2, unknown: 0, recorded: true, healthRate: 80 },
      { date: '2026-11-05', label: '11-05', total: 10, healthy: 5, failed: 5, unknown: 0, recorded: true, healthRate: 50 },
    ];
    const wrapper = mount(HealthTrend, { props: { points } });
    expect(wrapper.findAll('.health-trend__col')).toHaveLength(7);
    expect(wrapper.findAll('.health-trend__bar--success')).toHaveLength(2);
    expect(wrapper.findAll('.health-trend__bar--warning')).toHaveLength(2);
    expect(wrapper.findAll('.health-trend__bar--danger')).toHaveLength(2);
    // 柱高被收敛在 4%~100%（0% 留可见底线，越界不溢出容器）
    const heights = wrapper.findAll('.health-trend__bar').map((node) => {
      const style = node.attributes('style') ?? '';
      const matched = /height:\s*([\d.]+)%/.exec(style);
      return matched ? Number(matched[1]) : Number.NaN;
    });
    expect(heights.every((height) => Number.isFinite(height) && height >= 4 && height <= 100)).toBe(
      true,
    );
  });

  it('加载中：骨架块替代柱图', () => {
    const wrapper = mount(HealthTrend, { props: { points: [], loading: true } });
    expect(wrapper.find('.health-trend__skeleton').exists()).toBe(true);
    expect(wrapper.findAll('.health-trend__col')).toHaveLength(0);
  });
});

describe('FailureDistribution（EXT-01 失败分布）', () => {
  it('按原因渲染行、数量与占比条', () => {
    const buckets = failureDistributionOf([
      makeSource({ id: 'a', health: 'unreachable' }),
      makeSource({ id: 'b', health: 'unreachable' }),
      makeSource({ id: 'c', health: 'timeout' }),
    ]);
    const wrapper = mount(FailureDistribution, { props: { buckets, failedTotal: 3 } });
    expect(wrapper.findAll('.failure-dist__row')).toHaveLength(2);
    expect(wrapper.text()).toContain('共 3 个失败源');
    expect(wrapper.text()).toContain('无法连接');
    expect(wrapper.text()).toContain('2 个 · 67%');
    const bars = wrapper.findAll('.failure-dist__bar');
    expect(bars[0].attributes('style')).toContain('width: 67%');
    expect(bars[0].classes()).toContain('failure-dist__bar--unreachable');
  });

  it('空数据：成功态提示且不渲染占比条', () => {
    const wrapper = mount(FailureDistribution, { props: { buckets: [], failedTotal: 0 } });
    expect(wrapper.findAll('.failure-dist__row')).toHaveLength(0);
    expect(wrapper.text()).toContain('当前没有被判定为失败的源');
  });

  it('异常数据：占比越界收敛到 0~100', () => {
    const wrapper = mount(FailureDistribution, {
      props: {
        buckets: [
          { reason: 'timeout', label: '连接超时', hint: 'h', count: 2, ratio: 1, percent: 140 },
          { reason: 'bad_config', label: '配置有误', hint: 'h', count: 1, ratio: -0.2, percent: -20 },
        ],
        failedTotal: 3,
      },
    });
    const bars = wrapper.findAll('.failure-dist__bar');
    expect(bars[0].attributes('style')).toContain('width: 100%');
    expect(bars[1].attributes('style')).toContain('width: 0%');
  });

  it('加载中：两行骨架', () => {
    const wrapper = mount(FailureDistribution, {
      props: { buckets: [], failedTotal: 0, loading: true },
    });
    expect(wrapper.findAll('.skeleton')).toHaveLength(2);
  });
});

describe('BatchActions（EXT-01 批量操作）', () => {
  it('渲染三个动作与目标数量，点击分别派发事件', async () => {
    const wrapper = mount(BatchActions, {
      props: { failedCount: 3, cleanupCount: 3, disabledCount: 2 },
    });
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].text()).toContain('复检失败源（3）');
    expect(buttons[1].text()).toContain('清理失败源（3）');
    expect(buttons[2].text()).toContain('恢复已禁用源（2）');

    for (const button of buttons) await button.trigger('click');
    expect(wrapper.emitted('recheck')).toHaveLength(1);
    expect(wrapper.emitted('cleanup')).toHaveLength(1);
    expect(wrapper.emitted('restore')).toHaveLength(1);
  });

  it('目标为 0 时全部禁用并给出说明', () => {
    const wrapper = mount(BatchActions, {
      props: { failedCount: 0, cleanupCount: 0, disabledCount: 0 },
    });
    const buttons = wrapper.findAll('button');
    expect(buttons.every((button) => button.attributes('disabled') !== undefined)).toBe(true);
    expect(wrapper.text()).toContain('当前没有可批量处理的源');
  });

  it('进行中：显示进度文案并锁住其余入口', () => {
    const wrapper = mount(BatchActions, {
      props: {
        failedCount: 1,
        cleanupCount: 1,
        disabledCount: 1,
        busy: 'cleanup',
        progressText: '处理中 1/2',
      },
    });
    expect(wrapper.text()).toContain('处理中 1/2');
    const buttons = wrapper.findAll('button');
    expect(buttons.every((button) => button.attributes('disabled') !== undefined)).toBe(true);
  });

  it('复检进行中：出现取消入口并可派发 cancel', async () => {
    const wrapper = mount(BatchActions, {
      props: {
        failedCount: 1,
        cleanupCount: 1,
        disabledCount: 1,
        busy: 'recheck',
        rechecking: true,
        progressText: '复检中 0/1',
      },
    });
    expect(wrapper.text()).toContain('复检中 0/1');
    const cancel = findButton(wrapper, '取消复检');
    await cancel.trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});

describe('HealthCenterView（EXT-01 页面装配）', () => {
  beforeEach(async () => {
    await resetAll();
    setActivePinia(createPinia());
    routerMocks.back.mockClear();
    routerMocks.push.mockClear();
    routerMocks.replace.mockClear();
  });

  it('渲染汇总 / 趋势 / 失败分布 / 批量入口', async () => {
    await seedSources();
    const wrapper = mount(HealthCenterView);
    await settle();

    expect(wrapper.findAll('.health-summary__value').map((node) => node.text())).toEqual([
      '4',
      '1',
      '2',
      '1',
    ]);
    expect(wrapper.findAll('.health-trend__col')).toHaveLength(7);
    expect(wrapper.findAll('.failure-dist__label').map((node) => node.text())).toEqual([
      '连接超时',
      '无法连接',
    ]);
    const body = wrapper.text();
    expect(body).toContain('复检失败源（1）');
    expect(body).toContain('清理失败源（1）');
    expect(body).toContain('恢复已禁用源（1）');
    expect(body).toContain('趋势快照保存在本机');
  });

  it('无源时展示空态，主按钮跳转设置页源管理区', async () => {
    const wrapper = mount(HealthCenterView);
    await settle();

    expect(wrapper.text()).toContain('还没有可治理的源');
    const action = wrapper.find('.empty-state__action');
    expect(action.exists()).toBe(true);
    await action.trigger('click');
    expect(routerMocks.push).toHaveBeenCalledWith({
      name: 'settings',
      query: { sources: '1' },
    });
  });

  it('源表读取失败时展示错误态，重试后恢复', async () => {
    const listSpy = vi.spyOn(sourceService, 'list').mockRejectedValueOnce(new Error('db down'));
    const wrapper = mount(HealthCenterView);
    await settle();

    expect(wrapper.find('.error-state').exists()).toBe(true);
    expect(wrapper.find('.health-summary').exists()).toBe(false);

    await findButton(wrapper, '重试').trigger('click');
    await settle();
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.error-state').exists()).toBe(false);
    expect(wrapper.text()).toContain('还没有可治理的源');
    listSpy.mockRestore();
  });

  it('复检按钮调用 store.recheckFailedSources', async () => {
    await seedSources();
    const wrapper = mount(HealthCenterView);
    await settle();
    const store = useSourceStore();
    const recheck = vi.spyOn(store, 'recheckFailedSources').mockResolvedValue(1);

    await findButton(wrapper, '复检失败源').trigger('click');
    await settle(2);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('清理失败源：取消确认不执行，确认后执行一次', async () => {
    await seedSources();
    const wrapper = mount(HealthCenterView);
    await settle();
    const store = useSourceStore();
    const ui = useUiStore();
    const cleanup = vi
      .spyOn(store, 'cleanupFailedSources')
      .mockResolvedValue({ done: 1, failed: 0 });
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(false);

    await findButton(wrapper, '清理失败源').trigger('click');
    await settle(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await findButton(wrapper, '清理失败源').trigger('click');
    await settle(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('恢复已禁用源：确认后调用批量恢复并提示失败数', async () => {
    await seedSources();
    const wrapper = mount(HealthCenterView);
    await settle();
    const store = useSourceStore();
    const ui = useUiStore();
    const restore = vi
      .spyOn(store, 'restoreDisabledSources')
      .mockResolvedValue({ done: 1, failed: 1 });
    vi.spyOn(ui, 'confirm').mockResolvedValue(true);

    await findButton(wrapper, '恢复已禁用源').trigger('click');
    await settle(2);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
