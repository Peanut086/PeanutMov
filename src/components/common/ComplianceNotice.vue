<script setup lang="ts">
/**
 * 合规提示条（设计规范 8.16 / FR-46）
 *
 * 固定文案、不可关闭；用于源管理、新增源、导入订阅三处（AC-103）。
 */
withDefaults(
  defineProps<{
    /** 覆盖默认文案（默认即 FR-46 标准文案） */
    text?: string;
  }>(),
  {
    text: '请仅添加你拥有访问权限的源；本 App 不提供任何片源，不对第三方内容负责。',
  },
);
</script>

<template>
  <aside class="compliance-notice" role="note">
    <svg
      class="compliance-notice__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.4 21 19.6H3Z" />
      <path d="M12 9.4v4.4" />
      <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
    <span>{{ text }}</span>
  </aside>
</template>

<style scoped>
.compliance-notice {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-warning-soft);
  border: var(--border-default);
  color: var(--color-text-secondary);
  font: var(--text-caption);
  line-height: 1.55;
}

.compliance-notice__icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  color: var(--color-warning);
}
</style>
