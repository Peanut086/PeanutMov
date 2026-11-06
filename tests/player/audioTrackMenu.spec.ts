/**
 * 音轨菜单（EXT-07）单元测试
 *
 * 覆盖：
 * - 正常列表：名称 + 语言 + 声道标签，当前项打勾
 * - 选择音轨：emit select(id) 后关闭弹层
 * - 空数据 / 加载中 / 读取失败（可重试）
 * - 异常数据：声道数未知 / 非常见声道数都有可读标签
 *
 * 说明：BottomSheet 用 `<Teleport to="body">`，断言需查询 document.body。
 */
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';

import AudioTrackMenu from '@/components/player/AudioTrackMenu.vue';
import type { EmbeddedAudioTrack } from '@/player/PlayerController';

const TRACKS: EmbeddedAudioTrack[] = [
  { id: 0, label: '国语', language: 'zh', mimeType: 'audio/mp4a-latm', channels: 2 },
  { id: 1, label: '粤语', language: null, mimeType: 'audio/mp4a-latm', channels: 6 },
];

function mountMenu(props: Record<string, unknown> = {}) {
  return mount(AudioTrackMenu, {
    props: { modelValue: true, tracks: TRACKS, activeId: 0, ...props },
    attachTo: document.body,
    // BottomSheet 内部用 useHaptic（依赖 settingsStore）→ 需要 pinia
    global: { plugins: [createPinia()] },
  });
}

function items(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('.track-item'));
}

describe('AudioTrackMenu（EXT-07）', () => {
  it('渲染音轨：名称 + 语言 + 声道标签，当前项打勾', () => {
    mountMenu();

    const list = items();
    expect(list).toHaveLength(2);
    expect(list[0]?.textContent).toContain('国语');
    expect(list[0]?.textContent).toContain('ZH');
    expect(list[0]?.textContent).toContain('立体声');
    expect(list[0]?.textContent).toContain('当前');
    expect(list[0]?.classList.contains('track-item--active')).toBe(true);
    expect(list[1]?.textContent).toContain('5.1 声道');
    expect(list[1]?.classList.contains('track-item--active')).toBe(false);
  });

  it('没有「关闭」项：音轨列表只有轨道本身', () => {
    mountMenu();
    expect(document.body.textContent).not.toContain('关闭');
  });

  it('选择音轨：emit select(id) 并关闭弹层', async () => {
    const wrapper = mountMenu({ activeId: 0 });

    items()[1]?.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('select')?.[0]).toEqual([1]);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('无可用轨道：展示空态且不渲染列表', () => {
    mountMenu({ tracks: [], activeId: null });

    expect(items()).toHaveLength(0);
    expect(document.body.querySelector('[data-test="audio-no-track"]')).not.toBeNull();
    expect(document.body.textContent).toContain('无可用轨道');
  });

  it('加载中：只显示状态文案', () => {
    mountMenu({ loading: true, tracks: [] });

    expect(document.body.textContent).toContain('正在读取音轨');
    expect(items()).toHaveLength(0);
  });

  it('读取失败：展示原因并可重试', async () => {
    const wrapper = mountMenu({ error: '轨道读取超时', tracks: [] });

    expect(document.body.textContent).toContain('轨道读取超时');
    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.trim() === '重试',
    );
    expect(retry).toBeDefined();
    retry?.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('异常数据：声道数未知不显示标签，非常见声道数显示「N 声道」', () => {
    mountMenu({
      activeId: null,
      tracks: [
        { id: 0, label: '音轨 1', language: null, mimeType: null, channels: null },
        { id: 1, label: '音轨 2', language: null, mimeType: null, channels: 3 },
      ] as EmbeddedAudioTrack[],
    });

    const list = items();
    // channels 为 null / 无语言 → 无 meta 文案
    expect(list[0]?.querySelector('.track-item__meta')).toBeNull();
    expect(list[1]?.querySelector('.track-item__meta')?.textContent).toContain('3 声道');
  });

  it('数据超限：40 条音轨全部渲染', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      label: `音轨 ${i + 1}`,
      language: null,
      mimeType: null,
      channels: 2,
    }));
    mountMenu({ tracks: many, activeId: 39 });

    expect(items()).toHaveLength(40);
    expect(items()[39]?.textContent).toContain('当前');
  });
});
