<script setup lang="ts">
/**
 * 空态（设计规范 8.10）
 *
 * 96×96 单色线性插图（不使用位图）+ 标题 + 说明 + 可选主按钮。
 * 空态必须带可执行按钮（页面蓝图 §20.3）。
 */
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    /** 主按钮文案；为空则不渲染按钮 */
    actionText?: string;
    /** 插图语义：默认"盒子"，可切换 */
    variant?: 'box' | 'search' | 'history' | 'favorite' | 'download' | 'source';
  }>(),
  {
    title: '暂无内容',
    description: '',
    actionText: '',
    variant: 'box',
  },
);

const emit = defineEmits<{ (e: 'action'): void }>();
</script>

<template>
  <div class="empty-state" data-state="empty">
    <svg
      class="empty-state__art"
      viewBox="0 0 96 96"
      fill="none"
      stroke="var(--color-text-disabled)"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="variant === 'search'">
        <circle cx="43" cy="43" r="20" />
        <path d="m58 58 14 14" stroke="var(--color-brand-soft)" stroke-width="4" />
        <path d="M35 43h16" />
      </template>
      <template v-else-if="variant === 'history'">
        <circle cx="48" cy="48" r="24" />
        <path d="M48 32v16l11 7" />
        <path d="M24 48H16" stroke="var(--color-brand-soft)" stroke-width="4" />
      </template>
      <template v-else-if="variant === 'favorite'">
        <path d="M48 74S24 60 24 42a13 13 0 0 1 24-7 13 13 0 0 1 24 7c0 18-24 32-24 32Z" />
        <path d="M40 46h16" stroke="var(--color-brand-soft)" stroke-width="4" />
      </template>
      <template v-else-if="variant === 'download'">
        <path d="M48 20v32" />
        <path d="m34 40 14 14 14-14" />
        <path d="M24 72h48" stroke="var(--color-brand-soft)" stroke-width="4" />
      </template>
      <template v-else-if="variant === 'source'">
        <rect x="20" y="28" width="56" height="14" rx="5" />
        <rect x="20" y="52" width="56" height="14" rx="5" stroke="var(--color-brand-soft)" />
        <path d="M32 35h8M32 59h8" />
      </template>
      <template v-else>
        <path d="M20 38 48 24l28 14v30a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4Z" />
        <path d="M20 38h56" />
        <path d="M40 56h16" stroke="var(--color-brand-soft)" stroke-width="4" />
      </template>
    </svg>

    <p class="empty-state__title">{{ title }}</p>
    <p v-if="description" class="empty-state__desc">{{ description }}</p>
    <button
      v-if="actionText"
      class="btn btn--secondary btn--md empty-state__action"
      type="button"
      @click="emit('action')"
    >
      {{ actionText }}
    </button>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  max-width: 280px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-5);
  text-align: center;
}

.empty-state__art {
  width: 76px;
  height: 76px;
  margin-bottom: var(--space-4);
  opacity: 0.92;
}

.empty-state__title {
  font: var(--text-title-3);
  font-size: 15px;
  color: var(--color-text-primary);
}

.empty-state__desc {
  font: var(--text-caption);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.empty-state__action {
  margin-top: var(--space-5);
  min-width: 120px;
}
</style>
