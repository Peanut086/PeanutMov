<script setup lang="ts">
/**
 * 布局外壳：安全区 + 滚动区 + 底部 TabBar 预留
 *
 * 页面只负责内容，安全区与底部留白由本组件统一处理，避免每页重复写 env()。
 */
withDefaults(
  defineProps<{
    /** 是否有一级 TabBar（预留 56px + safe-bottom） */
    tabbar?: boolean;
    /** 是否禁用页面左右内边距（播放器等全宽场景） */
    flush?: boolean;
  }>(),
  { tabbar: false, flush: false },
);
</script>

<template>
  <div class="safe-area" :class="{ 'safe-area--tabbar': tabbar }">
    <div class="safe-area__inner" :class="{ 'safe-area__inner--flush': flush }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.safe-area {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-top: var(--safe-top);
  padding-right: var(--safe-right);
  padding-left: var(--safe-left);
  background-color: var(--color-bg-base);
}

.safe-area--tabbar {
  padding-bottom: calc(var(--layout-tabbar-height) + var(--safe-bottom));
}

.safe-area__inner {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-left: var(--layout-page-padding-x);
  padding-right: var(--layout-page-padding-x);
}

.safe-area__inner--flush {
  padding-left: 0;
  padding-right: 0;
}
</style>
