<script setup lang="ts">
/**
 * 布局外壳：只处理 env() 安全区，**不施加内容留白**。
 *
 * 三向内容留白都有唯一负责方，本组件再叠一层就会翻倍：
 * - 顶部：`AppHeader` 自带 `padding-top: var(--safe-top)`；
 * - 左右：各页顶栏与 body 按 `--layout-page-padding-x` 自行取值；
 * - 底部：`App.vue` 的 `.app-content--tabbar` 已预留 TabBar 高度。
 *
 * 实测（390px / 2x 截图）：双层左右留白让内容从 32px 起、海报 156.5px，
 * 而规范 §6.4 要求 16px 起、173px——窄了约 10%。
 *
 * 左右只保留 `--safe-*`（刘海横屏才非零），它属于系统安全区，
 * 与页面内容留白是两件事，可以叠加。
 */
// `tabbar` 保留为语义标记（页面据此说明自身属于一级 Tab 页），
// 底部预留已由 App.vue 的 .app-content--tabbar 统一承担。
withDefaults(defineProps<{ tabbar?: boolean }>(), { tabbar: false });
</script>

<template>
  <div class="safe-area">
    <slot />
  </div>
</template>

<style scoped>
.safe-area {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
  background-color: var(--color-bg-base);
}
</style>
