<script setup lang="ts">
/**
 * 顶栏（设计规范 6.2 / 页面蓝图 18.1）
 *
 * - 一级页：左侧标题，右侧 0–2 个图标操作
 * - 二级页：左侧返回，中间标题，右侧 0–1 个操作
 * - 吸顶：背景 bg-base，向下 8px 渐隐
 */
import { computed, getCurrentInstance } from 'vue';
import { useRouter } from 'vue-router';

import IconBack from '@/components/icons/IconBack.vue';
import IconSearch from '@/components/icons/IconSearch.vue';
import IconSettings from '@/components/icons/IconSettings.vue';
import markSrc from '@/assets/brand/logo-mark.png';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 显示返回按钮 */
    back?: boolean;
    /** 右侧是否为搜索按钮 */
    search?: boolean;
    /** 右侧是否为设置按钮 */
    settings?: boolean;
    /** 标题左侧是否有品牌标记（仅一级页） */
    brand?: boolean;
  }>(),
  { back: false, search: false, settings: false, brand: false },
);

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'search'): void;
  (e: 'settings'): void;
  (e: 'action'): void;
}>();

const router = useRouter();
const instance = getCurrentInstance();

const showActions = computed(() => props.search || props.settings);

function goBack(): void {
  emit('back');
  // 页面自己处理了 @back（可能带二次确认）时不再兜底回退，否则会连退两级
  if (typeof instance?.vnode.props?.['onBack'] === 'function') return;
  const h = globalThis.history;
  if (typeof h?.length === 'number' && h.length > 1) router.back();
  else void router.replace('/');
}
</script>

<template>
  <header class="app-header">
    <button
      v-if="back"
      class="app-header__icon"
      type="button"
      aria-label="返回"
      @click="goBack"
    >
      <IconBack :size="24" />
    </button>

    <h1 class="app-header__title" :class="{ 'app-header__title--brand': brand }">
      <img v-if="brand" class="app-header__mark" :src="markSrc" alt="" height="28" />
      <slot name="before-title" />
      <span class="truncate-1">{{ title }}</span>
    </h1>

    <slot name="subtitle" />

    <div class="app-header__actions">
      <slot name="actions" />
      <template v-if="showActions">
        <button
          v-if="search"
          class="app-header__icon"
          type="button"
          aria-label="搜索"
          @click="emit('search')"
        >
          <IconSearch :size="20" />
        </button>
        <button
          v-if="settings"
          class="app-header__icon"
          type="button"
          aria-label="设置"
          @click="emit('settings')"
        >
          <IconSettings :size="20" />
        </button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--layout-header-height);
  padding: var(--safe-top) var(--layout-page-padding-x) 0;
  background-color: var(--color-bg-base);
  box-shadow: 0 var(--space-2) var(--space-2) calc(var(--space-2) * -1) var(--color-bg-base);
}

/* 顶栏下的渐隐，避免内容滚动时"切断"感 */
.app-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(var(--space-2) * -1 + 2px);
  height: var(--space-2);
  background: linear-gradient(180deg, var(--color-bg-base) 0%, transparent 100%);
  pointer-events: none;
}

.app-header__title {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-title-1);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.app-header__mark {
  height: 28px;
  width: auto;
  flex-shrink: 0;
  vertical-align: middle;
}

.app-header__title--brand {
  letter-spacing: var(--letter-spacing-tight);
  background: linear-gradient(120deg, var(--color-brand-strong), var(--color-brand));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.app-header__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-right: calc(var(--space-2) * -1);
}

.app-header__icon {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  transition: var(--transition-color);
}

.app-header__icon:active {
  background-color: var(--color-overlay-press-strong);
}
</style>
