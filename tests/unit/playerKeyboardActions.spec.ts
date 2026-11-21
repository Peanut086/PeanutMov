/**
 * 播放页键盘映射（设计规范 ⑨）
 *
 * 红线：
 * - 锁屏时只留两个出口（Escape / K 解锁），其余按键全部让位
 * - Shift+↑/↓ 是亮度档，不能被当成音量；未命中的键返回 null（调用方不 preventDefault）
 * - 数字键是百分比定位，方向键步长跟用户设置，J/L 是稿上固定的 10s
 */
import { describe, expect, it } from "vitest";

import { VOLUME_STEP } from "@/player/constants";
import {
  BRIGHTNESS_STEP,
  FRAME_STEP_SEC,
  LONG_SEEK_SEC,
  WHEEL_VOLUME_STEP,
  resolveKeyAction,
} from "@/player/keyboardActions";

function key(
  k: string,
  opts: { shift?: boolean; locked?: boolean; seekStep?: number } = {},
) {
  return resolveKeyAction(
    { key: k, shiftKey: opts.shift ?? false },
    {
      seekStep: opts.seekStep ?? 10,
      locked: opts.locked ?? false,
    },
  );
}

describe("player keyboard actions", () => {
  it("空格播放/暂停，方向键走用户设置的步长", () => {
    expect(key(" ")).toEqual({ kind: "play" });
    expect(key("ArrowLeft")).toEqual({ kind: "seek", delta: -10 });
    expect(key("ArrowRight", { seekStep: 30 })).toEqual({
      kind: "seek",
      delta: 30,
    });
  });

  it("J/L 是稿上固定的 10s 大步，与方向键步长互不干扰", () => {
    expect(key("j")).toEqual({ kind: "seek", delta: -LONG_SEEK_SEC });
    expect(key("l")).toEqual({ kind: "seek", delta: LONG_SEEK_SEC });
    expect(key("l", { seekStep: 30 })).toEqual({
      kind: "seek",
      delta: LONG_SEEK_SEC,
    });
  });

  it("↑/↓ 调音量，Shift 后换成亮度且步长各自成档", () => {
    expect(key("ArrowUp")).toEqual({ kind: "volume", delta: VOLUME_STEP });
    expect(key("ArrowDown")).toEqual({ kind: "volume", delta: -VOLUME_STEP });
    expect(key("ArrowUp", { shift: true })).toEqual({
      kind: "brightness",
      delta: BRIGHTNESS_STEP,
    });
    expect(key("ArrowDown", { shift: true })).toEqual({
      kind: "brightness",
      delta: -BRIGHTNESS_STEP,
    });
  });

  it("数字键换算成百分比定位档位", () => {
    expect(key("0")).toEqual({ kind: "percent", tenths: 0 });
    expect(key("9")).toEqual({ kind: "percent", tenths: 9 });
  });

  it("逐帧键 , 与 . 各走一帧（24fps）", () => {
    expect(key(",")).toEqual({ kind: "frame", delta: -FRAME_STEP_SEC });
    expect(key(".")).toEqual({ kind: "frame", delta: FRAME_STEP_SEC });
  });

  it("功能键齐备：M/F/S/D/E/K/?", () => {
    expect(key("m")).toEqual({ kind: "mute" });
    expect(key("f")).toEqual({ kind: "fullscreen" });
    expect(key("s")).toEqual({ kind: "subtitle" });
    expect(key("d")).toEqual({ kind: "danmaku" });
    expect(key("e")).toEqual({ kind: "drawer" });
    expect(key("k")).toEqual({ kind: "lock" });
    expect(key("?")).toEqual({ kind: "help" });
  });

  it("大写字母与 Shift 组合仍认得（? 本身就带 Shift）", () => {
    expect(key("F", { shift: true })).toEqual({ kind: "fullscreen" });
    expect(key("K", { shift: true })).toEqual({ kind: "lock" });
    expect(key("?", { shift: true })).toEqual({ kind: "help" });
  });

  it("锁屏只留两个出口：Escape 与 K（解锁），其余按键一律让位", () => {
    expect(key("Escape", { locked: true })).toEqual({ kind: "escape" });
    expect(key("k", { locked: true })).toEqual({ kind: "lock" });
    expect(key("K", { locked: true, shift: true })).toEqual({ kind: "lock" });
    expect(key(" ", { locked: true })).toBeNull();
    expect(key("f", { locked: true })).toBeNull();
    expect(key("m", { locked: true })).toBeNull();
    expect(key("ArrowRight", { locked: true })).toBeNull();
    expect(key("9", { locked: true })).toBeNull();
  });

  it("Escape 在未锁屏时同样优先返回，不与帮助键混淆", () => {
    expect(key("Escape")).toEqual({ kind: "escape" });
  });

  it("未映射的键返回 null，交还浏览器与无障碍", () => {
    expect(key("Tab")).toBeNull();
    expect(key("a")).toBeNull();
    expect(key("/")).toBeNull();
    expect(key("Enter")).toBeNull();
  });

  it("滚轮一格 4，比键盘音量档更细", () => {
    expect(WHEEL_VOLUME_STEP).toBe(4);
    expect(WHEEL_VOLUME_STEP).toBeLessThan(VOLUME_STEP);
  });
});
