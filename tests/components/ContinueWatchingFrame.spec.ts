import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';

import type { HistoryRecord } from '@/types';

/**
 * 继续观看条目的「停在哪儿」那一帧（G-B08）
 *
 * `frames` 缺省时渲染必须与改动前一致（海报），有帧才换成 16:9 画面；
 * 竖排卡片模式没有 16:9 的位置，所以给了帧也不换——三种情形都要锁住。
 */

import ContinueWatchingRow from '@/components/media/ContinueWatchingRow.vue';

const POSTER = defineComponent({
  name: 'PosterImage',
  template: '<div class="poster-stub" />',
});

function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'h1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:0:2',
    episodeNumber: 2,
    title: '影片一',
    posterUrl: 'https://example.test/p.jpg',
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 12,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as HistoryRecord;
}

function mountRow(
  items: HistoryRecord[],
  opts: { compact?: boolean; frames?: Record<string, string> } = {},
) {
  return mount(ContinueWatchingRow, {
    props: { items, ...opts },
    global: { stubs: { PosterImage: POSTER } },
  });
}

describe('ContinueWatchingRow 续播帧', () => {
  it('不传 frames：compact 条目仍是海报，渲染与改动前一致', async () => {
    const wrapper = mountRow([makeRecord()], { compact: true });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('img.continue-compact__frame').exists()).toBe(false);
    expect(wrapper.find('.poster-stub').exists()).toBe(true);
    expect(wrapper.find('.continue-compact__thumb').classes()).not.toContain('continue-compact__thumb--frame');
  });

  it('有帧：换成 16:9 画面，海报不再渲染，且不给 alt（装饰性画面）', async () => {
    const wrapper = mountRow([makeRecord()], {
      compact: true,
      frames: { h1: 'data:image/jpeg;base64,AAA' },
    });
    await wrapper.vm.$nextTick();

    const thumb = wrapper.find('.continue-compact__thumb');
    expect(thumb.classes()).toContain('continue-compact__thumb--frame');

    const img = wrapper.find('img.continue-compact__frame');
    expect(img.attributes('src')).toBe('data:image/jpeg;base64,AAA');
    expect(img.attributes('alt')).toBe('');
    expect(wrapper.find('.poster-stub').exists()).toBe(false);
  });

  it('只对对上 id 的条目换帧，其余继续用海报', async () => {
    const items = [makeRecord(), makeRecord({ id: 'h2', title: '影片二' })];
    const wrapper = mountRow(items, { compact: true, frames: { h2: 'data:image/jpeg;base64,BBB' } });
    await wrapper.vm.$nextTick();

    const thumbs = wrapper.findAll('.continue-compact__thumb');
    expect(thumbs[0].find('.poster-stub').exists()).toBe(true);
    expect(thumbs[1].find('img.continue-compact__frame').attributes('src')).toBe('data:image/jpeg;base64,BBB');
  });

  it('竖排卡片模式不给画面位置：即使有帧也保持海报', async () => {
    const wrapper = mountRow([makeRecord()], { frames: { h1: 'data:image/jpeg;base64,AAA' } });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.findAll('.poster-stub').length).toBe(1);
    expect(wrapper.find('.continue-card').exists()).toBe(true);
  });

  it('换成画面后点击与移除照常回传记录', async () => {
    const record = makeRecord();
    const wrapper = mountRow([record], { compact: true, frames: { h1: 'data:image/jpeg;base64,AAA' } });
    await wrapper.vm.$nextTick();

    await wrapper.find('.continue-compact__main').trigger('click');
    const select = wrapper.emitted('select')?.[0];
    // props 里的对象经 Vue 代理后不再是同一个引用，按内容核对
    expect(select?.[0]).toMatchObject({ id: 'h1', mediaId: 'demo:m1' });

    await wrapper.find('.continue-compact__remove').trigger('click');
    expect(wrapper.emitted('remove')?.[0]?.[0]).toMatchObject({ id: 'h1' });
  });

  it('无障碍名称仍然带上集号，画面不改变可读文案', async () => {
    const wrapper = mountRow([makeRecord()], { compact: true, frames: { h1: 'data:image/jpeg;base64,AAA' } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.continue-compact__main').attributes('aria-label')).toBe('继续观看 影片一 第 2 集');
  });
});
