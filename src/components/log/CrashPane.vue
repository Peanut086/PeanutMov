<script setup lang="ts">
/**
 * 崩溃事件中心（日志页「崩溃」tab）
 *
 * 数据源：Spider.getCrashEvents——xCrash tombstones、java-crash 环形栈、
 * ApplicationExitInfo 三路合并去重。卡片点开抽屉看全文，可单事件取证分享
 * （全文 + 崩溃时刻 ±5 分钟日志上下文合成一个文件）。
 */
import { onMounted, ref } from 'vue';

import { logApi, type CrashEvent, type CrashEventDetail } from '@/native/logs';
import { formatLocalTs } from '@/shared/logLine';
import { toErrorShape } from '@/shared/errors';
import { useToast } from '@/composables/useToast';
import { Share } from '@capacitor/share';

import BottomSheet from '@/components/common/BottomSheet.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const toast = useToast();

const loading = ref(true);
const events = ref<CrashEvent[]>([]);
const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref<CrashEventDetail | null>(null);
const sharing = ref(false);

const KIND_LABEL: Record<string, string> = {
  native: '原生崩溃',
  java: 'Java 崩溃',
  anr: 'ANR',
  killed: '被系统终止',
  lomem: '低内存',
  exit: '退出记录',
};

onMounted(refresh);

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    events.value = await logApi.getCrashEvents();
  } finally {
    loading.value = false;
  }
}

async function openDetail(e: CrashEvent): Promise<void> {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  detail.value = await logApi.getCrashDetail(e.id);
  detailLoading.value = false;
}

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? '退出记录';
}

function kindClass(kind: string): string {
  if (kind === 'native' || kind === 'java') return 'crash-card__kind--danger';
  if (kind === 'anr' || kind === 'lomem') return 'crash-card__kind--warn';
  return 'crash-card__kind--muted';
}

function copyDetail(): void {
  if (!detail.value) return;
  navigator.clipboard.writeText(detail.value.text).then(
    () => toast.success('已复制到剪贴板'),
    () => toast.error('复制失败'),
  );
}

async function shareEvent(): Promise<void> {
  if (!detail.value || sharing.value) return;
  sharing.value = true;
  try {
    const result = await logApi.exportCrashEvent(detail.value.id, 5);
    await Share.share({
      title: 'PeanutMov 崩溃取证',
      // Share 插件只接受 file:// 或 http url，content:// 会被拒（Unsupported url）
      url: 'file://' + result.path,
      dialogTitle: '分享崩溃记录',
    });
  } catch (e) {
    const err = toErrorShape(e);
    if (err.message?.includes('cancel') || err.message?.includes('dismiss')) return;
    toast.error('导出失败：' + err.message);
  } finally {
    sharing.value = false;
  }
}
</script>

<template>
  <div class="crash-pane">
    <div v-if="loading" class="crash-pane__loading">
      <LoadingSpinner :size="24" />
      <span>加载中…</span>
    </div>

    <EmptyState
      v-else-if="events.length === 0"
      icon="✅"
      title="暂无崩溃记录"
      description="近 7 天内系统未记录到崩溃或异常退出"
    />

    <template v-else>
      <div class="crash-pane__notice">
        检测到 {{ events.length }} 条崩溃/退出记录，日志保留 7 天，如需反馈请尽快分享
      </div>

      <div class="crash-pane__list">
        <button
          v-for="e in events"
          :key="e.id"
          class="crash-card"
          type="button"
          @click="openDetail(e)"
        >
          <div class="crash-card__head">
            <span class="crash-card__kind" :class="kindClass(e.kind)">{{ kindLabel(e.kind) }}</span>
            <span class="crash-card__time">{{ formatLocalTs(e.ts) }}</span>
          </div>
          <div class="crash-card__title clamp-2">{{ e.title }}</div>
          <div class="crash-card__source truncate-1">{{ e.source }}</div>
        </button>
      </div>
    </template>

    <!-- 事件详情 -->
    <BottomSheet v-model="detailOpen" title="崩溃详情">
      <div class="crash-detail">
        <template v-if="detail">
          <div class="crash-detail__meta">
            <span class="crash-card__kind" :class="kindClass(detail.kind)">
              {{ kindLabel(detail.kind) }}
            </span>
            <span class="crash-detail__time">{{ formatLocalTs(detail.ts) }}</span>
          </div>
          <pre class="crash-detail__text">{{ detail.text || detail.title }}</pre>
          <div class="crash-detail__actions">
            <button class="crash-detail__btn" @click="copyDetail">复制全文</button>
            <button
              class="crash-detail__btn crash-detail__btn--primary"
              :disabled="sharing"
              @click="shareEvent"
            >
              {{ sharing ? '打包中…' : '分享此崩溃' }}
            </button>
          </div>
        </template>
        <div v-else-if="detailLoading" class="crash-pane__loading">
          <LoadingSpinner :size="20" />
        </div>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.crash-pane {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.crash-pane__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-8);
  color: var(--color-text-secondary);
}

.crash-pane__notice {
  padding: var(--space-2) var(--space-4);
  font: var(--font-weight-medium) 12px / 1.5 var(--font-family-base);
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border-bottom: 1px solid var(--color-divider);
}

.crash-pane__list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.crash-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
}

.crash-card:active {
  background: var(--color-overlay-press);
}

.crash-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.crash-card__kind {
  flex: 0 0 auto;
  padding: 1px var(--space-2);
  font: var(--font-weight-medium) 11px / 1.6 var(--font-family-base);
  border-radius: var(--radius-sm);
}

.crash-card__kind--danger {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.crash-card__kind--warn {
  color: var(--color-warning);
  background: var(--color-warning-soft);
}

.crash-card__kind--muted {
  color: var(--color-text-secondary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
}

.crash-card__time {
  flex: 0 0 auto;
  font: var(--font-weight-regular) 11px / 1.6 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.crash-card__title {
  font: var(--font-weight-regular) 13px / 1.45 var(--font-family-base);
  color: var(--color-text-primary);
  word-break: break-all;
}

.crash-card__source {
  font: var(--font-weight-regular) 11px / 1.4 var(--font-family-base);
  color: var(--color-text-tertiary);
}

.crash-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.crash-detail__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.crash-detail__time {
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-number);
  color: var(--color-text-secondary);
}

.crash-detail__text {
  max-height: 45vh;
  overflow-y: auto;
  margin: 0;
  padding: var(--space-2);
  font: var(--font-weight-regular) 11px / 1.5 var(--font-family-mono);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  word-break: break-all;
}

.crash-detail__actions {
  display: flex;
  gap: var(--space-2);
}

.crash-detail__btn {
  flex: 1 1 auto;
  padding: var(--space-2);
  font: var(--font-weight-medium) 13px / 1.4 var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.crash-detail__btn--primary {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.crash-detail__btn:disabled {
  opacity: 0.6;
}
</style>
