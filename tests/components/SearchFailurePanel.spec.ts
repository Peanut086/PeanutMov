/**
 * SearchFailurePanel（OPT-04）：失败源汇总 + 明细默认折叠 + 只重试失败源
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SearchFailurePanel from '@/components/search/SearchFailurePanel.vue';
import { SEARCH_FAILURE_LABELS } from '@/services/searchAggregate';
import type { AppErrorShape } from '@/types';

function err(code: string, message = '搜索失败'): AppErrorShape {
  return { code, message, detail: null, retryable: true, httpStatus: null } as AppErrorShape;
}

const FAILURES = [
  { sourceId: 's1', error: err('E_NETWORK', '站点 500') },
  { sourceId: 's2', error: err('E_NETWORK', '站点 500') },
  { sourceId: 's3', error: err('E_TIMEOUT', '超时') },
];

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(SearchFailurePanel, {
    props: {
      failures: FAILURES,
      nameOf: (id: string) => `源 ${id}`,
      ...props,
    },
  });
}

describe('SearchFailurePanel · 空数据', () => {
  it('无失败源时不渲染面板（结果页不留空白条）', () => {
    const wrapper = mountPanel({ failures: [] });
    expect(wrapper.find('.fail-panel').exists()).toBe(false);
  });
});

describe('SearchFailurePanel · 汇总', () => {
  it('标题给出失败源数，原因聚类成一句话', () => {
    const wrapper = mountPanel();
    expect(wrapper.find('.fail-panel__title').text()).toBe('3 个源搜索失败');
    expect(wrapper.find('.fail-panel__reasons').text()).toBe(
      `2 ${SEARCH_FAILURE_LABELS.source_dead} · 1 ${SEARCH_FAILURE_LABELS.timeout}`,
    );
  });

  it('同一源重复失败只算一个（折叠列表不重复行）', () => {
    const wrapper = mountPanel({
      failures: [...FAILURES, { sourceId: 's1', error: err('E_TIMEOUT') }],
    });
    expect(wrapper.find('.fail-panel__title').text()).toBe('3 个源搜索失败');
  });
});

describe('SearchFailurePanel · 明细默认折叠', () => {
  it('初始折叠：aria-expanded=false，列表 display:none 但仍在 DOM（aria-controls 可解析）', () => {
    const wrapper = mountPanel();
    const toggle = wrapper.find('.fail-panel__toggle');
    const list = wrapper.find('.fail-panel__list');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.attributes('aria-controls')).toBe(list.attributes('id'));
    expect(list.attributes('style')).toContain('display: none');
  });

  it('点击展开：逐源明细可见，行内容 = 源名 + 分类标签', async () => {
    const wrapper = mountPanel();
    await wrapper.find('.fail-panel__toggle').trigger('click');

    expect(wrapper.find('.fail-panel__toggle').attributes('aria-expanded')).toBe('true');
    const list = wrapper.find('.fail-panel__list');
    expect(list.attributes('style') ?? '').not.toContain('display: none');
    const rows = list.findAll('.fail-panel__row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('源 s1');
    expect(rows[0]!.text()).toContain(SEARCH_FAILURE_LABELS.source_dead);
    expect(rows[2]!.text()).toContain(SEARCH_FAILURE_LABELS.timeout);
  });

  it('再次点击收起；展开态箭头方向为 up', async () => {
    const wrapper = mountPanel();
    const toggle = wrapper.find('.fail-panel__toggle');
    await toggle.trigger('click');
    expect(toggle.html()).toContain('rotate(270deg)');
    await toggle.trigger('click');
    expect(wrapper.find('.fail-panel__toggle').attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.fail-panel__list').attributes('style')).toContain('display: none');
  });

  it('无 detail 的行不渲染空明细段落', async () => {
    const wrapper = mountPanel({
      failures: [{ sourceId: 's1', error: err('E_TIMEOUT', '') }],
    });
    await wrapper.find('.fail-panel__toggle').trigger('click');
    expect(wrapper.findAll('.fail-panel__row')).toHaveLength(1);
    expect(wrapper.findAll('.fail-panel__row-detail')).toHaveLength(0);
  });
});

describe('SearchFailurePanel · 重试', () => {
  it('点击重试只 emit retry（请求由父级发起）', async () => {
    const wrapper = mountPanel();
    await wrapper.find('.fail-panel__retry').trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('重试中：按钮禁用且文案为「重试中…」，点击不再 emit', async () => {
    const wrapper = mountPanel({ retrying: true });
    const button = wrapper.find('.fail-panel__retry');
    expect(button.text()).toBe('重试中…');
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(wrapper.emitted('retry')).toBeUndefined();
  });

  it('主搜索进行中（busy）：按钮禁用，避免与主搜索抢同一批源', async () => {
    const wrapper = mountPanel({ busy: true });
    expect(wrapper.find('.fail-panel__retry').attributes('disabled')).toBeDefined();
  });
});
