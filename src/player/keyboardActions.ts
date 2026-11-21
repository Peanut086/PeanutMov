/**
 * 播放页键盘映射（设计规范 ⑨，与原型 keydown 分支一一对应）
 *
 * 独立成模块而不是写在 `PlayerView` 里：这张表有 14 档按键 + Shift 组合 +
 * 数字键 + 锁屏闸门四条分支，只有纯函数才能被单测逐档覆盖；`PlayerView` 只负责
 * 把动作落到真实的播放控制上。
 */

import { VOLUME_STEP } from "./constants";

/** 亮度键步进：与音量同档（原型 `Shift+↑/↓` 各 5） */
export const BRIGHTNESS_STEP = 5;

/** 帧步进：24fps 的一帧（原型 `,` / `.`） */
export const FRAME_STEP_SEC = 1 / 24;

/** `J` / `L` 的固定跳距（原型写死 10s）；方向键仍走用户设置的 `seekStepSec` */
export const LONG_SEEK_SEC = 10;

/** 滚轮一格对应的音量增减（原型 `wheel` 分支） */
export const WHEEL_VOLUME_STEP = 4;

export type KeyAction =
  | { kind: "play" }
  | { kind: "seek"; delta: number }
  | { kind: "volume"; delta: number }
  | { kind: "brightness"; delta: number }
  | { kind: "mute" }
  | { kind: "frame"; delta: number }
  | { kind: "percent"; tenths: number }
  | { kind: "fullscreen" }
  | { kind: "subtitle" }
  | { kind: "danmaku" }
  | { kind: "drawer" }
  | { kind: "lock" }
  | { kind: "help" }
  | { kind: "escape" };

/**
 * 把一次 keydown 解析成播放动作。
 *
 * 闸门顺序即契约：`Escape` 永远先返回（锁屏时它是逃生口）→ 锁屏只放行 `K`（解锁），
 * 其余按键全部让位 → `Shift+方向` 优先于普通方向（亮度档）→ 数字键 → 字母/符号表。
 * 未命中返回 `null`，调用方不应 `preventDefault`，把键还给浏览器与无障碍。
 *
 * @param opts.seekStep 方向键步长（秒），来自用户设置
 * @param opts.locked   屏幕锁是否生效
 */
export function resolveKeyAction(
  ev: Pick<KeyboardEvent, "key" | "shiftKey">,
  opts: { seekStep: number; locked: boolean },
): KeyAction | null {
  if (ev.key === "Escape") return { kind: "escape" };
  if (opts.locked) {
    // 锁屏时键盘只留两个出口：Escape（退出全屏并自动解锁）与 K（直接解锁）。
    // 控制条此时已收起，画面上那枚解锁键是鼠标/触屏的唯一出路，键盘不该无路可走。
    return ev.key.toLowerCase() === "k" ? { kind: "lock" } : null;
  }

  if (ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
    return {
      kind: "brightness",
      delta: ev.key === "ArrowUp" ? BRIGHTNESS_STEP : -BRIGHTNESS_STEP,
    };
  }

  if (/^[0-9]$/.test(ev.key)) {
    return { kind: "percent", tenths: Number(ev.key) };
  }

  switch (ev.key.toLowerCase()) {
    case " ":
      return { kind: "play" };
    case "arrowleft":
      return { kind: "seek", delta: -opts.seekStep };
    case "arrowright":
      return { kind: "seek", delta: opts.seekStep };
    case "j":
      return { kind: "seek", delta: -LONG_SEEK_SEC };
    case "l":
      return { kind: "seek", delta: LONG_SEEK_SEC };
    case "arrowup":
      return { kind: "volume", delta: VOLUME_STEP };
    case "arrowdown":
      return { kind: "volume", delta: -VOLUME_STEP };
    case "m":
      return { kind: "mute" };
    case "f":
      return { kind: "fullscreen" };
    case "s":
      return { kind: "subtitle" };
    case "d":
      return { kind: "danmaku" };
    case "e":
      return { kind: "drawer" };
    case "k":
      return { kind: "lock" };
    case "?":
      return { kind: "help" };
    case ",":
      return { kind: "frame", delta: -FRAME_STEP_SEC };
    case ".":
      return { kind: "frame", delta: FRAME_STEP_SEC };
    default:
      return null;
  }
}
