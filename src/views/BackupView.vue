<script setup lang="ts">
/**
 * BackupView —— 备份导出 / 导入
 * 路由：/settings/backup（name: 'backup'）
 *
 * SCF 阶段占位：仅保证路由可导航、布局与 token 可验证。
 * 该文件路径为最终路径，由 PKG-A 在对应任务中替换为真实实现。
 * 设计依据：docs/03-设计规范/页面蓝图.md 中「backup」一节。
 */
</script>

<template>
  <main class="page placeholder-page" data-route="backup">
    <header class="placeholder-header">
      <h1 class="page-title">备份导出 / 导入</h1>
      <p class="text-tertiary">route.name = backup</p>
    </header>
    <section class="placeholder-body">
      <p class="placeholder-body__text text-secondary">
        脚手架占位页（SCF）。真实界面由 PKG-A 按页面蓝图实现。
      </p>
    </section>
  </main>
</template>

<style scoped>
.placeholder-page {
  min-height: 100%;
  padding: calc(var(--safe-top) + var(--space-4)) var(--layout-page-padding-x)
    calc(var(--safe-bottom) + var(--space-4));
  gap: var(--space-4);
}

.placeholder-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.placeholder-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  padding: var(--space-6);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
}

.placeholder-body__text {
  max-width: 32ch;
  text-align: center;
  overflow-wrap: anywhere;
}
</style>
