/**
 * OPT-26（P0-③-2）：「该源正忙」的重试闸门（倒计时 + 到点自动重试一次）。
 *
 * 忙态文案那句「稍后会自动重试，不必反复点」此前只是一句承诺：按钮一直能点，
 * 用户戳下去撞的还是同一个原生实例（真机 12:18 / 12:24 的连点形态）。
 * 这里把承诺做成界面行为：闸门没放行就禁用按钮并显示剩余秒数，归零自动重试一次。
 *
 * 秒数只有一个来源——`AppErrorShape.retryAfterMs`，它由 `SpiderAdapter.busyStateOf`
 * 的真实占用换算（探测被这次点播放打断时是 0：没有占用就不许拦用户）。
 * 界面上不许再猜 30 秒，也不许从文案里反推。
 *
 * 自动重试只兑现一次：闸门到点后仍失败会带上一份新的 `retryAfterMs`，
 * 那时按新闸门重新计时；同一份错误不会自动补投，避免「失败 → 静默等 → 再失败」的循环。
 */
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';

import type { AppErrorShape } from '@/types';

/** 倒计时刷新间隔：秒级显示够用，且不会每帧重排 */
const GATE_TICK_MS = 500;

export interface BusyRetryGate {
  /** 闸门剩余毫秒；0 = 立刻可重试 */
  remainMs: Ref<number>;
  /** 重试按钮文案（闸门内是「约 N 秒后可重试」） */
  retryLabel: ComputedRef<string>;
}

export function useBusyRetryGate(
  errorOf: () => AppErrorShape | null | undefined,
  onRelease: () => void,
): BusyRetryGate {
  const remainMs = ref(0);
  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let released = false;

  const gateMs = computed(() => {
    const error = errorOf();
    return error?.code === 'E_SOURCE_BUSY' ? Math.max(0, error.retryAfterMs ?? 0) : 0;
  });

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function tick(): void {
    const left = deadline - Date.now();
    if (left > 0) {
      remainMs.value = left;
      return;
    }
    stop();
    remainMs.value = 0;
    if (released) return;
    released = true;
    onRelease();
  }

  watch(
    gateMs,
    (ms) => {
      stop();
      released = false;
      if (ms <= 0) {
        remainMs.value = 0;
        return;
      }
      deadline = Date.now() + ms;
      remainMs.value = ms;
      timer = setInterval(tick, GATE_TICK_MS);
    },
    { immediate: true },
  );

  onBeforeUnmount(stop);

  return {
    remainMs,
    retryLabel: computed(() =>
      remainMs.value > 0 ? `约 ${Math.ceil(remainMs.value / 1000)} 秒后可重试` : '重试',
    ),
  };
}
