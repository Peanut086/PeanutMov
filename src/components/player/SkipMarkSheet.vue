<script setup lang="ts">
/**
 * 片头 / 片尾标记面板（B-06）
 *
 * 数据来源优先级：源站章节数据 > 手动标记。当前源站没有章节载体（TVBox/爬虫返回体里
 * 没有该字段），所以先做手动标记：停在片头最后一帧，点一下「此刻」，整季复用。
 * 标记按剧集存，不按集存——第 3 集标过，第 4 集不用再标一遍。
 */
import { computed } from 'vue';

import type { SkipMarks } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { formatClock } from '@/shared/time';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    marks: SkipMarks | null;
    currentTime: number;
    duration: number;
    autoSkip?: boolean;
  }>(),
  { autoSkip: true },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'mark', side: 'intro' | 'credits', sec: number): void;
  (e: 'clear', side: 'intro' | 'credits'): void;
  (e: 'update:autoSkip', v: boolean): void;
}>();

const introLabel = computed(() => {
  const v = props.marks?.introEndSec;
  return v === null || v === undefined ? '未标记' : formatClock(v);
});
const creditsLabel = computed(() => {
  const v = props.marks?.creditsStartSec;
  return v === null || v === undefined ? '未标记' : formatClock(v);
});

/** 时长未知时不给标：没有分母，标出来的边界毫无意义 */
const canMark = computed(() => props.duration > 0);
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="片头 / 片尾"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="skip-sheet__desc">
      停在片头结束的画面上点「此刻」即可；标记记在整个剧集上，后续各集自动沿用。
    </p>

    <ul class="skip-sheet__list">
      <li class="skip-sheet__row">
        <div class="skip-sheet__info">
          <span class="skip-sheet__name">片头结束于</span>
          <span class="skip-sheet__value">{{ introLabel }}</span>
        </div>
        <div class="skip-sheet__actions">
          <button
            class="btn btn--primary btn--sm"
            type="button"
            :disabled="!canMark"
            @click="emit('mark', 'intro', Math.round(currentTime))"
          >
            此刻
          </button>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="marks?.introEndSec == null"
            @click="emit('clear', 'intro')"
          >
            清除
          </button>
        </div>
      </li>

      <li class="skip-sheet__row">
        <div class="skip-sheet__info">
          <span class="skip-sheet__name">片尾开始于</span>
          <span class="skip-sheet__value">{{ creditsLabel }}</span>
        </div>
        <div class="skip-sheet__actions">
          <button
            class="btn btn--primary btn--sm"
            type="button"
            :disabled="!canMark"
            @click="emit('mark', 'credits', Math.round(currentTime))"
          >
            此刻
          </button>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="marks?.creditsStartSec == null"
            @click="emit('clear', 'credits')"
          >
            清除
          </button>
        </div>
      </li>
    </ul>

    <div class="skip-sheet__switch">
      <ToggleSwitch
        :model-value="autoSkip"
        label="倒计时结束自动跳过"
        @update:model-value="emit('update:autoSkip', $event)"
      />
      <p class="skip-sheet__hint">关闭后只出提示胶囊，点了才跳。</p>
    </div>
  </BottomSheet>
</template>

<style scoped>
.skip-sheet__desc {
  margin-bottom: var(--space-3);
  font: var(--text-caption);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.skip-sheet__list {
  display: flex;
  flex-direction: column;
}

.skip-sheet__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 56px;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-divider);
}

.skip-sheet__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.skip-sheet__name {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.skip-sheet__value {
  font: var(--text-caption);
  font-family: var(--font-family-number);
  color: var(--color-brand-text);
}

.skip-sheet__actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-2);
}

.skip-sheet__switch {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-top: var(--space-4);
}

.skip-sheet__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
