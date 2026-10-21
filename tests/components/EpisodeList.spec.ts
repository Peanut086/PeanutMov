import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { Episode } from '@/types';
import EpisodeList from '@/components/media/EpisodeList.vue';

/**
 * EpisodeList 不可播分支（AC-33① / REV-20）
 *
 * 详情页播放前预检失败后把集 id 写入 `unavailableIds`：
 * - 该集渲染禁用态（`aria-disabled` + `title`）；
 * - 点击只 emit `unavailable`（就地 Toast），不 emit `select`（不跳转播放页）。
 */
function makeEpisode(number: number): Episode {
  return {
    id: `m:l:${number}`,
    mediaId: 'm',
    sourceId: 'demo',
    lineId: 'l',
    number,
    title: `第 ${number} 集`,
    durationSec: 600,
    subtitles: [],
    updatedAt: 0,
  };
}

describe('EpisodeList 不可播禁用态（AC-33① / REV-20）', () => {
  it('unavailableIds 命中的集渲染禁用态与说明', () => {
    const wrapper = mount(EpisodeList, {
      props: { episodes: [makeEpisode(1), makeEpisode(2)], unavailableIds: ['m:l:2'] },
    });
    const chips = wrapper.findAll('.episode-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.classes()).not.toContain('episode-chip--unavailable');
    expect(chips[1]?.classes()).toContain('episode-chip--unavailable');
    expect(chips[1]?.attributes('aria-disabled')).toBe('true');
    expect(chips[1]?.attributes('title')).toBe('该集暂无可播放地址');
    expect(chips[1]?.attributes('aria-label')).toContain('暂无可播放地址');
  });

  it('点击不可播集只 emit unavailable，可播集 emit select', async () => {
    const wrapper = mount(EpisodeList, {
      props: { episodes: [makeEpisode(1), makeEpisode(2)], unavailableIds: ['m:l:2'] },
    });
    const chips = wrapper.findAll('.episode-chip');
    await chips[1]?.trigger('click');
    await chips[0]?.trigger('click');
    expect(wrapper.emitted('unavailable')).toHaveLength(1);
    expect(wrapper.emitted('unavailable')?.[0]?.[0]).toMatchObject({ id: 'm:l:2' });
    expect(wrapper.emitted('select')).toHaveLength(1);
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ id: 'm:l:1' });
  });
});
