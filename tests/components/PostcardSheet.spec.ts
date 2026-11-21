import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import type { PostcardContent, PostcardFramesReason } from '@/services/postcardService';

/**
 * 「一帧明信片」面板（G-C04）
 *
 * 面板只做编排，绘制/导出都在 service（有独立单测）。这里锁的是"话要说得出口"这件事：
 * 没有本机画面就不能让「画面」可点、没有字幕行就不能导出一张带空引号的明信片、
 * 预览没出来就不能点分享、分享没走通要留在面板里说明原因。
 */

const h = vi.hoisted(() => ({
  frames: { frames: [] as string[], reason: 'no-file' as PostcardFramesReason },
  render: vi.fn(),
  share: vi.fn(),
  palette: vi.fn(),
}));

vi.mock('@/services/postcardService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/postcardService')>();
  return {
    ...actual,
    fetchPostcardFrames: () => Promise.resolve(h.frames),
    renderPostcard: h.render,
    sharePostcard: h.share,
  };
});

vi.mock('@/services/paletteService', () => ({ paletteForPoster: h.palette }));

import PostcardSheet from '@/components/player/PostcardSheet.vue';

const SHEET = defineComponent({
  name: 'BottomSheet',
  props: { modelValue: { type: Boolean, default: false }, title: { type: String, default: '' } },
  template: `
    <div class="sheet-stub">
      <div class="sheet-stub__body"><slot /></div>
      <div class="sheet-stub__footer"><slot name="footer" /></div>
    </div>
  `,
});

interface SheetProps {
  modelValue: boolean;
  title: string;
  meta: string | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  positionSec: number;
  durationSec: number;
  line: string | null;
  localPath: string | null;
}

function baseProps(): SheetProps {
  return {
    modelValue: true,
    title: '尖峰时刻',
    meta: '1998 · 美国 · 动作',
    episodeLabel: '第 3 集',
    posterUrl: 'https://example.test/p.jpg',
    positionSec: 102.6,
    durationSec: 600,
    line: '我们走错路了。',
    localPath: 'downloads/m1/e3.mp4',
  };
}

async function mountSheet(overrides: Partial<SheetProps> = {}) {
  const wrapper = mount(PostcardSheet, {
    props: { ...baseProps(), ...overrides },
    global: { stubs: { BottomSheet: SHEET } },
  });
  await flushPromises();
  return wrapper;
}

function lastRender(): { layout: string; content: PostcardContent; image: string } {
  const call = h.render.mock.calls.at(-1);
  return { layout: call?.[0] as string, content: call?.[1] as PostcardContent, image: call?.[2] as string };
}

function imageOption(wrapper: Awaited<ReturnType<typeof mountSheet>>, label: string) {
  return wrapper.findAll('.segmented__item').find((b) => b.text() === label);
}

beforeEach(() => {
  // ToggleSwitch 里的触感反馈会读设置 store，没有活动 pinia 会在 setup 直接抛
  setActivePinia(createPinia());
  localStorage.clear();
  h.frames.frames = [];
  h.frames.reason = 'no-file';
  h.render.mockReset();
  h.render.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  h.share.mockReset();
  h.share.mockResolvedValue({ ok: true });
  h.palette.mockReset();
  h.palette.mockResolvedValue(null);
});

describe('PostcardSheet 打开与抓拍', () => {
  it('打开的瞬间拍一张：之后播放位置继续走也不会重画', async () => {
    const wrapper = await mountSheet();
    const renders = h.render.mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    expect(lastRender().content.positionSec).toBe(102);

    await wrapper.setProps({ positionSec: 480, line: '后来的台词' });
    await flushPromises();

    expect(h.render.mock.calls.length).toBe(renders);
    expect(lastRender().content.positionSec).toBe(102);
    expect(lastRender().content.line).toBe('我们走错路了。');
  });
});

describe('PostcardSheet 图源与台词的可用性', () => {
  it('没有本机画面：「本机画面」不可点，并把原因写出来', async () => {
    h.frames.reason = 'no-file';
    const wrapper = await mountSheet();

    expect(imageOption(wrapper, '本机画面')?.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('在线源没有可随机读的文件 · 只能用人物海报');
  });

  it('抽不出帧与没有抽帧桥说的是两句话，不共用"不支持"', async () => {
    h.frames.reason = 'no-bridge';
    const noTool = await mountSheet();
    expect(noTool.text()).toContain('本机暂不支持抽帧');

    h.frames.reason = 'none';
    const noFrames = await mountSheet();
    expect(noFrames.text()).toContain('这一帧没能抽出来');
  });

  it('有本机画面才给切：切过去后导出用的就是帧', async () => {
    h.frames.frames = ['data:a', 'data:b', 'data:c'];
    h.frames.reason = 'ok';
    const wrapper = await mountSheet();

    const frameOption = imageOption(wrapper, '本机画面');
    expect(frameOption?.attributes('disabled')).toBeUndefined();
    await frameOption?.trigger('click');
    await flushPromises();

    expect(lastRender().image).toBe('frame');
    expect(lastRender().content.frames).toHaveLength(3);
  });

  it('此刻没有字幕行：台词开关禁用，导出也不会带空引号', async () => {
    const wrapper = await mountSheet({ line: null });

    expect(wrapper.find('.switch').attributes('disabled')).toBeDefined();
    expect(lastRender().content.line).toBeNull();
    expect(wrapper.text()).toContain('此刻屏上没有字幕行');
  });

  it('关掉台词开关后导出 content.line 为空', async () => {
    const wrapper = await mountSheet();
    expect(lastRender().content.line).toBe('我们走错路了。');

    await wrapper.find('.switch').trigger('click');
    await flushPromises();
    expect(lastRender().content.line).toBeNull();
  });
});

describe('PostcardSheet 版式与导出', () => {
  it('切版式重画一次，并把选择留下', async () => {
    const wrapper = await mountSheet();
    const before = h.render.mock.calls.length;

    const minimal = wrapper.findAll('.segmented__item').find((b) => b.text() === '极简');
    await minimal?.trigger('click');
    await flushPromises();

    expect(h.render.mock.calls.length).toBeGreaterThan(before);
    expect(lastRender().layout).toBe('minimal');
    expect(JSON.parse(localStorage.getItem('player.postcard') ?? '{}')).toMatchObject({ layout: 'minimal' });
  });

  it('预览还没出来时分享按钮不可点', async () => {
    h.render.mockRejectedValue(new Error('画不出来'));
    const wrapper = await mountSheet();

    expect(wrapper.find('.pc-share').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[role="status"]').text()).toContain('没能画出明信片');
  });

  it('导出失败的说辞来自绘制本身，不写成"网络异常"', async () => {
    const wrapper = await mountSheet();
    expect(wrapper.find('.pc-share').attributes('disabled')).toBeUndefined();

    await wrapper.find('.pc-share').trigger('click');
    await flushPromises();

    expect(h.share).toHaveBeenCalledTimes(1);
    expect(h.share.mock.calls[0]?.[1]).toBe('尖峰时刻');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('分享没走通就留在面板里说明，不是静默关闭', async () => {
    h.share.mockResolvedValue({ ok: false, reason: 'no-target', message: '本机没有分享面板' });
    const wrapper = await mountSheet();

    await wrapper.find('.pc-share').trigger('click');
    await flushPromises();

    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(wrapper.find('[role="status"]').text()).toContain('本机没有分享面板');
  });
});
