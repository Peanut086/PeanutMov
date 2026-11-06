/**
 * 内嵌字幕轨菜单（EXT-07）单元测试
 *
 * 覆盖：
 * - 正常列表：关闭项 + 轨道项、当前项打勾、编码信息
 * - 选择轨道 / 关闭字幕：emit 后自动关闭弹层
 * - 空数据：明确「无可用轨道」且保留关闭项与外挂字幕入口
 * - 加载中 / 读取失败（可重试）
 * - 数据超限（40 条）不丢项
 *
 * 说明：BottomSheet 用 `<Teleport to="body">`，断言需查询 document.body。
 */
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';

import SubtitleTrackMenu from '@/components/player/SubtitleTrackMenu.vue';

function makeTrack(id: number, label: string, language: string | null, mimeType: string | null) {
  return { id, label, language, mimeType };
}

const TRACKS = [
  makeTrack(0, '中文', 'zh', 'text/vtt'),
  makeTrack(1, 'English', 'en', 'application/ttml+xml'),
];

function mountMenu(props: Record<string, unknown> = {}) {
  return mount(SubtitleTrackMenu, {
    props: { modelValue: true, tracks: TRACKS, activeId: null, ...props },
    attachTo: document.body,
    // BottomSheet 内部用 useHaptic（依赖 settingsStore）→ 需要 pinia
    global: { plugins: [createPinia()] },
  });
}

function items(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('.track-item'));
}

describe('SubtitleTrackMenu（EXT-07）', () => {
  it('渲染「关闭字幕」+ 轨道列表，当前项打勾并显示编码', () => {
    mountMenu({ activeId: 1 });

    const list = items();
    expect(list).toHaveLength(3);
    expect(list[0]?.textContent).toContain('关闭字幕');
    expect(list[1]?.textContent).toContain('中文');
    expect(list[1]?.textContent).toContain('VTT');
    expect(list[2]?.textContent).toContain('English');
    expect(list[2]?.textContent).toContain('当前');
    expect(list[2]?.classList.contains('track-item--active')).toBe(true);
    expect(list[0]?.classList.contains('track-item--active')).toBe(false);
  });

  it('选择轨道：emit select(id) 并关闭弹层', async () => {
    const wrapper = mountMenu({ activeId: null });

    items()[1]?.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('select')?.[0]).toEqual([0]);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('关闭字幕：emit select(null)', async () => {
    const wrapper = mountMenu({ activeId: 0 });

    items()[0]?.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('select')?.[0]).toEqual([null]);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('无可用轨道：展示空态，仍可关闭字幕并跳转外挂字幕', async () => {
    const wrapper = mountMenu({ tracks: [] });

    expect(document.body.textContent).toContain('无可用轨道');
    expect(document.body.querySelector('[data-test="subtitle-no-track"]')).not.toBeNull();
    // 关闭项仍在（无内嵌轨时用户仍应能确认「字幕关闭」）
    expect(items()).toHaveLength(1);

    const external = document.body.querySelector<HTMLButtonElement>(
      '[data-test="subtitle-open-external"]',
    );
    expect(external).not.toBeNull();
    external?.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('open-external')).toHaveLength(1);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('加载中：只显示状态文案，不渲染列表', () => {
    mountMenu({ loading: true, tracks: [] });

    expect(document.body.textContent).toContain('正在读取字幕轨');
    expect(items()).toHaveLength(0);
  });

  it('读取失败：展示原因并可重试', async () => {
    const wrapper = mountMenu({ error: '当前安装包不支持内嵌字幕', tracks: [] });

    expect(document.body.textContent).toContain('当前安装包不支持内嵌字幕');
    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.trim() === '重试',
    );
    expect(retry).toBeDefined();
    retry?.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('数据超限：40 条轨道全部渲染', () => {
    const many = Array.from({ length: 40 }, (_, i) => makeTrack(i, `字幕轨 ${i + 1}`, null, null));
    mountMenu({ tracks: many });

    // 40 条轨道 + 1 条「关闭字幕」
    expect(items()).toHaveLength(41);
    expect(document.body.textContent).toContain('字幕轨 40');
  });
});
