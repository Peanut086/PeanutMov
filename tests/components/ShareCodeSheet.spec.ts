import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import type { TicketContent } from '@/services/ticketCardService';
import { decodeShareCode, encodeShareCode, type ShareCodePayload } from '@/services/shareCodeService';

/**
 * 观影口令「票根卡」面板（G-C10）
 *
 * 绘制与导出都在 service（有独立单测）。这里锁三件真机上最容易翻车的事：
 * 1. 口令正文不许因为"做了张漂亮的卡"而被改写——面板上印的必须就是 `encodeShareCode` 那一串；
 * 2. 复制仍然归 PlayerView（它才有 toast 通路），面板只负责把这一刻的坐标交出去；
 * 3. 条码不能假装能扫，说明文案要在场。
 */

const h = vi.hoisted(() => ({
  render: vi.fn(),
  share: vi.fn(),
  palette: vi.fn(),
}));

vi.mock('@/services/ticketCardService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ticketCardService')>();
  return { ...actual, renderTicketCard: h.render, shareTicketCard: h.share };
});

vi.mock('@/services/paletteService', () => ({ paletteForPoster: h.palette }));

import ShareCodeSheet from '@/components/player/ShareCodeSheet.vue';

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
  payload: ShareCodePayload | null;
  meta: string | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  durationSec: number;
}

function baseProps(): SheetProps {
  return {
    modelValue: true,
    payload: { title: '庆余年 第二季', year: 2024, episodeNumber: 5, positionSec: 312.7 },
    meta: '2024 · 中国大陆 · 古装',
    episodeLabel: '第 5 集',
    posterUrl: 'https://example.test/p.jpg',
    durationSec: 2700.4,
  };
}

async function mountSheet(overrides: Partial<SheetProps> = {}) {
  const wrapper = mount(ShareCodeSheet, {
    props: { ...baseProps(), ...overrides },
    global: { stubs: { BottomSheet: SHEET } },
  });
  await flushPromises();
  return wrapper;
}

function lastContent(): TicketContent {
  return h.render.mock.calls.at(-1)?.[0] as TicketContent;
}

function option(wrapper: NonNullable<typeof mounted>, label: string) {
  const found = wrapper.findAll('.segmented__item').find((b) => b.text() === label);
  if (!found) throw new Error(`没有「${label}」这一档`);
  return found;
}

let mounted: Awaited<ReturnType<typeof mountSheet>> | null = null;

beforeEach(() => {
  // SegmentedControl 的触感反馈会读设置 store，没有活动 pinia 会在 setup 直接抛
  setActivePinia(createPinia());
  localStorage.clear();
  h.render.mockReset();
  h.render.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  h.share.mockReset();
  h.share.mockResolvedValue({ ok: true });
  h.palette.mockReset();
  h.palette.mockResolvedValue(null);
  mounted = null;
});

describe('ShareCodeSheet 口令正文', () => {
  it('卡上印的就是 encodeShareCode 那一串，面板没有第二套编码', async () => {
    mounted = await mountSheet();
    const expected = encodeShareCode(baseProps().payload!);

    expect(lastContent().code).toBe(expected);
    expect(mounted.get('.tc-code').text()).toBe(expected);
  });

  it('卡面画的秒数与协议里的秒数是同一个数（解码回来核对，不靠肉眼）', async () => {
    mounted = await mountSheet({
      payload: { title: '庆余年 第二季', year: 2024, episodeNumber: 5, positionSec: 312 },
      durationSec: 2700.4,
    });

    expect(lastContent().positionSec).toBe(312);
    expect(lastContent().durationSec).toBe(2700);
    expect(decodeShareCode(lastContent().code)?.positionSec).toBe(312);
  });

  it('打开后播放继续走也不重画：拍的是打开那一刻', async () => {
    mounted = await mountSheet();
    const renders = h.render.mock.calls.length;

    await mounted.setProps({ payload: { title: '庆余年 第二季', year: 2024, episodeNumber: 5, positionSec: 999 } });
    await flushPromises();

    expect(h.render.mock.calls).toHaveLength(renders);
    expect(lastContent().positionSec).toBe(312);
  });

  it('载荷为空：不画卡、不给可点的复制', async () => {
    mounted = await mountSheet({ payload: null });

    expect(h.render).not.toHaveBeenCalled();
    expect(mounted.get('.tc-preview__idle').text()).toBe('还没有可画的票根');
    expect(mounted.get('.tc-copy').attributes('disabled')).toBeDefined();
  });
});

describe('ShareCodeSheet 视角', () => {
  it('切到对方视角只换说明，口令与坐标一个字都不变', async () => {
    mounted = await mountSheet();
    const before = lastContent();

    await option(mounted, '对方视角').trigger('click');
    await flushPromises();

    const after = lastContent();
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(after.viewer).toBe('receiver');
    expect(after.code).toBe(before.code);
    expect(after.positionSec).toBe(before.positionSec);
    expect(after.title).toBe(before.title);
  });

  it('说明文字跟着视角改口径', async () => {
    mounted = await mountSheet();
    expect(mounted.text()).toContain('你此刻在看哪儿');

    await option(mounted, '对方视角').trigger('click');
    await flushPromises();
    expect(mounted.text()).toContain('对方拿到后该怎么用');
  });
});

describe('ShareCodeSheet 动作', () => {
  it('复制口令交回 PlayerView，并由它关掉面板（toast 在那边）', async () => {
    mounted = await mountSheet();

    await mounted.get('.tc-copy').trigger('click');

    // 面板只负责喊"要复制"：写剪贴板与提示都在 PlayerView，关闭也由它做（v-model 在它手上）
    expect(mounted.emitted('copy')).toHaveLength(1);
    expect(mounted.emitted('update:modelValue')).toBeUndefined();
  });

  it('预览没出来之前不给保存，免得分享一张空图', async () => {
    h.render.mockRejectedValue(new Error('这台机器没能给出画布'));
    mounted = await mountSheet();
    await flushPromises();

    expect(mounted.get('.tc-save').attributes('disabled')).toBeDefined();
    expect(mounted.get('.tc-note').text()).toContain('没能画出票根');
    expect(h.share).not.toHaveBeenCalled();
  });

  it('保存票根走分享面板，成功后留在面板里说明去向', async () => {
    mounted = await mountSheet();

    await mounted.get('.tc-save').trigger('click');
    await flushPromises();

    expect(h.share).toHaveBeenCalledTimes(1);
    expect(h.share.mock.calls[0]?.[1]).toBe('庆余年 第二季');
    expect(mounted.get('.tc-note').text()).toContain('交给系统分享面板');
    expect(mounted.emitted('update:modelValue')).toBeUndefined();
  });

  it('分享没走通要留在面板里说清原因', async () => {
    h.share.mockResolvedValue({ ok: false, reason: 'no-target', message: '本机没有分享面板' });
    mounted = await mountSheet();

    await mounted.get('.tc-save').trigger('click');
    await flushPromises();

    expect(mounted.get('.tc-note').text()).toContain('本机没有分享面板');
  });

  it('诚实交代条码扫不出来', async () => {
    mounted = await mountSheet();
    expect(mounted.get('.tc-note-line').text()).toContain('不可扫描');
  });

  it('关闭时交还预览对象，避免攒着一堆 blob', async () => {
    mounted = await mountSheet();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await mounted.setProps({ modelValue: false });
    await flushPromises();

    expect(revoke).toHaveBeenCalled();
    revoke.mockRestore();
  });
});
