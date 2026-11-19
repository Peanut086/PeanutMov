import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { PlayLine } from '@/types';
import type { LineHealthStatus } from '@/services/lineHealthService';

/**
 * P1-4：线路可用性必须能被「读出来」
 *
 * 只有色点时，27 条线路里哪条是死的用户看不出来，收起态更是一片盲。
 * 现在补文字口径（可播 · 耗时 / 不可用），并把「当前线路不可用」提到 trigger 上。
 */

import LineSelector from '@/components/media/LineSelector.vue';

function lines(count: number): PlayLine[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `src-a:m1:${i}`,
    mediaId: 'src-a:m1',
    sourceId: 'src-a',
    name: `线路 ${i + 1}`,
    quality: null,
    format: 'mp4',
    index: i,
  }));
}

function mountSelector(overrides: {
  count?: number;
  modelValue?: string | null;
  statuses?: Record<string, LineHealthStatus>;
  latencies?: Record<string, number | null>;
} = {}) {
  const all = lines(overrides.count ?? 5);
  // BottomSheet 走 useHaptic → 设置 store，需要活动 pinia
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(LineSelector, {
    props: {
      lines: all,
      modelValue: overrides.modelValue ?? all[0]!.id,
      lineStatuses: new Map(Object.entries(overrides.statuses ?? {})),
      lineLatencies: new Map(Object.entries(overrides.latencies ?? {})),
    },
    global: { plugins: [pinia], stubs: { teleport: true } },
  });
}

async function openSheet(wrapper: ReturnType<typeof mountSelector>): Promise<void> {
  await wrapper.find('.line-selector__trigger').trigger('click');
}

describe('LineSelector 可用性文字', () => {
  it('当前线路判死时，收起态直接标出「不可用」', () => {
    const wrapper = mountSelector({ statuses: { 'src-a:m1:0': 'fail' } });
    expect(wrapper.find('.line-selector__warn').text()).toBe('不可用');
  });

  it('当前线路可播时，收起态不加警告', () => {
    const wrapper = mountSelector({ statuses: { 'src-a:m1:0': 'ok' } });
    expect(wrapper.find('.line-selector__warn').exists()).toBe(false);
  });

  it('弹层里逐条给出文字：可播带耗时，判死标不可用，没探过的留白', async () => {
    const wrapper = mountSelector({
      statuses: { 'src-a:m1:0': 'ok', 'src-a:m1:1': 'fail' },
      latencies: { 'src-a:m1:0': 320, 'src-a:m1:1': null },
    });
    await openSheet(wrapper);

    const metas = wrapper.findAll('.line-list__meta').map((node) => node.text());
    expect(metas).toEqual(['可播 · 320ms', '不可用']);
    expect(wrapper.findAll('.line-list__meta--ok')).toHaveLength(1);
    expect(wrapper.findAll('.line-list__meta--fail')).toHaveLength(1);
  });

  it('秒级耗时换算成 1.0s，亚秒取整到毫秒', async () => {
    const wrapper = mountSelector({
      statuses: { 'src-a:m1:0': 'ok', 'src-a:m1:1': 'ok' },
      latencies: { 'src-a:m1:0': 1000, 'src-a:m1:1': 0 },
    });
    await openSheet(wrapper);

    expect(wrapper.findAll('.line-list__meta').map((node) => node.text())).toEqual(['可播 · 1.0s', '可播']);
  });

  it('≤4 条线路的分段形态维持原样（不为此改共享组件）', () => {
    const wrapper = mountSelector({ count: 3, statuses: { 'src-a:m1:0': 'fail' } });
    expect(wrapper.find('.line-selector__warn').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('不可用');
  });
});
