<script setup lang="ts">
/**
 * OPT-10：手势帮助浮层
 *
 * 显示当前真正可用的手势与快捷键，手动关闭。卡片/压暗/显隐都在
 * player-chrome.css 的 ⑦ `.pl-help` 上，由 `.pl-shell[data-help="1"]` 驱动。
 * 触发入口有两个，弹出策略不同（见 `player/gestureHelpPolicy`）：
 * - 暂停时长按 3 秒自动呼出：同一会话内最多 1 次，之后进入冷却
 * - 「更多 → 手势说明」：用户主动行为，始终可弹
 * 与 GestureGuide 的区别：GestureGuide 首次进入自动显示，5 秒后自动消失。
 * 键盘档只列 PlayerView `onKeydown` 里真实接住的键，其余等键盘统一接线后补。
 *
 * 卡体是「头 + 可滚行区 + 脚」三段：竖屏 390×844 整卡不滚，横屏 390 高必然要滚，
 * 但滚动只收在 `.pl-help__body` 里，标题与「关闭」始终留在卡上（组件挂在壳层，
 * 不受竖屏 219px 画面带的高度限制）。
 */
withDefaults(
  defineProps<{
    visible: boolean;
  }>(),
  { visible: false },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

function onClose(): void {
  emit("close");
}
</script>

<template>
  <Transition name="pl-help">
    <div
      v-if="visible"
      class="pl-help"
      role="dialog"
      aria-label="手势帮助"
      @click.stop="onClose"
    >
      <div class="pl-help__card" @click.stop>
        <div class="pl-help__head">
          <h2>手势与快捷键</h2>
          <button
            class="pl-help__close"
            type="button"
            aria-label="关闭"
            @click="onClose"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="pl-help__body">
          <div class="pl-help__group">
            <p class="pl-help__group-title">手势</p>
            <div class="pl-help__list">
              <div>
                <span>单击画面</span>
                <b>显示 / 隐藏控制条</b>
              </div>
              <div>
                <span>双击画面</span>
                <b>播放 / 暂停</b>
              </div>
              <div>
                <span>水平拖动</span>
                <b>快退 / 快进（最长 90s）</b>
              </div>
              <div>
                <span>垂直拖动</span>
                <b>左亮度 · 右音量</b>
              </div>
              <div>
                <span>长按画面</span>
                <b>2x 临时倍速</b>
              </div>
              <div>
                <span>暂停时长按 3 秒</span>
                <b>呼出本帮助</b>
              </div>
            </div>
          </div>

          <div class="pl-help__group">
            <p class="pl-help__group-title">键盘</p>
            <div class="pl-help__list">
              <div>
                <span>播放 / 暂停</span>
                <kbd>空格</kbd>
              </div>
              <div>
                <span>快退 / 快进</span>
                <kbd>← →</kbd>
              </div>
              <div>
                <span>大步进退（10s）</span>
                <kbd>J / L</kbd>
              </div>
              <div>
                <span>音量 − / +</span>
                <kbd>↓ ↑</kbd>
              </div>
              <div>
                <span>亮度 − / +</span>
                <kbd>Shift + ↓ ↑</kbd>
              </div>
              <div>
                <span>静音 / 还原</span>
                <kbd>M</kbd>
              </div>
              <div>
                <span>逐帧</span>
                <kbd>, .</kbd>
              </div>
              <div>
                <span>跳到百分比</span>
                <kbd>0 – 9</kbd>
              </div>
              <div>
                <span>全屏</span>
                <kbd>F</kbd>
              </div>
              <div>
                <span>字幕</span>
                <kbd>S</kbd>
              </div>
              <div>
                <span>弹幕</span>
                <kbd>D</kbd>
              </div>
              <div>
                <span>选集面板</span>
                <kbd>E</kbd>
              </div>
              <div>
                <span>锁定屏幕</span>
                <kbd>K</kbd>
              </div>
              <div>
                <span>本帮助 / 关闭</span>
                <kbd>? Esc</kbd>
              </div>
              <div>
                <span>悬停画面滚动</span>
                <kbd>音量</kbd>
              </div>
            </div>
          </div>
        </div>

        <div class="pl-err__acts">
          <button class="pl-cta pl-cta--ghost" type="button" @click="onClose">
            关闭
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
