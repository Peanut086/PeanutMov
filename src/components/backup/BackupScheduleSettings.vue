<script setup lang="ts">
/**
 * 定时备份设置（EXT-05 phase1）
 *
 * 纯展示 + 本地校验：所有改动通过 `change` 事件把"期望的补丁"抛给父级落盘，
 * 组件自身不读写存储（便于单测与页面复用）。
 *
 * 约定：**开启定时**时补丁里带 `lastScheduledAt = now`——把"启用时刻"记作上次执行，
 * 避免用户刚打开开关就立刻补跑一次（补跑口径见 `backupScheduler.isBackupDue`）。
 */
import { computed, ref, watch } from 'vue';

import SegmentedControl from '@/components/common/SegmentedControl.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { formatRelativeTime } from '@/shared/time';
import type { BackupScheduleMode, BackupSettings } from '@/types';

const props = withDefaults(
  defineProps<{
    settings: BackupSettings;
    /** 下次触发文案（父级用 describeNextRun 计算，随 60s tick 刷新） */
    nextRunText: string;
    /** 上次定时备份失败原因（来自 settings.backup.lastError） */
    lastError?: string | null;
    busy?: boolean;
  }>(),
  { lastError: null, busy: false },
);

const emit = defineEmits<{ (e: 'change', patch: Partial<BackupSettings>): void }>();

const enabled = computed(() => props.settings.scheduleMode !== 'off');

const modeOptions = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
];

const weekdayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

const hourOptions = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: `${String(hour).padStart(2, '0')}:00`,
}));

const retentionOptions = Array.from({ length: 20 }, (_, i) => i + 1);

/** 本地输入态（与 props 同步，避免直接改父级数据） */
const hour = ref(props.settings.scheduleHour);
const weekday = ref(props.settings.scheduleWeekday);
const retention = ref(props.settings.retentionCount);

watch(
  () => props.settings,
  (next) => {
    hour.value = next.scheduleHour;
    weekday.value = next.scheduleWeekday;
    retention.value = next.retentionCount;
  },
  { deep: true },
);

const lastRunText = computed(() => {
  const at = props.settings.lastScheduledAt;
  if (typeof at !== 'number' || at <= 0) return '从未执行';
  return `${formatRelativeTime(at)}（${new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}）`;
});

function toggle(next: boolean): void {
  if (props.busy) return;
  emit(
    'change',
    next
      ? { scheduleMode: 'daily', lastScheduledAt: Date.now() }
      : { scheduleMode: 'off' as BackupScheduleMode },
  );
}

function chooseMode(value: string): void {
  if (props.busy) return;
  emit('change', { scheduleMode: value === 'weekly' ? 'weekly' : 'daily' });
}

function chooseHour(ev: Event): void {
  const value = Number((ev.target as HTMLSelectElement).value);
  hour.value = value;
  if (props.busy) return;
  emit('change', { scheduleHour: value });
}

function chooseWeekday(ev: Event): void {
  const value = Number((ev.target as HTMLSelectElement).value);
  weekday.value = value;
  if (props.busy) return;
  emit('change', { scheduleWeekday: value });
}

function chooseRetention(ev: Event): void {
  const value = Number((ev.target as HTMLSelectElement).value);
  retention.value = value;
  if (props.busy) return;
  emit('change', { retentionCount: value });
}
</script>

<template>
  <section class="schedule" aria-label="定时备份设置">
    <div class="schedule__row">
      <div class="schedule__texts">
        <span class="schedule__label">定时备份</span>
        <span class="schedule__hint">
          {{ enabled ? '到点后静默执行，不改动当前操作' : '关闭后仅在手动点击时备份' }}
        </span>
      </div>
      <ToggleSwitch
        :model-value="enabled"
        :disabled="busy"
        label="定时备份"
        @update:model-value="toggle"
      />
    </div>

    <div v-if="enabled" class="schedule__fields">
      <div class="schedule__field">
        <span class="schedule__field-label">频率</span>
        <SegmentedControl
          :model-value="settings.scheduleMode === 'weekly' ? 'weekly' : 'daily'"
          :options="modeOptions"
          label="定时频率"
          @update:model-value="chooseMode"
        />
      </div>

      <div class="schedule__field">
        <span class="schedule__field-label">时间</span>
        <div class="schedule__selects">
          <select
            v-if="settings.scheduleMode === 'weekly'"
            class="schedule__select"
            aria-label="每周几"
            :disabled="busy"
            :value="weekday"
            @change="chooseWeekday"
          >
            <option v-for="opt in weekdayOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <select
            class="schedule__select"
            aria-label="备份时间（小时）"
            :disabled="busy"
            :value="hour"
            @change="chooseHour"
          >
            <option v-for="opt in hourOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>

      <div class="schedule__field">
        <span class="schedule__field-label">保留版本</span>
        <select
          class="schedule__select"
          aria-label="保留备份版本数量"
          :disabled="busy"
          :value="retention"
          @change="chooseRetention"
        >
          <option v-for="n in retentionOptions" :key="n" :value="n">最近 {{ n }} 份</option>
        </select>
      </div>
    </div>

    <dl class="schedule__status">
      <div class="schedule__status-item">
        <dt>上次定时备份</dt>
        <dd>{{ lastRunText }}</dd>
      </div>
      <div class="schedule__status-item">
        <dt>下次定时备份</dt>
        <dd>{{ enabled ? nextRunText : '已关闭' }}</dd>
      </div>
    </dl>

    <p v-if="lastError" class="schedule__error" role="alert">上次定时备份失败：{{ lastError }}</p>
  </section>
</template>

<style scoped>
.schedule {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.schedule__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: calc(var(--touch-min) + var(--space-3));
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.schedule__texts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.schedule__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.schedule__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.schedule__fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.schedule__field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--touch-min);
}

.schedule__field-label {
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
  flex: 0 0 auto;
}

.schedule__selects {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
}

.schedule__select {
  min-height: var(--touch-min);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-label);
}

.schedule__select:focus-visible {
  outline: none;
  border-color: var(--color-brand);
  box-shadow: var(--shadow-focus);
}

.schedule__status {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.schedule__status-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.schedule__status-item dd {
  margin: 0;
  font: var(--text-label);
  color: var(--color-text-secondary);
  text-align: right;
}

.schedule__error {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-label);
  line-height: 1.5;
}
</style>
