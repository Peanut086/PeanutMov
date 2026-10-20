<script setup lang="ts">
/**
 * 离线横幅（设计规范 8.16）
 *
 * 固定在顶栏下方（`top: calc(52px + safe-top)`），高 32，info-soft 底。
 * 文案与恢复提示按页面蓝图 18.4；恢复后自动隐藏（由 uiStore 驱动）。
 */
withDefaults(defineProps<{ text?: string }>(), {
  text: '离线模式，展示本地缓存',
});
</script>

<template>
  <div class="offline-banner" role="status" aria-live="polite">
    <svg
      class="offline-banner__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3l18 18" />
      <path d="M8.6 12.4a5.2 5.2 0 0 1 3.1-1.4M5.4 9.2A9.6 9.6 0 0 1 12 6.6c2.4 0 4.6.9 6.3 2.4" />
      <path d="M18.3 15.3A5.4 5.4 0 0 0 15 13" />
      <circle cx="12" cy="18.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
    <span>{{ text }}</span>
  </div>
</template>

<style scoped>
.offline-banner {
  position: sticky;
  top: var(--layout-header-height);
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 32px;
  padding: 0 var(--layout-page-padding-x);
  background-color: var(--color-info-soft);
  color: var(--color-info);
  font: var(--text-caption);
  animation: banner-in var(--duration-base) var(--ease-decelerate);
}

.offline-banner__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

@keyframes banner-in {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: none;
  }
}
</style>
