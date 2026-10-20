<script setup lang="ts">
/**
 * Toast 宿主（SCF 占位，路径由 PKG-A 后续替换）
 *
 * 规格见设计规范「Toast」：底部居中、宽度 ≤ 88% 屏宽、圆角 12px、
 * 背景 elevated + elevation-3、进入 200ms 上移淡入、默认 2400ms 自动消失。
 *
 * 真实实现将订阅 `uiStore.toasts`；SCF 阶段只渲染空容器以保证
 * `App.vue` 的结构与叠放层级（z-index: toast）在首日即可验证。
 */
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite" aria-atomic="false">
    <!-- PKG-A：在此渲染 uiStore.toasts（type: info | success | error） -->
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  bottom: calc(var(--layout-tabbar-height) + var(--safe-bottom) + var(--space-4));
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: center;
  width: min(88vw, 420px);
  transform: translateX(-50%);
  pointer-events: none;
}
</style>
