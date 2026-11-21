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

/**
 * 胶片墙模式（G-B07）
 *
 * 这个组件不认识抽帧，只负责三件事：有画面就画、没画面留底板、状态一个都不能少。
 * 最关键的一条是"不骗人"：没抽出来的格子必须是真空板，不能拿海报或邻集顶一张。
 */
describe('EpisodeList 胶片墙模式（G-B07）', () => {
  const EPISODES = [makeEpisode(1), makeEpisode(2), makeEpisode(3)];
  const FRAMES = { 'm:l:1': 'data:image/jpeg;base64,AAA', 'm:l:2': 'data:image/jpeg;base64,BBB' };

  it('不传 film 时保持数字芯片，一点没变', () => {
    const wrapper = mount(EpisodeList, { props: { episodes: EPISODES } });
    expect(wrapper.find('.ep-film').exists()).toBe(false);
    expect(wrapper.find('.episode-chip__number').exists()).toBe(true);
    expect(wrapper.find('.episode-list__grid--film').exists()).toBe(false);
  });

  it('胶片模式：底板 + 上下齿孔 + 集数胶囊，数字芯片不再渲染', () => {
    const wrapper = mount(EpisodeList, { props: { episodes: EPISODES, film: true, filmFrames: FRAMES } });
    expect(wrapper.find('.episode-list__grid--film').exists()).toBe(true);
    expect(wrapper.findAll('.ep-film')).toHaveLength(3);
    expect(wrapper.findAll('.ep-film__plate')).toHaveLength(3);
    expect(wrapper.findAll('.ep-film__count')).toHaveLength(3);
    expect(wrapper.find('.episode-chip__number').exists()).toBe(false);
    // 过片语言公共件：一格上下各一条齿孔
    expect(wrapper.findAll('.film-perf--top')).toHaveLength(3);
    expect(wrapper.findAll('.film-perf--bottom')).toHaveLength(3);
  });

  it('有画面才出 <img>，没抽出来的格子就是真空板', () => {
    const wrapper = mount(EpisodeList, { props: { episodes: EPISODES, film: true, filmFrames: FRAMES } });
    const images = wrapper.findAll('.ep-film__frame');
    expect(images).toHaveLength(2);
    expect(images[0]?.attributes('src')).toBe(FRAMES['m:l:1']);
    expect(images[1]?.attributes('src')).toBe(FRAMES['m:l:2']);
    const third = wrapper.findAll('.ep-film')[2];
    expect(third?.find('.ep-film__frame').exists()).toBe(false);
    // 空板不能伪装成"正在抽"——第 3 集既没画面也不在队列里
    expect(third?.classes()).not.toContain('ep-film--waiting');
  });

  it('排队中的格子出呼吸底板，抽完自己消失', async () => {
    const wrapper = mount(EpisodeList, {
      props: { episodes: EPISODES, film: true, filmFrames: FRAMES, filmWaiting: ['m:l:3'] },
    });
    const waiting = wrapper.find('.ep-film--waiting');
    expect(waiting?.exists()).toBe(true);
    expect(wrapper.findAll('.ep-film__frame')).toHaveLength(2);

    await wrapper.setProps({ filmWaiting: [] });
    expect(wrapper.find('.ep-film--waiting').exists()).toBe(false);
  });

  it('可访问名与数字模式逐字一致，换排布不换读法', () => {
    const numberMode = mount(EpisodeList, { props: { episodes: EPISODES } });
    const filmMode = mount(EpisodeList, { props: { episodes: EPISODES, film: true, filmFrames: FRAMES } });
    expect(filmMode.findAll('.episode-chip').map((c) => c.attributes('aria-label'))).toEqual(
      numberMode.findAll('.episode-chip').map((c) => c.attributes('aria-label')),
    );
  });

  it('当前集 / 已看 / 已下载 / 不可播状态在胶片上一不打折', () => {
    const wrapper = mount(EpisodeList, {
      props: {
        episodes: EPISODES,
        film: true,
        filmFrames: FRAMES,
        currentId: 'm:l:1',
        watchedNumbers: [1],
        downloadedIds: ['m:l:1'],
        unavailableIds: ['m:l:3'],
      },
    });
    const chips = wrapper.findAll('.ep-film');
    expect(chips[0]?.classes()).toContain('episode-chip--current');
    expect(chips[0]?.find('.episode-chip__check').exists()).toBe(true);
    expect(chips[0]?.find('.ep-film__dot').exists()).toBe(true);
    expect(chips[2]?.classes()).toContain('episode-chip--unavailable');
    expect(chips[2]?.attributes('aria-disabled')).toBe('true');
  });

  it('胶片模式点同一集照样 emit select，不可播只 emit unavailable', async () => {
    const wrapper = mount(EpisodeList, {
      props: { episodes: EPISODES, film: true, filmFrames: FRAMES, unavailableIds: ['m:l:2'] },
    });
    const chips = wrapper.findAll('.ep-film');
    await chips[0]?.trigger('click');
    await chips[1]?.trigger('click');
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ id: 'm:l:1' });
    expect(wrapper.emitted('unavailable')?.[0]?.[0]).toMatchObject({ id: 'm:l:2' });
    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  it('长剧超过起播批次时「显示更多」还在，胶片不会挡住后面的集', async () => {
    const many = Array.from({ length: 52 }, (_, i) => makeEpisode(i + 1));
    const wrapper = mount(EpisodeList, { props: { episodes: many, film: true, filmFrames: {} } });
    expect(wrapper.findAll('.ep-film')).toHaveLength(50);
    const more = wrapper.find('.episode-list__more');
    expect(more.exists()).toBe(true);
    await more.trigger('click');
    expect(wrapper.findAll('.ep-film')).toHaveLength(52);
  });
});
