<script setup lang="ts">
/**
 * F2：爆米花桶满溢仪式（连看里程碑）
 *
 * 桶内爆米花堆上升 → 颗粒溢出飞溅 → 彩带飘落 → 「连看 N 集」徽章弹入。
 * 纯 CSS 动画 + 少量随机参数粒子（上限：爆米花 9 / 彩带 12），v-if 收口即清理 DOM。
 * reduced-motion：静态满桶 + 静态徽章，不播粒子/彩带。
 * 自动消散 + 轻触跳过；haptic / ding 由调用方在展示瞬间触发。
 */
import { onBeforeUnmount, ref, watch } from 'vue';

import { prefersReducedMotion } from '@/composables/useSpring';

const props = withDefaults(
  defineProps<{
    show: boolean;
    count?: number;
    title?: string | null;
  }>(),
  { count: 3, title: null },
);

const emit = defineEmits<{ (e: 'dismiss'): void }>();

/* 桶口爆米花堆（静态核位置，整体 scaleY 上升表现「装满」） */
const KERNELS = [
  { left: 8, top: 26, size: 22, tone: '#fff3d6' },
  { left: 30, top: 14, size: 24, tone: '#ffe9b8' },
  { left: 52, top: 22, size: 22, tone: '#fff8ec' },
  { left: 74, top: 12, size: 24, tone: '#ffd98a' },
  { left: 92, top: 26, size: 20, tone: '#fff3d6' },
  { left: 20, top: 36, size: 20, tone: '#ffe9b8' },
  { left: 64, top: 36, size: 20, tone: '#fff8ec' },
];

const reduced = ref(false);
const popcorn = ref<Array<{ id: number; style: Record<string, string> }>>([]);
const confetti = ref<Array<{ id: number; style: Record<string, string> }>>([]);
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function build(): void {
  reduced.value = prefersReducedMotion();
  if (reduced.value) {
    popcorn.value = [];
    confetti.value = [];
    return;
  }
  const tones = ['#fff3d6', '#ffe9b8', '#ffd98a', '#fff8ec'];
  popcorn.value = Array.from({ length: 9 }, (_, i) => {
    const angle = ((-90 + (i - 4) * 17) * Math.PI) / 180;
    const dist = 64 + Math.random() * 44;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    return {
      id: i,
      style: {
        '--dx': `${dx.toFixed(1)}px`,
        '--dy': `${dy.toFixed(1)}px`,
        '--rot': `${(Math.random() * 320 - 160).toFixed(0)}deg`,
        '--delay': `${(320 + i * 45).toFixed(0)}ms`,
        '--tone': tones[i % tones.length]!,
        '--size': `${(13 + Math.random() * 8).toFixed(0)}px`,
      },
    };
  });
  const hues = ['#f0a82e', '#e23b3b', '#34d399', '#60a5fa', '#e879f9', '#ffc761'];
  confetti.value = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    style: {
      '--x': `${(4 + i * 8 + Math.random() * 4).toFixed(1)}%`,
      '--delay': `${(160 + i * 70).toFixed(0)}ms`,
      '--dur': `${(1500 + Math.random() * 700).toFixed(0)}ms`,
      '--rot': `${(Math.random() * 720 - 360).toFixed(0)}deg`,
      '--hue': hues[i % hues.length]!,
      '--drift': `${(Math.random() * 64 - 32).toFixed(0)}px`,
    },
  }));
}

watch(
  () => props.show,
  (on) => {
    clearTimer();
    if (on) {
      build();
      dismissTimer = setTimeout(() => emit('dismiss'), reduced.value ? 2200 : 2900);
    } else {
      popcorn.value = [];
      confetti.value = [];
    }
  },
  { immediate: true },
);

onBeforeUnmount(clearTimer);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="binge"
      :class="{ 'binge--reduced': reduced }"
      role="presentation"
      @click="emit('dismiss')"
    >
      <span
        v-for="c in confetti"
        :key="`c${c.id}`"
        class="binge__confetti"
        :style="c.style"
        aria-hidden="true"
      ></span>

      <div class="binge__stage">
        <div class="binge__bucket">
          <span
            v-for="p in popcorn"
            :key="`p${p.id}`"
            class="binge__pop"
            :style="p.style"
            aria-hidden="true"
          ></span>
          <div class="binge__heap">
            <span
              v-for="(k, i) in KERNELS"
              :key="i"
              class="binge__kernel"
              :style="{
                left: `${k.left}px`,
                top: `${k.top}px`,
                width: `${k.size}px`,
                height: `${k.size}px`,
                backgroundColor: k.tone,
              }"
            ></span>
          </div>
          <div class="binge__cup"></div>
        </div>

        <div class="binge__badge">
          <svg class="binge__badge-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              d="M7 22h10l1.5-9h-13L7 22zm12.1-11H4.9c-.3-1.6.6-3 2-3.4.2-1.5 1.5-2.6 3-2.6.5 0 1 .1 1.4.4.6-1 1.7-1.6 2.9-1.4 1.2.2 2.1 1.1 2.3 2.3 1.3.2 2.3 1.3 2.3 2.7 0 .7-.3 1.4-.7 2z"
            />
          </svg>
          <span class="binge__badge-text">连看 {{ count }} 集</span>
        </div>
        <p v-if="title" class="binge__title truncate-1">{{ title }}</p>
        <p class="binge__hint">不知不觉追了这么多 · 轻触继续</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.binge {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-toast) + 15);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background-color: rgba(3, 4, 7, 0.78);
  backdrop-filter: blur(3px);
  cursor: pointer;
  animation: binge-in 180ms var(--ease-decelerate) both;
}

.binge__stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6);
  animation: stage-in 320ms var(--ease-decelerate) both;
}

.binge__bucket {
  position: relative;
  width: 124px;
  height: 150px;
}

.binge__cup {
  position: absolute;
  left: 0;
  right: 0;
  top: 40px;
  bottom: 0;
  clip-path: polygon(6% 0, 94% 0, 79% 100%, 21% 100%);
  background: repeating-linear-gradient(90deg, #e23b3b 0 15px, #fff7ec 15px 30px);
  filter: drop-shadow(0 14px 26px rgba(0, 0, 0, 0.5));
}

.binge__cup::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(0, 0, 0, 0.22));
}

.binge__heap {
  position: absolute;
  left: 50%;
  top: 0;
  width: 124px;
  height: 60px;
  transform: translateX(-50%) scaleY(1);
  transform-origin: bottom center;
  animation: heap-rise 720ms var(--ease-decelerate) 120ms both;
}

.binge__kernel {
  position: absolute;
  border-radius: 48% 52% 55% 45% / 55% 48% 52% 45%;
  box-shadow: inset -3px -4px 6px rgba(190, 140, 50, 0.35), inset 3px 3px 5px rgba(255, 255, 255, 0.7);
}

.binge__pop {
  position: absolute;
  left: 50%;
  top: 34px;
  width: var(--size);
  height: var(--size);
  margin-left: calc(var(--size) / -2);
  border-radius: 48% 52% 55% 45% / 55% 48% 52% 45%;
  background-color: var(--tone);
  box-shadow: inset -2px -3px 5px rgba(190, 140, 50, 0.35);
  opacity: 0;
  animation: popcorn-fly 920ms cubic-bezier(0.2, 0.7, 0.3, 1) var(--delay) both;
}

.binge__confetti {
  position: absolute;
  top: 0;
  left: var(--x);
  width: 7px;
  height: 13px;
  border-radius: 2px;
  background-color: var(--hue);
  opacity: 0;
  animation: confetti-fall var(--dur) linear var(--delay) both;
}

.binge__badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--color-brand), var(--color-brand-strong));
  color: #2a1c04;
  box-shadow: 0 8px 24px rgba(240, 168, 46, 0.35);
  animation: badge-pop 380ms var(--ease-decelerate) 620ms both;
}

.binge__badge-icon {
  display: block;
}

.binge__badge-text {
  font: var(--font-weight-semibold) 17px / 1 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
}

.binge__title {
  max-width: 70vw;
  font: var(--text-label);
  color: var(--color-text-secondary);
  text-align: center;
}

.binge__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: center;
}

@keyframes binge-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes stage-in {
  from {
    opacity: 0;
    transform: scale(0.86) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes heap-rise {
  0% {
    transform: translateX(-50%) scaleY(0.15);
  }
  70% {
    transform: translateX(-50%) scaleY(1.07);
  }
  100% {
    transform: translateX(-50%) scaleY(1);
  }
}

@keyframes popcorn-fly {
  0% {
    opacity: 0;
    transform: translate(0, 0) rotate(0) scale(0.5);
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(1);
  }
}

@keyframes confetti-fall {
  0% {
    opacity: 0;
    transform: translate(0, -12vh) rotate(0);
  }
  10% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(var(--drift), 112vh) rotate(var(--rot));
  }
}

@keyframes badge-pop {
  0% {
    opacity: 0;
    transform: scale(0.7) translateY(8px);
  }
  60% {
    opacity: 1;
    transform: scale(1.06) translateY(0);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .binge,
  .binge__stage,
  .binge__heap,
  .binge__badge {
    animation: none !important;
  }
  .binge__heap {
    transform: translateX(-50%) scaleY(1);
  }
}
</style>