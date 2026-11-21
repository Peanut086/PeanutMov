<script setup lang="ts">
/**
 * 屏幕锁（B4 → 设计规范 ⑦ `pl-lock`）
 *
 * 锁定态铺一层压暗片盖住画面矩形：所有手势/控件都不再响应，只留左下角一枚常驻「解锁」。
 * 样式与显隐都在 player-chrome.css（`.pl-shell[data-locked="1"] .pl-lock`），
 * 这里只管拦截与动作。入口常驻而不是「轻触画面唤回胶囊」——锁屏时控制条已收起，
 * 顶部那颗锁定键点不到，再藏一次就真找不到出口了。
 *
 * 竖屏也生效（`K` 或顶栏锁键）：信息区由壳层 `inert` 让位，锁屏层只吃画面，
 * 不铺满整屏，下方内容仍可正常滚动。
 */
import IconLock from "@/components/icons/IconLock.vue";

defineProps<{ locked: boolean }>();

const emit = defineEmits<{ (e: "toggle"): void }>();
</script>

<template>
  <Transition name="pl-lock">
    <div
      v-if="locked"
      class="pl-lock"
      @pointerdown.stop
      @pointermove.stop
      @pointerup.stop
      @click.stop
    >
      <p class="pl-lock__hint">屏幕已锁定 · 手势与控制条已禁用</p>
      <button
        class="pl-btn pl-lock__btn"
        type="button"
        aria-label="解锁屏幕"
        @pointerdown.stop
        @click.stop="emit('toggle')"
      >
        <IconLock :locked="true" :size="22" />
        <span>解锁</span>
      </button>
    </div>
  </Transition>
</template>
