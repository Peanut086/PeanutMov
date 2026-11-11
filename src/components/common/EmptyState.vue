<script setup lang="ts">
/**
 * 空态（设计规范 8.10）
 *
 * 96×96 单色线性插图（不使用位图）+ 标题 + 说明 + 可选主按钮。
 * 空态必须带可执行按钮（页面蓝图 §20.3）。
 * aperture 变体（C-12）：借用开屏光圈的虹膜造型做"对不上焦"动效。
 */
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    /** 主按钮文案；为空则不渲染按钮 */
    actionText?: string;
    /** 插图语义：默认"盒子"，可切换 */
    variant?: 'box' | 'search' | 'history' | 'favorite' | 'download' | 'source' | 'aperture';
  }>(),
  {
    title: '暂无内容',
    description: '',
    actionText: '',
    variant: 'box',
  },
);

const emit = defineEmits<{ (e: 'action'): void }>();

/** 虹膜叶片数：与品牌 mark 的六等分一致 */
const BLADES = [1, 2, 3, 4, 5, 6];
</script>

<template>
  <div class="empty-state" data-state="empty">
    <svg
      class="empty-state__art"
      :class="{ 'empty-state__art--aperture': variant === 'aperture' }"
      viewBox="0 0 96 96"
      fill="none"
      stroke="var(--color-text-disabled)"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="variant === 'aperture'">
        <circle class="empty-state__iris-ring" cx="48" cy="48" r="34" />
        <g
          v-for="blade in BLADES"
          :key="blade"
          :transform="`rotate(${(blade - 1) * 60} 48 48)`"
          class="empty-state__iris"
        >
          <path
            class="empty-state__blade"
            :style="{ opacity: 0.34 + (blade % 3) * 0.14, animationDelay: `${(blade - 1) * 30}ms` }"
            d="M48 12 L79 30 L48 48 Z"
          />
        </g>
        <circle class="empty-state__pupil" cx="48" cy="48" r="9" />
      </template>
      <template v-else-if="variant === 'search'">
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
    <slot />
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

/* C-12：虹膜叶片用品牌琥珀色，虚线感的外圈负责"镜头"轮廓 */
.empty-state__iris-ring {
  stroke-width: 1.6;
  opacity: 0.7;
}

.empty-state__blade {
  fill: var(--color-brand-text);
  stroke: none;
  animation: iris-focus 900ms var(--ease-standard);
}

.empty-state__pupil {
  fill: var(--color-brand-soft);
  stroke: var(--color-brand-text);
  stroke-width: 1.6;
}

/* 对焦失败：叶片拧合两次后回到张开态，再轻抖一下画框。只播一次 */
.empty-state__art--aperture {
  animation: iris-miss 300ms var(--ease-standard) 380ms;
}

/* 基础态即"张开态"，所以 reduced-motion（时长归零）下自动静止在这里 */
@keyframes iris-focus {
  0% {
    transform: translate(48px, 48px) rotate(0deg) scale(1) translate(-48px, -48px);
  }
  34% {
    transform: translate(48px, 48px) rotate(24deg) scale(0.86) translate(-48px, -48px);
  }
  58% {
    transform: translate(48px, 48px) rotate(19deg) scale(0.9) translate(-48px, -48px);
  }
  80% {
    transform: translate(48px, 48px) rotate(24deg) scale(0.86) translate(-48px, -48px);
  }
  100% {
    transform: translate(48px, 48px) rotate(0deg) scale(1) translate(-48px, -48px);
  }
}

@keyframes iris-miss {
  0%,
  100% {
    transform: translateX(0);
  }
  30% {
    transform: translateX(-3px);
  }
  65% {
    transform: translateX(3px);
  }
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
