/**
 * 跳过片头/片尾胶囊（B-06）
 *
 * 验收四条全部落在这个 composable 上：
 * - 进区间立刻出胶囊、离区间立刻收起（倒计时靠 setInterval，用伪时钟跑）
 * - 倒计时走完自动跳；设置里关掉就只等用户点
 * - 同一集同一区段只提示一次——手动拖回片头不该再弹一遍
 * - 没有标记数据时全程静默，播放器行为与现状一致
 *
 * 伪时钟会卡住 fake-indexeddb 的任务队列，所以所有要读库的 mediaId 都在装伪时钟前预热完。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';

import { useSkipIntro, type SkipIntroApi } from '@/composables/useSkipIntro';
import { skipMarkService } from '@/services/skipMarkService';

import { resetAll } from './helpers';

const DURATION = 600;

let seq = 0;
function nextMediaId(): string {
  seq += 1;
  return `tb:skipintro-${seq}`;
}

interface Harness {
  api: SkipIntroApi;
  mediaId: Ref<string>;
  /** 另一部没有任何标记的剧 */
  otherMediaId: Ref<string>;
  episodeId: Ref<string>;
  currentTime: Ref<number>;
  autoSkip: Ref<boolean>;
  seeked: number[];
}

async function setup(marks: Partial<{ intro: number; credits: number | null }>): Promise<Harness> {
  const mediaId = ref(nextMediaId());
  const otherMediaId = ref(nextMediaId());
  const episodeId = ref('s01e01');

  await skipMarkService.loadMarks(mediaId.value);
  if (marks.intro !== undefined) await skipMarkService.markIntroEnd(mediaId.value, marks.intro, DURATION);
  if (marks.credits !== undefined) {
    await skipMarkService.markCreditsStart(mediaId.value, marks.credits ?? 540, DURATION);
  }
  await skipMarkService.loadMarks(mediaId.value);
  await skipMarkService.loadMarks(otherMediaId.value);

  vi.useFakeTimers();

  const currentTime = ref(0);
  const autoSkip = ref(true);
  const seeked: number[] = [];
  const api = useSkipIntro({
    mediaId,
    episodeId,
    currentTime,
    duration: ref(DURATION),
    autoSkip,
    seek: (sec) => {
      seeked.push(sec);
      currentTime.value = sec;
    },
  });

  await nextTick();
  return { api, mediaId, otherMediaId, episodeId, currentTime, autoSkip, seeked };
}

async function move(sec: number, h: Harness): Promise<void> {
  h.currentTime.value = sec;
  await nextTick();
}

beforeEach(async () => {
  await resetAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSkipIntro · 出现与收起', () => {
  it('播放头进入片头区：胶囊立刻出现并开始 3s 倒计时', async () => {
    const h = await setup({ intro: 90 });

    expect(h.api.zone.value).toBe('intro');
    expect(h.api.countdown.value).toBe(3);
    expect(h.seeked).toEqual([]);
  });

  it('片尾区同样出胶囊，跳过片尾落到结尾前 1s', async () => {
    const h = await setup({ credits: 540 });
    expect(h.api.zone.value).toBeNull();

    await move(550, h);
    expect(h.api.zone.value).toBe('credits');
    expect(h.api.countdown.value).toBe(3);

    h.api.skip();
    expect(h.seeked).toEqual([599]);
    expect(h.api.zone.value).toBeNull();
  });

  it('离开片头区：立刻收起，倒计时也停掉', async () => {
    const h = await setup({ intro: 90 });
    await move(120, h);

    expect(h.api.zone.value).toBeNull();
    expect(h.api.countdown.value).toBe(0);

    vi.advanceTimersByTime(3000);
    expect(h.seeked).toEqual([]);
  });

  it('没有标记数据时全程静默，行为与升级前一致', async () => {
    const h = await setup({});

    await move(30, h);
    expect(h.api.zone.value).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(h.seeked).toEqual([]);
  });

  it('自动跳的落点已在片头之后，不会原地复现胶囊', async () => {
    const h = await setup({ intro: 90 });
    vi.advanceTimersByTime(3000);
    await nextTick();

    expect(h.seeked).toEqual([91]);
    expect(h.currentTime.value).toBe(91);
    expect(h.api.zone.value).toBeNull();
  });
});

describe('useSkipIntro · 自动跳开关', () => {
  it('关掉自动跳：胶囊只等用户点，倒计时不启动也不跳', async () => {
    const h = await setup({ intro: 90 });
    h.autoSkip.value = false;
    await nextTick();

    expect(h.api.zone.value).toBe('intro');
    expect(h.api.countdown.value).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(h.seeked).toEqual([]);

    h.api.skip();
    expect(h.seeked).toEqual([91]);
  });

  it('胶囊显示中改设置：关掉停倒计时，重新打开接着倒数', async () => {
    const h = await setup({ intro: 90 });
    vi.advanceTimersByTime(1000);
    expect(h.api.countdown.value).toBe(2);

    h.autoSkip.value = false;
    await nextTick();
    expect(h.api.countdown.value).toBe(0);
    expect(h.api.zone.value).toBe('intro');

    vi.advanceTimersByTime(5000);
    expect(h.seeked).toEqual([]);

    h.autoSkip.value = true;
    await nextTick();
    expect(h.api.countdown.value).toBe(3);
    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(h.seeked).toEqual([91]);
  });
});

describe('useSkipIntro · 同一集只提示一次', () => {
  it('自动跳之后拖回片头：不再弹第二遍', async () => {
    const h = await setup({ intro: 90 });
    vi.advanceTimersByTime(3000);
    await nextTick();

    await move(20, h);
    expect(h.api.zone.value).toBeNull();
  });

  it('手动拖回片头：已提示过的区段不再弹（不自动跳时也一样）', async () => {
    const h = await setup({ intro: 90 });
    h.autoSkip.value = false;
    await nextTick();
    expect(h.api.zone.value).toBe('intro');

    await move(120, h);
    await move(30, h);
    expect(h.api.zone.value).toBeNull();
  });

  it('点 ✕ 关掉后，本集该区段不再提示', async () => {
    const h = await setup({ intro: 90 });
    h.api.dismiss();
    await nextTick();

    vi.advanceTimersByTime(5000);
    expect(h.seeked).toEqual([]);

    await move(120, h);
    await move(10, h);
    expect(h.api.zone.value).toBeNull();
  });

  it('换集后重新提示：上一集的「已看过」不该压住这一集', async () => {
    const h = await setup({ intro: 90 });
    h.autoSkip.value = false;
    await nextTick();
    h.api.dismiss();

    h.episodeId.value = 's01e02';
    await nextTick();
    await move(30, h);
    expect(h.api.zone.value).toBe('intro');
  });

  it('换剧后旧剧的区间不残留', async () => {
    const h = await setup({ intro: 90 });
    expect(h.api.marks.value?.introEndSec).toBe(90);

    h.mediaId.value = h.otherMediaId.value;
    await nextTick();

    expect(h.api.marks.value).toBeNull();
    expect(h.api.zone.value).toBeNull();
  });
});
