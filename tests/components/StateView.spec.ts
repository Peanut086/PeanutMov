import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import StateView from '@/components/common/StateView.vue';

/**
 * StateView 四态测试（技术方案 8.2 / 页面蓝图 §20.3）
 *
 * 断言点：
 * - loading 显示 spinner 与文案
 * - empty 显示标题/说明与可执行按钮，并触发 empty-action
 * - error 显示本地化文案，仅 retryable 时出现「重试」
 * - offline 提供返回入口
 * - success / refreshing 渲染默认插槽（不覆盖真实内容）
 */
describe('StateView 四态', () => {
  it('loading：渲染 spinner，不渲染内容插槽', () => {
    const wrapper = mount(StateView, {
      props: { state: 'loading', loadingText: '正在加载列表…' },
      slots: { default: '<div data-test="content">真实内容</div>' },
    });
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('正在加载列表…');
    expect(wrapper.find('[data-test="content"]').exists()).toBe(false);
  });

  it('empty：默认空态带标题、说明与按钮，点击触发 empty-action', async () => {
    const wrapper = mount(StateView, {
      props: {
        state: 'empty',
        emptyTitle: '该分类暂无内容',
        emptyDesc: '换个分类或刷新试试',
        emptyAction: '刷新',
      },
    });
    expect(wrapper.text()).toContain('该分类暂无内容');
    expect(wrapper.text()).toContain('换个分类或刷新试试');

    const action = wrapper.findAll('button').find((b) => b.text() === '刷新');
    expect(action).toBeTruthy();
    await action!.trigger('click');
    expect(wrapper.emitted('empty-action')).toHaveLength(1);
  });

  it('error：展示 error.message；retryable=true 时显示重试并 emit retry', async () => {
    const wrapper = mount(StateView, {
      props: {
        state: 'error',
        error: {
          code: 'E_NOT_FOUND',
          message: '内容不存在',
          detail: null,
          retryable: true,
          httpStatus: 404,
        },
      },
    });
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('内容不存在');

    const retry = wrapper.findAll('button').find((b) => b.text() === '重试');
    expect(retry).toBeTruthy();
    await retry!.trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('error：retryable=false 时不显示重试，仅显示返回', async () => {
    const wrapper = mount(StateView, {
      props: {
        state: 'error',
        backText: '返回',
        error: {
          code: 'E_UNSUPPORTED_FORMAT',
          message: '暂不支持该格式',
          detail: 'mime=application/dash+xml',
          retryable: false,
          httpStatus: null,
        },
      },
    });
    expect(wrapper.text()).toContain('暂不支持该格式');
    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels).not.toContain('重试');
    expect(labels).toContain('返回');
  });

  it('offline：显示离线说明，返回按钮触发 back', async () => {
    const wrapper = mount(StateView, {
      props: { state: 'offline', offlineText: '离线且没有缓存' },
    });
    expect(wrapper.text()).toContain('离线且没有缓存');
    const back = wrapper.findAll('button').find((b) => b.text() === '返回');
    await back!.trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
  });

  it('success / refreshing：渲染默认插槽内容', () => {
    const success = mount(StateView, {
      props: { state: 'success' },
      slots: { default: '<div data-test="content">已加载</div>' },
    });
    expect(success.find('[data-test="content"]').text()).toBe('已加载');

    const refreshing = mount(StateView, {
      props: { state: 'refreshing' },
      slots: { default: '<div data-test="content">刷新中仍可见</div>' },
    });
    expect(refreshing.find('[data-test="content"]').exists()).toBe(true);
  });
});
