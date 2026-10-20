<script setup lang="ts">
/**
 * 错误态（设计规范 8.10）
 *
 * 标题取 `error.message`（已在 `shared/errors.ts` 映射为中文），
 * 说明给出"可能原因 + 下一步"，仅 `retryable` 时展示重试。
 */
import { computed } from 'vue';

import type { AppErrorShape } from '@/types';
import { ERROR_MESSAGES } from '@/shared/errors';

const props = withDefaults(
  defineProps<{
    error: AppErrorShape | null;
    /** 覆盖默认说明 */
    hint?: string;
    /** 是否展示重试按钮（默认跟随 error.retryable） */
    showRetry?: boolean;
    /** 返回按钮文案；为空则不渲染 */
    backText?: string;
    title?: string;
  }>(),
  { hint: '', showRetry: undefined, backText: '', title: '' },
);

const emit = defineEmits<{ (e: 'retry'): void; (e: 'back'): void }>();

const message = computed(() => {
  if (props.title) return props.title;
  if (!props.error) return '加载失败';
  return props.error.message || ERROR_MESSAGES[props.error.code];
});

const detail = computed(() => props.error?.detail ?? '');

const canRetry = computed(() => props.showRetry ?? props.error?.retryable ?? true);

/** 常见错误码 → "可能原因 + 下一步动作"（NFR-R01 文案结构） */
const advice = computed(() => {
  if (props.hint) return props.hint;
  switch (props.error?.code) {
    case 'E_NETWORK':
      return '可能原因：网络不可用或源站不可访问。请检查网络连接后重试。';
    case 'E_TIMEOUT':
      return '可能原因：源站响应过慢或网络不稳定。可稍后重试，或更换其他源。';
    case 'E_AUTH':
    case 'E_HTTP_401':
    case 'E_HTTP_403':
      return '可能原因：账号、密码或 Token 失效。请在源管理中检查凭据后重试。';
    case 'E_HTTP_404':
      return '可能原因：源地址或内容已变更。请检查源配置，或更换其他源。';
    case 'E_PARSE':
      return '可能原因：源返回的数据格式已变化。可更新源配置，或更换其他源。';
    case 'E_SOURCE_DISABLED':
    case 'E_SOURCE_UNAVAILABLE':
      return '可能原因：该源被禁用或暂不可用。请在源管理中启用或切换其他源。';
    case 'E_DECODE':
    case 'E_UNSUPPORTED_FORMAT':
      return '可能原因：编码或封装格式不受支持。可尝试切换线路或清晰度。';
    case 'E_STORAGE_QUOTA':
      return '可能原因：设备存储空间不足。请清理空间或删除部分下载后重试。';
    default:
      return '可能原因：数据读取或请求异常。可重试；若持续失败请返回上一页。';
  }
});
</script>

<template>
  <div class="error-state" role="alert" data-state="error">
    <svg
      class="error-state__art"
      viewBox="0 0 96 96"
      fill="none"
      stroke="var(--color-danger)"
      stroke-opacity="0.8"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M48 24 82 74H14Z" />
      <path d="M48 42v14" />
      <circle cx="48" cy="65" r="1.2" fill="var(--color-danger)" stroke="none" />
    </svg>

    <p class="error-state__title">{{ message }}</p>
    <p class="error-state__advice">{{ advice }}</p>
    <p v-if="detail" class="error-state__detail">{{ detail }}</p>

    <div class="error-state__actions">
      <button
        v-if="canRetry"
        class="btn btn--primary btn--md"
        type="button"
        @click="emit('retry')"
      >
        重试
      </button>
      <button
        v-if="backText"
        class="btn btn--ghost btn--md"
        type="button"
        @click="emit('back')"
      >
        {{ backText }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  max-width: 300px;
  margin: 0 auto;
  padding: var(--space-7) var(--space-4);
  text-align: center;
}

.error-state__art {
  width: 96px;
  height: 96px;
  margin-bottom: var(--space-3);
}

.error-state__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.error-state__advice {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.error-state__detail {
  margin-top: var(--space-1);
  max-width: 100%;
  font: var(--text-caption);
  color: var(--color-text-disabled);
  overflow-wrap: anywhere;
}

.error-state__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
</style>
