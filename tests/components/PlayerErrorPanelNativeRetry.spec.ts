/**
 * 「用原生引擎重试」出口（OPT-26 / P1-②-3）
 *
 * 真机那一轮 `<video>` 报 code 4、面板只给「换线路 / 重试」，而解码能力更高的
 * ExoPlayer 从没被用过一次——入口原先只存在于黑屏兜底（"有声音没画面"），
 * 「加载就失败」这条链上没有。面板自己不判该不该出现（它不知道本轮走过哪个引擎），
 * 只按 View 传下来的 `canRetryNative` 渲染；闸门口径在 `PlayerView.canRetryNative`。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PlayerErrorPanel from '@/components/player/PlayerErrorPanel.vue';
import type { AppErrorShape } from '@/types';

/** `<video>` 报 MEDIA_ERR_SRC_NOT_SUPPORTED 经引擎链归属后面板看到的形状 */
function capabilityError(): AppErrorShape {
  return {
    code: 'E_UNSUPPORTED_FORMAT',
    message: '格式不支持：MEDIA_SRC_NOT_SUPPORTED',
    detail: '原生: Something in ExoPlayer；内置: 格式不支持：MEDIA_SRC_NOT_SUPPORTED',
    retryable: true,
    httpStatus: null,
    reason: 'player_capability',
  };
}

describe('播放错误面板的原生引擎出口', () => {
  it('canRetryNative 为真：按钮出现在重试之后，点下去发 retry-native', async () => {
    const wrapper = mount(PlayerErrorPanel, {
      props: { error: capabilityError(), canRetryNative: true },
    });
    const cta = wrapper.get('[data-test="retry-native-cta"]');
    expect(cta.text()).toBe('用原生引擎重试');
    await cta.trigger('click');
    expect(wrapper.emitted('retry-native')).toHaveLength(1);
    // 原有出口一个都不能被它挤掉
    expect(wrapper.find('[data-test="retry-cta"]').exists()).toBe(true);
  });

  it('默认不给（View 没接本轮引擎链时，不许凭空多一个动作）', () => {
    const wrapper = mount(PlayerErrorPanel, { props: { error: capabilityError() } });
    expect(wrapper.find('[data-test="retry-native-cta"]').exists()).toBe(false);
  });

  it('显式关断（本轮已用过原生引擎）：同样不出现', () => {
    const wrapper = mount(PlayerErrorPanel, {
      props: { error: capabilityError(), canRetryNative: false },
    });
    expect(wrapper.find('[data-test="retry-native-cta"]').exists()).toBe(false);
  });
});
