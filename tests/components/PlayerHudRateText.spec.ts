/**
 * 手势 HUD 文案（设计规范 ⑦ `pl-hud`）
 *
 * 只钉一条容易再犯的口径：倍速提示必须念"长按档"（`value`），不能念用户选的基准倍速。
 * 念基准会输出「1x 快进中」这种自相矛盾的话，还会让人以为提示是跟着自己选的倍速来的
 * （真机 11-21 就是把它当成了"选了倍速才一直显示快进"）。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PlayerHud from '@/components/player/PlayerHud.vue';

function title(kind: string, value: number): string {
  return mount(PlayerHud, { props: { kind: kind as never, value } }).get('.pl-hud__title').text();
}

describe('倍速提示文案', () => {
  it('念长按档，而不是基准倍速', () => {
    expect(title('rate', 2)).toBe('2x 快进中');
    expect(title('rate', 3)).toBe('3x 快进中');
  });
});
