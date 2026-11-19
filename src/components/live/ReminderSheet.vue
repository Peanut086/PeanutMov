<script setup lang="ts">
/**
 * EXT-06/FR-70：节目提醒设置弹层
 *
 * - 提前量选项**直接复用** `REMINDER_LEAD_OPTIONS`（0/5/10/15/30），
 *   与服务层 `normalizeLead` 的允许集合保持单一事实来源（REV-20）
 * - 0 分钟 = 节目开播时刻提醒（`notifyAt = startAt`）
 * - 已设置时显示当前提前量与"取消提醒"
 * - 投递说明（P2-2）：显示当前/上次排期的真实档位（可准时 / 可能被延迟 / 仅 App 内），
 *   并按缺的那个开关给出系统设置入口；入口打不开时说明原因，不假装成功
 * - 空态：节目已开始 → 不可设置（按钮 disabled + 说明）
 */
import { computed } from 'vue';

import { REMINDER_LEAD_OPTIONS } from '@/shared/constants';
import type { ReminderSettingsTarget } from '@/native/notificationScheduler';
import type { Reminder, ReminderLead } from '@/types';
import type { ReminderDeliveryView } from '@/services/reminderService';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const props = defineProps<{
  modelValue: boolean;
  /** 节目标题（弹层说明用） */
  title: string;
  /** 节目开始时刻（ms） */
  startAt: number;
  /** 当前已有提醒（null = 未设置） */
  reminder: Reminder | null;
  /** 提交中 */
  saving: boolean;
  /** 上次设置的服务端提示（权限降级等） */
  notice: string | null;
  /** 投递档位说明（null = 还不知道，此时不显示这一行） */
  deliveryView: ReminderDeliveryView | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'confirm', leadMinutes: ReminderLead): void;
  (e: 'cancel-reminder'): void;
  /** 打开对应系统设置页（模板只在有缺口时渲染入口，这里仍允许 null 以免类型断言） */
  (e: 'open-settings', target: ReminderSettingsTarget | null): void;
}>();

/** 与服务层同源：0/5/10/15/30（不再本地硬编码子集） */
const LEAD_OPTIONS: readonly ReminderLead[] = REMINDER_LEAD_OPTIONS;

const DEFAULT_LEAD: ReminderLead = 5;

const started = computed(() => props.startAt <= Date.now());

const currentLead = computed<ReminderLead>(() => {
  const lead = props.reminder?.leadMinutes ?? DEFAULT_LEAD;
  return LEAD_OPTIONS.includes(lead) ? lead : DEFAULT_LEAD;
});

function leadLabel(lead: ReminderLead): string {
  return lead === 0 ? '开播时' : `${lead} 分钟`;
}

const startLabel = computed(() => {
  if (!Number.isFinite(props.startAt)) return '';
  const date = new Date(props.startAt);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
});
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="节目提醒"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="reminder">
      <p class="reminder__programme truncate-1">{{ title || '未命名节目' }}</p>
      <p v-if="startLabel" class="reminder__time">{{ startLabel }} 开播</p>

      <p v-if="notice" class="reminder__notice" role="status">{{ notice }}</p>

      <p v-if="started" class="reminder__blocked">节目已开始，无法设置提醒</p>

      <template v-else>
        <p class="reminder__label">提前提醒</p>
        <div class="reminder__leads" role="radiogroup" aria-label="提前量">
          <button
            v-for="lead in LEAD_OPTIONS"
            :key="lead"
            class="reminder__lead"
            :class="{ 'reminder__lead--active': lead === currentLead }"
            type="button"
            role="radio"
            :aria-checked="lead === currentLead"
            @click="emit('confirm', lead)"
          >
            {{ leadLabel(lead) }}
          </button>
        </div>

        <div class="reminder__actions">
          <button
            class="btn btn--primary btn--md reminder__btn"
            type="button"
            :disabled="saving"
            @click="emit('confirm', currentLead)"
          >
            <LoadingSpinner v-if="saving" :size="16" />
            {{ saving ? '正在设置…' : reminder ? '更新提醒' : '设置提醒' }}
          </button>
          <button
            v-if="reminder"
            class="btn btn--secondary btn--md reminder__btn reminder__btn--danger"
            type="button"
            :disabled="saving"
            @click="emit('cancel-reminder')"
          >
            取消提醒
          </button>
        </div>

        <p v-if="!deliveryView" class="reminder__hint">
          提醒会在设定时间由系统通知；投递受限时，下面会说明原因。
        </p>
      </template>

      <!-- P2-2：投递档位如实披露 + 按缺口给系统设置入口（Web / 老包读不到就不显示） -->
      <div v-if="deliveryView" class="reminder__delivery">
        <p
          class="reminder__delivery-text"
          :class="`reminder__delivery-text--${deliveryView.tier}`"
          data-test="reminder-delivery"
        >
          {{ deliveryView.text }}
        </p>
        <button
          v-if="deliveryView.settingsLabel"
          class="btn btn--secondary btn--sm reminder__settings"
          type="button"
          data-test="reminder-settings"
          @click="emit('open-settings', deliveryView.settingsTarget)"
        >
          {{ deliveryView.settingsLabel }}
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.reminder {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.reminder__programme {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.reminder__time {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.reminder__notice {
  margin-top: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-warning-soft);
  font: var(--text-caption);
  color: var(--color-text-primary);
}

.reminder__blocked {
  margin-top: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-base);
  font: var(--text-label);
  color: var(--color-text-tertiary);
  text-align: center;
}

.reminder__label {
  margin-top: var(--space-3);
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.reminder__leads {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-2);
}

.reminder__lead {
  min-height: 40px;
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-secondary);
  font: var(--text-caption);
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.reminder__lead:active {
  background-color: var(--color-bg-pressed);
}

.reminder__lead--active {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  color: var(--color-brand-text);
  font: var(--text-label-strong);
}

.reminder__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.reminder__btn {
  width: 100%;
  min-height: 44px;
}

.reminder__btn--danger {
  color: var(--color-danger);
}

.reminder__hint {
  margin-top: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

/* P2-2：投递档位说明（退化和受阻才需要颜色强调） */
.reminder__delivery {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.reminder__delivery-text {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.reminder__delivery-text--exact {
  color: var(--color-success);
}

.reminder__delivery-text--delayed {
  color: var(--color-warning);
}

.reminder__delivery-text--in-app {
  color: var(--color-danger);
}

.reminder__settings {
  align-self: flex-start;
}
</style>
