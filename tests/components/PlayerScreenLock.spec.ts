/**
 * 横屏屏幕锁（B4 · UI 侧 · 设计规范 ⑦ `pl-lock`）
 *
 * 只核对真机上最容易翻车的三件事：
 * 锁定态有没有真的铺出拦截片（手势必须继续被吃掉）、
 * 解锁 UI 是不是「轻点才出现 + 到点自动收起」（常驻会一直压住画面）、
 * 以及解锁键会不会被算成轻点而吞掉 toggle。
 *
 * Transition 打桩：这里要核的是显隐事实，淡入淡出交给真机验收；
 * 不桩的话摘节点要等帧，计时断言会被帧时刻污染。
 */
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PlayerScreenLock from "@/components/player/PlayerScreenLock.vue";
import { CONTROLS_HIDE_DELAY_MS } from "@/player/constants";

const wrappers: VueWrapper[] = [];

function mountLocked(locked = true): VueWrapper {
  const wrapper = mount(PlayerScreenLock, {
    props: { locked },
    global: { stubs: { Transition: true } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 轻点画面（真实设备上 pointerdown 即响应，不必等 click） */
async function tapLayer(wrapper: VueWrapper): Promise<void> {
  await wrapper.get(".pl-lock").trigger("pointerdown");
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe("PlayerScreenLock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("未锁定：整层不渲染（画面与手势都不该被吃）", () => {
    const wrapper = mountLocked(false);

    expect(wrapper.find(".pl-lock").exists()).toBe(false);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);
  });

  it("刚上锁：只铺拦截片，压暗/提示/解锁键都不出现", () => {
    const wrapper = mountLocked();

    expect(wrapper.get(".pl-lock").attributes("class")).toContain("pl-lock");
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);
    expect(wrapper.find(".pl-lock__btn").exists()).toBe(false);
  });

  it("轻点画面：提示与解锁键出现", async () => {
    const wrapper = mountLocked();
    await tapLayer(wrapper);

    expect(wrapper.get(".pl-lock__hint").text()).toContain("屏幕已锁定");
    const btn = wrapper.get(".pl-lock__btn");
    expect(btn.text()).toContain("解锁");
    expect(btn.attributes("aria-label")).toBe("解锁屏幕");
  });

  it("显示与控制条同档后自动收起", async () => {
    const wrapper = mountLocked();
    await tapLayer(wrapper);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(CONTROLS_HIDE_DELAY_MS - 1);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);
  });

  it("显示期间再轻点一次立即收起，且先前排的计时不会让它再冒出来", async () => {
    const wrapper = mountLocked();
    await tapLayer(wrapper);
    await tapLayer(wrapper);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);

    await vi.advanceTimersByTimeAsync(CONTROLS_HIDE_DELAY_MS * 2);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);
  });

  it("自动收起后再轻点，重新出现并再走一档计时", async () => {
    const wrapper = mountLocked();
    await tapLayer(wrapper);

    await vi.advanceTimersByTimeAsync(CONTROLS_HIDE_DELAY_MS);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);

    await tapLayer(wrapper);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(CONTROLS_HIDE_DELAY_MS - 1);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);
  });

  it("重新上锁回到收起态，不带上一次的显示状态", async () => {
    const wrapper = mountLocked();
    await tapLayer(wrapper);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(true);

    await wrapper.setProps({ locked: false });
    await wrapper.setProps({ locked: true });

    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(false);
  });

  it("点解锁键只发 toggle，不会被算成轻点画面", async () => {
    const wrapper = mountLocked();
    await tapLayer(wrapper);

    await wrapper.get(".pl-lock__btn").trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
    expect(wrapper.find(".pl-lock__chrome").exists()).toBe(true);
  });

  it("画面区域上的点击与其余指针事件都只吞不解", async () => {
    const wrapper = mountLocked();
    const layer = wrapper.get(".pl-lock");

    await layer.trigger("click");
    await layer.trigger("pointermove");
    await layer.trigger("pointerup");
    expect(wrapper.emitted("toggle")).toBeUndefined();
  });
});
