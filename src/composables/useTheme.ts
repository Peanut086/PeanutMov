/**
 * 主题（跟随系统默认 / 深色 / 浅色）
 *
 * 只操作 `<html data-theme>`，并监听 `prefers-color-scheme`（AC-88）。
 * 主题切换时短暂禁用 transition，避免整页泛白闪烁（设计规范 9.2）。
 *
 * OPT-14：默认跟随系统主题，用户手动选择深色/浅色后视为覆盖系统设置。
 */
import { computed, ref, watch } from 'vue';

import type { ThemeMode } from '@/types';

const STORAGE_KEY = 'peanutmov:theme';

function readStored(): ThemeMode {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

const mode = ref<ThemeMode>(readStored());
const systemDark = ref(
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true,
);

let mediaBound = false;
let transitionTimer: ReturnType<typeof setTimeout> | null = null;

const resolved = computed<'dark' | 'light'>(() =>
  mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
);

function apply(next: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', next);
  if (transitionTimer !== null) clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    root.classList.remove('theme-switching');
    transitionTimer = null;
  }, 100);
}

watch(
  resolved,
  (value) => {
    apply(value);
  },
  { immediate: true },
);

function bindMedia(): void {
  if (mediaBound || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  mediaBound = true;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = (ev: MediaQueryListEvent): void => {
    systemDark.value = ev.matches;
  };
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', listener);
  else if (typeof mql.addListener === 'function') mql.addListener(listener);
}

export function useTheme(): {
  mode: typeof mode;
  resolved: typeof resolved;
  setMode: (next: ThemeMode) => void;
} {
  bindMedia();

  function setMode(next: ThemeMode): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      /* 隐私模式忽略 */
    }
    mode.value = next;
  }

  return { mode, resolved, setMode };
}

/** 测试辅助 */
export function __resetTheme(): void {
  mode.value = 'system';
  systemDark.value = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', systemDark.value ? 'dark' : 'light');
  }
}
