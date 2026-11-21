/**
 * P1-3：点播在途计数——两条预热入口（libraryService 全量扫描 / sourceStore 当前源+前 5）
 * 共用的让路判据。计数只由播放解析路径增删，失败与取消也必须收口。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginPlaybackDemand,
  endPlaybackDemand,
  isPlaybackDemandInFlight,
} from '@/services/prewarmState';

describe('点播在途计数（P1-3）', () => {
  beforeEach(() => {
    while (isPlaybackDemandInFlight()) endPlaybackDemand();
  });

  it('没有点播时后台预热照常跑', () => {
    expect(isPlaybackDemandInFlight()).toBe(false);
  });

  it('并发解析各自计数：全部收口后才恢复预热', () => {
    beginPlaybackDemand();
    beginPlaybackDemand();
    expect(isPlaybackDemandInFlight()).toBe(true);

    endPlaybackDemand();
    expect(isPlaybackDemandInFlight()).toBe(true);

    endPlaybackDemand();
    expect(isPlaybackDemandInFlight()).toBe(false);
  });

  it('多余的 end 不会把计数压成负数（否则一次重复收口就永久放行预热）', () => {
    endPlaybackDemand();
    endPlaybackDemand();
    expect(isPlaybackDemandInFlight()).toBe(false);

    beginPlaybackDemand();
    expect(isPlaybackDemandInFlight()).toBe(true);
  });
});