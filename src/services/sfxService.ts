/**
 * 彩蛋池轻量音效（WebAudio 合成，无外部音频资源）。
 *
 * 只在用户手势触发的彩蛋里调用（NG 场记板 clack / 爆米花桶 ding）。
 * AudioContext 懒创建，首次手势时 resume；不支持或被 autoplay 策略阻止时静默跳过，
 * 绝不影响主流程。节点播完即 disconnect，不长期持有，避免泄漏。
 */
import { logger } from '@/shared/logger';

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

function getCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function getCtx(): AudioContext | null {
  const Ctor = getCtor();
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch (e) {
      logger.warn('AudioContext 创建失败，彩蛋音效静音', e);
      return null;
    }
  }
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

function getNoise(ac: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ac.sampleRate) return noiseBuffer;
  const len = Math.floor(ac.sampleRate * 0.09);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) {
    // 指数衰减白噪声 → 木质拍击的瞬态
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
  }
  noiseBuffer = buf;
  return buf;
}

/** 播完回收：所有 source 结束后断开 master；兜底定时器防 onended 不触发 */
function cleanupAfter(sources: AudioScheduledSourceNode[], master: GainNode, sec: number): void {
  let pending = sources.length;
  for (const s of sources) {
    s.onended = (): void => {
      try {
        s.disconnect();
      } catch {
        /* 已断开 */
      }
      pending -= 1;
      if (pending <= 0) {
        try {
          master.disconnect();
        } catch {
          /* 已断开 */
        }
      }
    };
  }
  window.setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      /* 已断开 */
    }
  }, sec * 1000 + 150);
}

/** 场记板合板「啪」：带通噪声瞬态 + 低频木质闷响 */
export function playClack(): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = 0.9;
    master.connect(ac.destination);

    const noise = ac.createBufferSource();
    noise.buffer = getNoise(ac);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const nGain = ac.createGain();
    nGain.gain.setValueAtTime(0.5, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    noise.connect(bp).connect(nGain).connect(master);
    noise.start(now);
    noise.stop(now + 0.1);

    const thud = ac.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(180, now);
    thud.frequency.exponentialRampToValueAtTime(70, now + 0.09);
    const tGain = ac.createGain();
    tGain.gain.setValueAtTime(0.32, now);
    tGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    thud.connect(tGain).connect(master);
    thud.start(now);
    thud.stop(now + 0.14);

    cleanupAfter([noise, thud], master, 0.2);
  } catch (e) {
    logger.warn('clack 音效播放失败', e);
  }
}

/** 里程碑「叮」：基频 + 泛音正弦 partial，指数衰减的铃铛感 */
export function playDing(): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = 0.8;
    master.connect(ac.destination);

    const partials: Array<[number, number, number]> = [
      [880, 0.3, 0.7],
      [1760, 0.14, 0.5],
      [2640, 0.06, 0.35],
    ];
    const nodes: OscillatorNode[] = [];
    for (const [freq, peak, dur] of partials) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(g).connect(master);
      osc.start(now);
      osc.stop(now + dur + 0.05);
      nodes.push(osc);
    }
    cleanupAfter(nodes, master, 0.8);
  } catch (e) {
    logger.warn('ding 音效播放失败', e);
  }
}