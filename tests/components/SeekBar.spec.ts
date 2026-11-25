/**
 * 进度条（SeekBar）胶片预览单测 —— A 批次·A-03
 *
 * 胶片是纯几何题，真机上最容易错也最难肉眼核对的三点：
 * 1. 高亮格必须正好是手指那格（格号算错就变成"画面比手指慢半格"）；
 * 2. 两端贴边而不是裁掉半格；
 * 3. 没图 / 图还没好时将就用原来的时间气泡，不能铺一条空黑条。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SeekBar from '@/components/player/SeekBar.vue';

const CELL_W = 72;
const TRACK_W = 360;
const DURATION = 200;
const CELLS = 20;

function stubTrackGeometry(hit: Element): void {
  hit.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: TRACK_W,
      bottom: 44,
      width: TRACK_W,
      height: 44,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function mountBar(film: (string | null)[] | null = null): VueWrapper {
  const wrapper = mount(SeekBar, {
    props: { currentTime: 0, duration: DURATION, film },
  });
  stubTrackGeometry(wrapper.get('.seekbar__hit').element);
  return wrapper;
}

/** 手指按到轨道上的某个像素，返回该处的时间（秒） */
async function drag(wrapper: VueWrapper, clientX: number): Promise<void> {
  await wrapper.get('.seekbar__hit').trigger('pointerdown', { clientX });
  await wrapper.vm.$nextTick();
}

/** 从 style 里读平移像素：translate3d(<x>px, 0, 0) */
function panX(wrapper: VueWrapper): number {
  const style = wrapper.get('.seekbar__film-strip').attributes('style') ?? '';
  const matched = /translate3d\((-?[\d.]+)px/.exec(style);
  return matched ? Number(matched[1]) : Number.NaN;
}

function activeIndex(wrapper: VueWrapper): number {
  return wrapper.findAll('.seekbar__film-cell').findIndex((cell) => cell.classes().includes('seekbar__film-cell--active'));
}

function filledFilm(): (string | null)[] {
  return Array.from({ length: CELLS }, (_, index) => `f${index}`);
}

describe('SeekBar · 胶片几何', () => {
  it('拖动到中段：高亮手指那一格，并把该格平移到手指下面', async () => {
    const wrapper = mountBar(filledFilm());
    await drag(wrapper, 180); // 180/360 = 50% → 第 10 格

    expect(wrapper.findAll('.seekbar__film-cell')).toHaveLength(CELLS);
    expect(activeIndex(wrapper)).toBe(10);
    // 180 - (10 + 0.5) * 72 = -576
    expect(panX(wrapper)).toBeCloseTo(-576, 6);
  });

  it('拖到最左端：首格贴窗口左缘，不外溢也不被裁', async () => {
    const wrapper = mountBar(filledFilm());
    await drag(wrapper, 0);

    expect(activeIndex(wrapper)).toBe(0);
    expect(panX(wrapper)).toBe(0);
  });

  it('拖到最右端：尾格贴窗口右缘，整格可见', async () => {
    const wrapper = mountBar(filledFilm());
    await drag(wrapper, TRACK_W);

    expect(activeIndex(wrapper)).toBe(CELLS - 1);
    // 轨道宽 360、整条胶片 1440 → 最多只能平移到 360 - 1440
    expect(panX(wrapper)).toBeCloseTo(TRACK_W - CELLS * CELL_W, 6);
  });

  it('逐格边界：正好压在两格交界时取右边那格', async () => {
    const wrapper = mountBar(filledFilm());
    // 第 5 格中心 = (5.5 / 20) * 200s = 55s → 像素 55/200*360 = 99
    await drag(wrapper, 99);
    expect(activeIndex(wrapper)).toBe(5);
    await drag(wrapper, 54.5);
    expect(activeIndex(wrapper)).toBe(3);
  });

  it('拖动中只发 seeking，松手才提交 seek', async () => {
    const wrapper = mountBar(filledFilm());
    await drag(wrapper, 90); // 90/360 = 25% → 50s
    expect(wrapper.emitted('seeking')?.[0]).toEqual([50]);
    expect(wrapper.emitted('seek')).toBeUndefined();

    await wrapper.get('.seekbar__hit').trigger('pointerup', { clientX: 90 });
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('seek')?.[0]).toEqual([50]);
  });
});

describe('SeekBar · 片头/片尾分段（B-06）', () => {
  function mountWithMarks(marks: { introEndSec: number | null; creditsStartSec: number | null } | null): VueWrapper {
    const wrapper = mount(SeekBar, {
      props: { currentTime: 0, duration: DURATION, marks },
    });
    stubTrackGeometry(wrapper.get('.seekbar__hit').element);
    return wrapper;
  }

  function styleOf(node: { attributes: (name: string) => string | undefined }, name: string): string {
    return node.attributes(name) ?? '';
  }

  it('两侧都标了：画出两段底并把边界刻度立在交界上', () => {
    const wrapper = mountWithMarks({ introEndSec: 30, creditsStartSec: 180 });
    const zones = wrapper.findAll('.seekbar__zone');
    const edges = wrapper.findAll('.seekbar__zone-edge');

    expect(zones).toHaveLength(2);
    expect(styleOf(zones[0]!, 'style')).toContain('width: 15%'); // 30 / 200
    expect(styleOf(zones[1]!, 'style')).toContain('left: 90%'); // 180 / 200
    expect(edges).toHaveLength(2);
    expect(styleOf(edges[0]!, 'style')).toContain('left: 15%');
    expect(styleOf(edges[1]!, 'style')).toContain('left: 90%');
  });

  it('只标了片头：只画一段，不猜片尾', () => {
    const wrapper = mountWithMarks({ introEndSec: 30, creditsStartSec: null });

    expect(wrapper.findAll('.seekbar__zone')).toHaveLength(1);
    expect(styleOf(wrapper.findAll('.seekbar__zone')[0]!, 'style')).toContain('left: 0%');
  });

  it('没有标记时一段都不画，进度条与升级前完全一致', () => {
    const wrapper = mountWithMarks(null);

    expect(wrapper.find('.seekbar__zone').exists()).toBe(false);
    expect(wrapper.find('.seekbar__zone-edge').exists()).toBe(false);
  });

  it('越界标记直接忽略：宁可少画也不画出跳不到的假区间', () => {
    const wrapper = mountWithMarks({ introEndSec: 260, creditsStartSec: -5 });

    expect(wrapper.find('.seekbar__zone').exists()).toBe(false);
  });

  it('底垫在已播条之下：进度经过区间时琥珀色不被盖掉', () => {
    const wrapper = mountWithMarks({ introEndSec: 30, creditsStartSec: 180 });
    const track = wrapper.get('.seekbar__track').element;
    const children = [...track.children].map((el) => el.className);

    expect(children.indexOf('seekbar__zone')).toBeGreaterThan(-1);
    expect(children.indexOf('seekbar__zone')).toBeLessThan(children.indexOf('seekbar__played'));
    expect(children.lastIndexOf('seekbar__zone-edge')).toBeGreaterThan(children.indexOf('seekbar__played'));
  });
});

describe('SeekBar · 退回时间气泡', () => {
  it('没有胶片数据时不铺胶片层，气泡照常显示', async () => {
    const wrapper = mountBar(null);
    await drag(wrapper, 180);

    expect(wrapper.find('.seekbar__film').exists()).toBe(false);
    expect(wrapper.get('.seekbar__bubble-text').text()).toBe('01:40');
  });

  it('一格都还没抽好时同样不铺空胶片', async () => {
    const wrapper = mountBar(new Array(CELLS).fill(null));
    await drag(wrapper, 180);

    expect(wrapper.find('.seekbar__film').exists()).toBe(false);
    expect(wrapper.get('.seekbar__bubble-text').text()).toBe('01:40');
  });

  it('胶片就绪后气泡抬到胶片上方，两者不叠在一起', async () => {
    const wrapper = mountBar(filledFilm());
    await drag(wrapper, 180);

    expect(wrapper.find('.seekbar__film').exists()).toBe(true);
    expect(wrapper.get('.seekbar__bubble').classes()).toContain('seekbar__bubble--raised');
  });

  it('部分格未就绪也铺胶片：空格留底色，就绪格出画面', async () => {
    const film = Array.from({ length: CELLS }, (_, index) => (index === 10 ? null : `f${index}`));
    const wrapper = mountBar(film);
    await drag(wrapper, 180);

    const cells = wrapper.findAll('.seekbar__film-cell');
    expect(cells).toHaveLength(CELLS);
    expect(cells[10]!.find('img').exists()).toBe(false);
    expect(cells[0]!.find('img').attributes('src')).toBe('f0');
  });
});

describe('SeekBar · 时间行口径（设计稿）', () => {
  it('分位补零：当前 00:00，右侧剩余 03:20', () => {
    const wrapper = mountBar();

    expect(wrapper.get('.seekbar__time--cur').text()).toBe('00:00');
    expect(wrapper.get('.seekbar__time--dur').text()).toBe('03:20');
  });

  it('读屏文案用「，共」连接当前与总时长', () => {
    const wrapper = mountBar();

    expect(wrapper.get('.seekbar__hit').attributes('aria-valuetext')).toBe('00:00，共 03:20');
  });

  it('未知时长显示 --:--，读屏不冒充 00:00', () => {
    const wrapper = mount(SeekBar, { props: { currentTime: 12, duration: 0 } });

    expect(wrapper.get('.seekbar__time--dur').text()).toBe('--:--');
    expect(wrapper.get('.seekbar__hit').attributes('aria-valuetext')).toBe('00:12，总时长未知');
  });

  it('未知时长仍可按方向键相对定位，End 不跳到 0', async () => {
    const wrapper = mount(SeekBar, { props: { currentTime: 12, duration: 0 } });
    const hit = wrapper.get('.seekbar__hit');

    await hit.trigger('keydown', { key: 'ArrowRight' });
    await hit.trigger('keydown', { key: 'End' });

    expect(wrapper.emitted('seek')).toEqual([[22]]);
  });

  it('定位能力不可靠时 pointer 与键盘 seek 全部禁用', async () => {
    const wrapper = mount(SeekBar, {
      props: { currentTime: 12, duration: 100, seekEnabled: false },
    });
    stubTrackGeometry(wrapper.get('.seekbar__hit').element);
    const hit = wrapper.get('.seekbar__hit');

    await hit.trigger('pointerdown', { clientX: 50 });
    await hit.trigger('pointerup', { clientX: 50 });
    await hit.trigger('keydown', { key: 'ArrowRight' });
    await hit.trigger('keydown', { key: 'Home' });

    expect(wrapper.emitted('seeking')).toBeUndefined();
    expect(wrapper.emitted('seek')).toBeUndefined();
    expect(hit.attributes('aria-disabled')).toBe('true');
  });
});
