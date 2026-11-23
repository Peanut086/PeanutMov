/**
 * 11-23 缓冲提示永挂修复（FIX-1/FIX-2）回归：
 * 原生引擎缓冲恢复只上报 ready（playWhenReady 不变，不会有 playing 事件），
 * 且 waiting 置真不改内部 state——恢复路径必须把 waiting 收口，
 * 否则"正在缓冲"永挂、控制操作不可达。
 */
import { describe, expect, it } from 'vitest';

import { PlayerController } from '@/player/PlayerController';

interface ControllerInternals {
  state: string;
  handleLoadedMetadata: (duration: number) => void;
  handleRemotePlaying: (playing: boolean) => void;
}

function makeCtl() {
  const ctl = new PlayerController({ onProgress: () => {} });
  const changes: { playing: boolean; waiting: boolean }[] = [];
  const ready: unknown[] = [];
  ctl.on('statechange', (p) => changes.push(p));
  ctl.on('ready', (p) => ready.push(p));
  return { ctl, changes, ready, priv: ctl as unknown as ControllerInternals };
}

describe('缓冲等待态收口', () => {
  it('播放中收到 ready：补发 statechange 清 waiting', () => {
    const { changes, ready, priv } = makeCtl();
    priv.state = 'playing';

    priv.handleLoadedMetadata(1000);

    expect(changes).toEqual([{ playing: true, waiting: false }]);
    expect(ready).toHaveLength(1);
  });

  it('首次起播（loading 态）收到 ready：不提前发 playing，ready 照常上报', () => {
    const { changes, ready, priv } = makeCtl();
    priv.state = 'loading';

    priv.handleLoadedMetadata(1000);

    expect(changes).toHaveLength(0);
    expect(ready).toHaveLength(1);
  });

  it('同态 playing 的远端恢复上报：setState 吞掉同态事件，这里显式补发收口', () => {
    const { changes, priv } = makeCtl();
    priv.state = 'playing';

    priv.handleRemotePlaying(true);

    expect(changes).toEqual([{ playing: true, waiting: false }]);
  });

  it('暂停态收到远端 playing：走 setState 正常发一次，不多发', () => {
    const { changes, priv } = makeCtl();
    priv.state = 'paused';

    priv.handleRemotePlaying(true);

    expect(changes).toEqual([{ playing: true, waiting: false }]);
    expect(priv.state).toBe('playing');
  });
});
