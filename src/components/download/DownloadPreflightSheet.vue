<script setup lang="ts">
/**
 * 下载预检结果（FR-65 / API-19）
 *
 * 只做展示与确认：数据由 `downloadStore.preflight` 给出，本组件不发请求、不改任务。
 * 状态覆盖：加载中 / 失败（可重试）/ 结果（通过 / 阻断 / 仅告警）。
 * 阻断原因固定五类（drm / unsupported-format / storage / wifi-only / unreachable），文案与 AC 对齐。
 */
import { computed } from 'vue';

import type { Episode } from '@/types';
import type {
  PreflightBlockedReason,
  PreflightResult,
} from '@/services/downloadPreflight';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { formatBytes } from '@/components/common/format';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 预检结果；null = 尚未返回 */
    result?: PreflightResult | null;
    /** 预检进行中 */
    loading?: boolean;
    /** 预检异常文案（已脱敏） */
    errorText?: string | null;
    /** 用于把 episodeId 显示成"第 n 集" */
    episodes?: Episode[];
    /** 本次提交的集数（结果未到时展示） */
    requestedCount?: number;
  }>(),
  {
    result: null,
    loading: false,
    errorText: null,
    episodes: () => [],
    requestedCount: 0,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'confirm'): void;
  (e: 'retry'): void;
}>();

const BLOCKED_COPY: Record<PreflightBlockedReason, string> = {
  drm: '受 DRM 保护，无法下载',
  'unsupported-format': '封装格式不支持，无法下载',
  storage: '存储空间不足，请先清理后重试',
  'wifi-only': '当前为移动网络，「仅 Wi-Fi 下载」已开启',
  unreachable: '下载地址暂时无法访问，可稍后重试',
};

const NETWORK_COPY: Record<string, string> = {
  wifi: 'Wi-Fi',
  cellular: '移动网络',
  ethernet: '有线网络',
  none: '无网络',
  unknown: '未知网络',
};

const numberById = computed(() => {
  const map = new Map<string, number>();
  for (const ep of props.episodes) map.set(ep.id, ep.number);
  return map;
});

const items = computed(() => props.result?.items ?? []);

const okCount = computed(() => items.value.filter((item) => item.ok).length);

const summaryText = computed(() => {
  const total = items.value.length || props.requestedCount;
  return `共 ${total} 集，可下载 ${okCount.value} 集`;
});

const blockedText = computed(() => {
  const blocked = props.result?.blocked;
  if (!blocked) return '';
  return blocked.message || BLOCKED_COPY[blocked.reason];
});

/** 仅「移动网络」为可确认放行，其余阻断不可越过 */
const confirmable = computed(() => props.result?.blocked?.reason === 'wifi-only');

const canConfirm = computed(() => {
  if (props.loading || props.errorText) return false;
  if (!props.result) return false;
  return props.result.canStart && okCount.value > 0;
});

const storageText = computed(() => {
  const storage = props.result?.storage;
  if (!storage) return '';
  return `需要约 ${formatBytes(storage.requiredBytes)}，可用 ${formatBytes(storage.freeBytes)}`;
});

const networkText = computed(() => {
  const view = props.result?.network;
  if (!view) return '';
  const label = NETWORK_COPY[view.type] ?? NETWORK_COPY.unknown;
  return view.wifiOnlyBlocked ? `${label} · 仅 Wi-Fi 下载` : label;
});

function episodeLabel(episodeId: string): string {
  const number = numberById.value.get(episodeId);
  return typeof number === 'number' ? `第 ${number} 集` : '未知集数';
}

function itemState(item: (typeof items)['value'][number]): {
  text: string;
  tone: 'ok' | 'warn' | 'danger';
} {
  if (item.drmProtected) return { text: 'DRM 加密', tone: 'danger' };
  if (!item.ok) return { text: '无法下载', tone: 'danger' };
  if (item.probe && !item.probe.segmentOk) return { text: '可下载（分片探测异常）', tone: 'warn' };
  return { text: '可下载', tone: 'ok' };
}

function itemMeta(item: (typeof items)['value'][number]): string {
  const parts: string[] = [];
  if (item.selectedVariant?.label) parts.push(item.selectedVariant.label);
  if (item.estimatedBytes !== null) {
    parts.push(`${item.estimatedBytesApproximate ? '约 ' : ''}${formatBytes(item.estimatedBytes)}`);
  }
  if (item.container) parts.push(item.container.toUpperCase());
  if (item.subtitles.length > 0) {
    const available = item.subtitles.filter((sub) => sub.available).length;
    parts.push(`字幕 ${available}/${item.subtitles.length}`);
  }
  return parts.join(' · ');
}

function itemNotes(item: (typeof items)['value'][number]): string {
  if (item.notes.length === 0) return '';
  return item.notes.join(' / ');
}

function onConfirm(): void {
  if (!canConfirm.value) return;
  emit('confirm');
}

function onClose(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="下载预检"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="loading" class="pf-state">
      <LoadingSpinner :size="24" />
      <span class="pf-state__text">正在检查地址、空间与网络…</span>
    </div>

    <div v-else-if="errorText" class="pf-state">
      <span class="pf-state__text pf-state__text--danger">{{ errorText }}</span>
      <button class="btn btn--secondary btn--sm" type="button" @click="emit('retry')">
        重新预检
      </button>
    </div>

    <template v-else-if="result">
      <div class="pf-summary">
        <span class="pf-summary__title">{{ summaryText }}</span>
        <span v-if="storageText" class="pf-summary__line">{{ storageText }}</span>
        <span v-if="networkText" class="pf-summary__line">网络：{{ networkText }}</span>
      </div>

      <div
        v-if="result.blocked"
        class="pf-blocked"
        :class="{ 'pf-blocked--confirmable': confirmable }"
      >
        <span class="pf-blocked__reason">{{ BLOCKED_COPY[result.blocked.reason] }}</span>
        <span v-if="blockedText && blockedText !== BLOCKED_COPY[result.blocked.reason]" class="pf-blocked__message">
          {{ blockedText }}
        </span>
        <span class="pf-blocked__scope">影响 {{ result.blocked.episodeIds.length }} 集</span>
      </div>

      <ul v-if="items.length > 0" class="pf-list">
        <li v-for="item in items" :key="item.episodeId" class="pf-row">
          <div class="pf-row__main">
            <span class="pf-row__name">{{ episodeLabel(item.episodeId) }}</span>
            <span class="pf-row__meta">{{ itemMeta(item) }}</span>
            <span v-if="itemNotes(item)" class="pf-row__notes">{{ itemNotes(item) }}</span>
          </div>
          <span class="pf-row__state" :class="`pf-row__state--${itemState(item).tone}`">
            {{ itemState(item).text }}
          </span>
        </li>
      </ul>

      <div v-else class="pf-state">
        <span class="pf-state__text">没有可预检的集数</span>
      </div>
    </template>

    <div v-else class="pf-state">
      <span class="pf-state__text">暂无预检结果</span>
    </div>

    <template #footer>
      <div class="pf-actions">
        <button class="btn btn--secondary btn--md pf-actions__btn" type="button" @click="onClose">
          取消
        </button>
        <button
          class="btn btn--primary btn--md pf-actions__btn"
          type="button"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          {{ confirmable ? '仍要下载' : '开始下载' }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.pf-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.pf-state__text {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.pf-state__text--danger {
  color: var(--color-danger);
}

.pf-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-bottom: var(--space-3);
}

.pf-summary__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.pf-summary__line {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.pf-blocked {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  margin-bottom: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  border: 1px solid var(--color-danger-border);
}

.pf-blocked--confirmable {
  background-color: var(--color-warning-soft);
  border-color: transparent;
}

.pf-blocked__reason {
  font: var(--text-label-strong);
  color: var(--color-danger);
}

.pf-blocked--confirmable .pf-blocked__reason {
  color: var(--color-warning);
}

.pf-blocked__message {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.pf-blocked__scope {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.pf-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.pf-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
}

.pf-row__main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.pf-row__name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.pf-row__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.pf-row__notes {
  font: var(--text-caption);
  color: var(--color-warning);
  word-break: break-word;
}

.pf-row__state {
  flex: 0 0 auto;
  font: var(--text-caption);
}

.pf-row__state--ok {
  color: var(--color-success);
}

.pf-row__state--warn {
  color: var(--color-warning);
}

.pf-row__state--danger {
  color: var(--color-danger);
}

.pf-actions {
  display: flex;
  gap: var(--space-3);
}

.pf-actions__btn {
  flex: 1 1 0;
}
</style>
