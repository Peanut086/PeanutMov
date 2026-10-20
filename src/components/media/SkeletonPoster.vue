<script setup lang="ts">
/**
 * 海报骨架（设计规范 7.3 / 8.10）
 *
 * 形状 = 真实内容形状：2:3 海报 + 2 行标题骨架；圆角 12。
 * `prefers-reduced-motion` 下停止扫光（global.css 已处理）。
 */
withDefaults(defineProps<{ withTitle?: boolean }>(), { withTitle: true });
</script>

<template>
  <div class="skeleton-poster" aria-hidden="true">
    <div class="skeleton skeleton-poster__img" />
    <template v-if="withTitle">
      <div class="skeleton skeleton-poster__line" />
      <div class="skeleton skeleton-poster__line skeleton-poster__line--short" />
    </template>
  </div>
</template>

<style scoped>
.skeleton-poster {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skeleton-poster__img {
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
}

.skeleton-poster__line {
  height: var(--line-height-12);
  border-radius: var(--radius-sm);
}

.skeleton-poster__line--short {
  width: 55%;
}
</style>
