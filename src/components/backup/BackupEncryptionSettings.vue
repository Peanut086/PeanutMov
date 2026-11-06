<script setup lang="ts">
/**
 * 加密备份设置（EXT-05 phase1）
 *
 * 安全口径（与 `backupEncryption` / `backupService` 一致）：
 * - 密码只在本组件的输入框与 `enable` / `change-password` 事件的瞬时参数里存在，
 *   组件不缓存、父级也不落盘；
 * - 落盘的是 PBKDF2 salt + 校验块，以及"本机派生密钥"（供无人值守的定时备份）；
 * - 恢复加密备份必须重新输入密码（密钥不随文件分发）。
 */
import { computed, ref } from 'vue';

import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { MIN_PASSWORD_LENGTH, validatePassword } from '@/services/backupEncryption';
import type { BackupSettings } from '@/types';

const props = withDefaults(
  defineProps<{
    settings: BackupSettings;
    /** 本机是否已缓存派生密钥（决定"加密定时备份"能否无人值守） */
    keyReady: boolean;
    busy?: boolean;
  }>(),
  { busy: false },
);

const emit = defineEmits<{
  (e: 'enable', password: string): void;
  (e: 'change-password', password: string): void;
  (e: 'disable'): void;
}>();

const formMode = ref<'idle' | 'enable' | 'change'>('idle');
const password = ref('');
const confirmPassword = ref('');
const error = ref<string | null>(null);

const enabled = computed(() => props.settings.encryptionEnabled);
const formTitle = computed(() => (formMode.value === 'change' ? '修改加密密码' : '设置加密密码'));

function resetForm(): void {
  formMode.value = 'idle';
  password.value = '';
  confirmPassword.value = '';
  error.value = null;
}

function onToggle(next: boolean): void {
  if (props.busy) return;
  if (!next) {
    emit('disable');
    return;
  }
  error.value = null;
  password.value = '';
  confirmPassword.value = '';
  formMode.value = 'enable';
}

function openChangeForm(): void {
  error.value = null;
  password.value = '';
  confirmPassword.value = '';
  formMode.value = 'change';
}

function submit(): void {
  if (props.busy) return;
  error.value = null;
  try {
    validatePassword(password.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
    return;
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致';
    return;
  }
  const value = password.value;
  // 立即清空输入框，避免密码在 DOM/内存里停留
  const mode = formMode.value === 'change' ? 'change' : 'enable';
  resetForm();
  if (mode === 'change') emit('change-password', value);
  else emit('enable', value);
}
</script>

<template>
  <section class="encrypt" aria-label="加密备份设置">
    <div class="encrypt__row">
      <div class="encrypt__texts">
        <span class="encrypt__label">加密备份</span>
        <span class="encrypt__hint">AES-256-GCM，加密后文件扩展名为 .enc</span>
      </div>
      <ToggleSwitch
        :model-value="enabled"
        :disabled="busy"
        label="加密备份"
        @update:model-value="onToggle"
      />
    </div>

    <!-- 未启用：展开设置密码表单 -->
    <form v-if="!enabled && formMode === 'enable'" class="encrypt__form" @submit.prevent="submit">
      <h3 class="encrypt__form-title">{{ formTitle }}</h3>
      <label class="encrypt__field">
        <span class="encrypt__field-label">密码</span>
        <input
          v-model="password"
          class="encrypt__input"
          type="password"
          autocomplete="new-password"
          :placeholder="`至少 ${MIN_PASSWORD_LENGTH} 位`"
        />
      </label>
      <label class="encrypt__field">
        <span class="encrypt__field-label">确认密码</span>
        <input
          v-model="confirmPassword"
          class="encrypt__input"
          type="password"
          autocomplete="new-password"
          placeholder="再次输入"
        />
      </label>
      <p v-if="error" class="encrypt__error" role="alert">{{ error }}</p>
      <p class="encrypt__note">密码不会被保存；忘记密码将无法恢复已加密的备份。</p>
      <div class="encrypt__actions">
        <button class="btn btn--ghost btn--md" type="button" :disabled="busy" @click="resetForm">取消</button>
        <button class="btn btn--primary btn--md" type="submit" :disabled="busy">
          <LoadingSpinner v-if="busy" :size="14" />
          {{ busy ? '处理中…' : '启用加密' }}
        </button>
      </div>
    </form>

    <!-- 已启用：状态 + 修改/关闭 -->
    <div v-else-if="enabled" class="encrypt__status">
      <div class="encrypt__status-line">
        <span class="encrypt__badge encrypt__badge--on">已启用</span>
        <span class="encrypt__status-text">
          {{ keyReady ? '本机密钥已就绪，定时备份可直接加密' : '本机密钥未就绪，定时备份前需重新设置密码' }}
        </span>
      </div>

      <form v-if="formMode === 'change'" class="encrypt__form" @submit.prevent="submit">
        <h3 class="encrypt__form-title">{{ formTitle }}</h3>
        <label class="encrypt__field">
          <span class="encrypt__field-label">新密码</span>
          <input
            v-model="password"
            class="encrypt__input"
            type="password"
            autocomplete="new-password"
            :placeholder="`至少 ${MIN_PASSWORD_LENGTH} 位`"
          />
        </label>
        <label class="encrypt__field">
          <span class="encrypt__field-label">确认新密码</span>
          <input
            v-model="confirmPassword"
            class="encrypt__input"
            type="password"
            autocomplete="new-password"
            placeholder="再次输入"
          />
        </label>
        <p v-if="error" class="encrypt__error" role="alert">{{ error }}</p>
        <p class="encrypt__note">修改后：新备份用新密码，旧 .enc 备份仍用旧密码恢复。</p>
        <div class="encrypt__actions">
          <button class="btn btn--ghost btn--md" type="button" :disabled="busy" @click="resetForm">取消</button>
          <button class="btn btn--primary btn--md" type="submit" :disabled="busy">
            {{ busy ? '处理中…' : '保存新密码' }}
          </button>
        </div>
      </form>

      <div v-else class="encrypt__actions">
        <button class="btn btn--secondary btn--md" type="button" :disabled="busy" @click="openChangeForm">
          修改密码
        </button>
        <button class="btn btn--ghost btn--md encrypt__disable" type="button" :disabled="busy" @click="emit('disable')">
          关闭加密
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.encrypt {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.encrypt__row {
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

.encrypt__texts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.encrypt__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.encrypt__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.encrypt__form,
.encrypt__status {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.encrypt__form-title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.encrypt__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.encrypt__field-label {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.encrypt__input {
  width: 100%;
  min-height: var(--touch-min);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-label);
}

.encrypt__input:focus-visible {
  outline: none;
  border-color: var(--color-brand);
  box-shadow: var(--shadow-focus);
}

.encrypt__error {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-caption);
}

.encrypt__note {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.5;
}

.encrypt__actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.encrypt__disable {
  color: var(--color-danger);
}

.encrypt__status-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.encrypt__badge {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font: var(--text-caption);
}

.encrypt__badge--on {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.encrypt__status-text {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}
</style>
