/**
 * 睡眠定时（B3）
 *
 * 两种口径：
 * - 分钟档：按**真实时间**走，暂停/切后台都照算，到点暂停播放
 * - 「播完本集」：不计时，等本集自然结束后停住，不再自动连播
 *
 * 用截止时间戳而不是逐秒自减：切后台时 JS 定时器会被系统节流，
 * 自减会越走越慢，时间戳算法回到前台第一拍就补齐差额。
 */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';

export const SLEEP_TIMER_MINUTES: readonly number[] = [15, 30, 45, 60, 90];

/** null = 未开启；'episode' = 播完本集；数字 = 分钟 */
export type SleepTimerChoice = number | 'episode';

export interface SleepTimerApi {
  choice: Ref<SleepTimerChoice | null>;
  /** 剩余秒数；「播完本集」与未开启恒为 0 */
  remainingSec: Ref<number>;
  active: ComputedRef<boolean>;
  /** 入口/面板文案 */
  label: ComputedRef<string>;
  setMinutes: (minutes: number) => void;
  setFinishEpisode: () => void;
  cancel: () => void;
  /** 本集播完时调用；返回 true = 定时器接管了这次结束，调用方不要再连播 */
  consumeEpisodeEnd: () => boolean;
}

function formatRemaining(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function useSleepTimer(input: { onExpire: (choice: SleepTimerChoice) => void }): SleepTimerApi {
  const choice = ref<SleepTimerChoice | null>(null);
  const remainingSec = ref(0);
  let deadlineAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const active = computed(() => choice.value !== null);
  const label = computed(() => {
    if (choice.value === null) return '关闭';
    if (choice.value === 'episode') return '播完本集';
    return remainingSec.value > 0 ? `剩余 ${formatRemaining(remainingSec.value)}` : `${choice.value} 分钟`;
  });

  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function clear(): void {
    stopTicker();
    choice.value = null;
    remainingSec.value = 0;
    deadlineAt = 0;
  }

  function expire(): void {
    const fired = choice.value;
    clear();
    if (fired !== null) input.onExpire(fired);
  }

  function tick(): void {
    const left = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
    remainingSec.value = left;
    if (left <= 0) expire();
  }

  function setMinutes(minutes: number): void {
    stopTicker();
    choice.value = minutes;
    deadlineAt = Date.now() + minutes * 60_000;
    remainingSec.value = minutes * 60;
    ticker = setInterval(tick, 1000);
  }

  function setFinishEpisode(): void {
    stopTicker();
    choice.value = 'episode';
    remainingSec.value = 0;
    deadlineAt = 0;
  }

  function consumeEpisodeEnd(): boolean {
    if (choice.value !== 'episode') return false;
    expire();
    return true;
  }

  onScopeDispose(clear);

  return {
    choice,
    remainingSec,
    active,
    label,
    setMinutes,
    setFinishEpisode,
    cancel: clear,
    consumeEpisodeEnd,
  };
}