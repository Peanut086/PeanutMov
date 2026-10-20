/**
 * 防抖 / 节流（组合式函数）
 *
 * 防抖用于搜索输入（300ms，AC-22）；组件卸载自动清理定时器。
 */
import { onBeforeUnmount, ref } from 'vue';

export interface DebouncedFn<TArgs extends unknown[]> {
  (...args: TArgs): void;
  /** 立即执行并取消挂起调用 */
  flush: (...args: TArgs) => void;
  /** 取消挂起调用 */
  cancel: () => void;
  /** 是否有挂起调用 */
  readonly pending: boolean;
}

export function useDebounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs = 300,
): DebouncedFn<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = ref(false);

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.value = false;
  };

  const debounced = ((...args: TArgs): void => {
    cancel();
    pending.value = true;
    timer = setTimeout(() => {
      timer = null;
      pending.value = false;
      fn(...args);
    }, delayMs);
  }) as DebouncedFn<TArgs>;

  debounced.cancel = cancel;
  debounced.flush = (...args: TArgs): void => {
    cancel();
    fn(...args);
  };
  Object.defineProperty(debounced, 'pending', {
    get: () => pending.value,
    enumerable: true,
  });

  onBeforeUnmount(cancel);

  return debounced;
}

/** 纯函数版防抖（不绑定组件生命周期，供非 setup 场景使用） */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs = 300,
): { (...args: TArgs): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: TArgs): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
  wrapped.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
