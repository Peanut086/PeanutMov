<script setup lang="ts">
/**
 * 换集「过片」幕布（G 批次·G-A06）
 *
 * 挂在 App 壳里（不是在 PlayerView 内），因为换集 = 整个播放页重建；状态见
 * `useEpisodeLeader`。视觉是「片门 + 走片齿孔 + EP 号码」三件事，300ms 内演完即撤。
 *
 * 全部动效只用 transform / opacity（合成器执行，主线程每帧 0 成本）；整层
 * `pointer-events: none`，所以它既不吃点击，也不在首帧链路上——画面该什么时候出来
 * 还什么时候出来，幕布只是盖在上面的一层纸。
 */
import { useEpisodeLeader } from '@/composables/useEpisodeLeader';

const { visible, label, seq } = useEpisodeLeader();
</script>

<template>
  <div v-if="visible" :key="seq" class="ep-leader" aria-hidden="true">
    <div class="ep-leader__gate">
      <span class="ep-leader__perf ep-leader__perf--top" />
      <span class="ep-leader__perf ep-leader__perf--bottom" />
      <span v-if="label" class="ep-leader__label">{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.ep-leader {
  position: fixed;
  inset: 0;
  /* 只压过播放页，弹窗 / Toast 仍在它上面 */
  z-index: calc(var(--z-player, 1000) + 1);
  display: grid;
  place-items: center;
  pointer-events: none;
  animation: ep-leader-judder var(--ep-leader-ms, 300ms)
    var(--ease-out, cubic-bezier(0, 0, 0.2, 1)) both;
}

/* 片门：一圈亮框，读作"过片窗"，不去假装对齐真实画面矩形 */
.ep-leader__gate {
  position: relative;
  width: min(62vw, 78vh);
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  border: 1px solid var(--ov-line, rgba(255, 255, 255, 0.34));
  border-radius: var(--r-md, 10px);
  background: var(--ov-gate, rgba(6, 8, 11, 0.42));
  animation: ep-leader-flash var(--ep-leader-ms, 300ms) linear both;
}

/* 齿孔带：靠渐变重复出孔位，整条向上平移一个孔距 = 走片 */
.ep-leader__perf {
  position: absolute;
  left: 0;
  right: 0;
  height: 14px;
  background: repeating-linear-gradient(
    180deg,
    var(--ov-perf, rgba(255, 255, 255, 0.5)) 0 9px,
    transparent 9px 22px
  );
  opacity: 0.5;
  animation: ep-leader-run var(--ep-leader-ms, 300ms) linear both;
}

.ep-leader__perf--top {
  top: 3px;
}

.ep-leader__perf--bottom {
  bottom: 3px;
}

.ep-leader__label {
  font: var(--ep-leader-num, 700 30px / 1 var(--font-family-number));
  letter-spacing: 0.14em;
  color: var(--ov-fill, rgba(255, 255, 255, 0.92));
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
  animation: ep-leader-stamp 200ms var(--ease, cubic-bezier(0.2, 0, 0, 1)) 90ms both;
}

@keyframes ep-leader-judder {
  0% {
    opacity: 0;
    transform: translate3d(14px, 0, 0);
  }

  22% {
    opacity: 1;
    transform: translate3d(-10px, 0, 0);
  }

  42% {
    transform: translate3d(5px, 0, 0);
  }

  60% {
    transform: translate3d(-2px, 0, 0);
  }

  78%,
  92% {
    opacity: 1;
    transform: none;
  }

  100% {
    opacity: 0;
    transform: none;
  }
}

@keyframes ep-leader-flash {
  0% {
    opacity: 0.2;
  }

  30%,
  80% {
    opacity: 1;
  }

  100% {
    opacity: 0;
  }
}

@keyframes ep-leader-run {
  from {
    transform: translate3d(0, 6px, 0);
  }

  to {
    transform: translate3d(0, -16px, 0);
  }
}

@keyframes ep-leader-stamp {
  from {
    opacity: 0;
    transform: scale(1.08);
  }

  60% {
    opacity: 1;
    transform: scale(0.99);
  }

  to {
    opacity: 1;
    transform: scale(1);
  }
}

/*
 * 减弱动效下这层压根不该出现（触发端已经拦了）。这里再兜一道：
 * 幕布的"终态"就是没有幕布，所以直接 display:none 才符合"基础态即完成态"的约定。
 */
@media (prefers-reduced-motion: reduce) {
  .ep-leader {
    display: none;
  }
}
</style>
