<script setup lang="ts">
/**
 * 设置分组（页面蓝图 §10）
 *
 * 结构：可选分组标题 + 圆角卡片容器 + 行列表（行间 1px divider）。
 */
withDefaults(defineProps<{ title?: string }>(), { title: '' });
</script>

<template>
  <section class="settings-group">
    <h2 v-if="title" class="settings-group__title">{{ title }}</h2>
    <div class="settings-group__card">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.settings-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-5);
}

.settings-group__title {
  padding-left: var(--space-1);
  font: var(--text-caption);
  letter-spacing: var(--letter-spacing-wide);
  color: var(--color-text-tertiary);
}

.settings-group__card {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  overflow: hidden;
}
</style>
