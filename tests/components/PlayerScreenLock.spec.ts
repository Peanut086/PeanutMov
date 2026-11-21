/**
 * 横屏屏幕锁（B4 · UI 侧 · 设计规范 ⑦ `pl-lock`）
 *
 * 只核对真机上最容易翻车的三件事：
 * 锁定态有没有真的铺出拦截片、拦截片会不会被误点成解锁、
 * 以及解锁键是不是常驻（锁屏时控制条已收起，顶部那颗键点不到，
 * 出口一旦要「先轻触画面唤回」就等于没有出口）。
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import PlayerScreenLock from "@/components/player/PlayerScreenLock.vue";

describe("PlayerScreenLock", () => {
  it("未锁定：整层不渲染（画面与手势都不该被吃）", () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: false } });

    expect(wrapper.find(".pl-lock").exists()).toBe(false);
    expect(wrapper.find(".pl-lock__btn").exists()).toBe(false);
  });

  it("锁定：铺拦截片并给出常驻解锁键", () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: true } });

    expect(wrapper.get(".pl-lock").attributes("class")).toContain("pl-lock");
    expect(wrapper.get(".pl-lock__hint").text()).toContain("屏幕已锁定");

    const btn = wrapper.get(".pl-lock__btn");
    expect(btn.text()).toContain("解锁");
    expect(btn.attributes("aria-label")).toBe("解锁屏幕");
  });

  it("点解锁键发 toggle，且不穿透到拦截片", async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: true } });

    await wrapper.get(".pl-lock__btn").trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
  });

  it("点画面区域只吞事件，不解锁", async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: true } });

    await wrapper.get(".pl-lock").trigger("click");
    expect(wrapper.emitted("toggle")).toBeUndefined();
  });

  it("画面区域上的指针事件不会变成解锁动作", async () => {
    const wrapper = mount(PlayerScreenLock, { props: { locked: true } });
    const layer = wrapper.get(".pl-lock");

    await layer.trigger("pointerdown");
    await layer.trigger("pointermove");
    await layer.trigger("pointerup");
    expect(wrapper.emitted("toggle")).toBeUndefined();
  });
});
