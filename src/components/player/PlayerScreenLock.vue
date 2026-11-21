<script setup lang="ts">
/**
 * 屏幕锁（B4 → 设计规范 ⑦ `pl-lock`）
 *
 * 锁定态分两层：拦截片常驻吃掉画面矩形上的所有手势，压暗 + 提示 + 解锁键只在
 * 轻点画面后出现，与控制条同档 3s 后自动收起，显示期间再轻点一次立即收起。
 * 样式与显隐都在 player-chrome.css（`.pl-shell[data-locked="1"] .pl-lock`），
 * 这里只管拦截、唤回与解锁动作。压暗不再常驻是刻意的：锁屏时画面才是主角。
 *
 * 竖屏也生效（`K` 或顶栏锁键）：信息区由壳层 `inert` 让位，锁屏层只吃画面，
 * 不铺满整屏，下方内容仍可正常滚动。
 */
import { onBeforeUnmount, ref, watch } from "vue";

import IconLock from "@/components/icons/IconLock.vue";
import { CONTROLS_HIDE_DELAY_MS } from "@/player/constants";

const props = defineProps<{ locked: boolean }>();

const emit = defineEmits<{ (e: "toggle"): void }>();

/** 压暗 + 提示 + 解锁键是否显示；上锁那一刻先全部收起，靠轻点唤回 */
const revealed = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHideTimer(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = null;
}

/** 轻点画面的取舍与未锁定时「单击切换控制条」一致：收起则唤回并重新计时，显示则立即收起 */
function onTap(): void {
  clearHideTimer();
  if (revealed.value) {
    revealed.value = false;
    return;
  }
  revealed.value = true;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    revealed.value = false;
  }, CONTROLS_HIDE_DELAY_MS);
}

watch(
  () => props.locked,
  (locked) => {
    clearHideTimer();
    if (locked) revealed.value = false;
  },
);

onBeforeUnmount(clearHideTimer);
</script>

<template>
  <div
    v-if="locked"
    class="pl-lock"
    @pointerdown.stop="onTap"
    @pointermove.stop
    @pointerup.stop
    @click.stop
  >
    <Transition name="pl-lock">
      <div v-if="revealed" class="pl-lock__chrome">
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
  </div>
</template>
