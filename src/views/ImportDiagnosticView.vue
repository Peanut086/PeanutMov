<script setup lang="ts">
/**
 * 导入诊断（EXT-08）
 *
 * 流程（两步，先只读后写入）：
 * ① 开始诊断 → `importService.prefetchImport`：拉取解析 + 并发 HEAD 探测 jar +
 *    估算下载耗时（不写库），实时显示阶段进度与每个源的状态；
 * ② 确认导入 → `importService.importWithDiagnostic`：复用①的预览与探测结果只写
 *    「有效 && 已勾选」条目，jar 不可达的源不写入，随后做失败分类与存活统计。
 *
 * 数据来源：诊断结果全部来自 service 返回值，页面不重复计算口径；
 * 「清理失败源」复用 EXT-01 的 `sourceStore.cleanupFailedSources`（同一实现，不另写一套）。
 *
 * 稳定性：`alive` 标记避免异步完成后向已卸载页面弹 toast；`abortRef` 在卸载/取消时
 * 中止在途请求，无定时器与全局监听，无资源泄漏。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { AppErrorShape } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import FailureClassification from '@/components/import/FailureClassification.vue';
import ImportSummary from '@/components/import/ImportSummary.vue';

import {
  downloadFailureReport,
  FAILURE_CATEGORY_META,
  formatBytes,
  formatDuration,
  IMPORT_DIAGNOSTIC_STAGES,
  jarUrlOfEntry,
  stageIndexOf,
  type FailureBucket,
  type ImportDiagnosticProgress,
  type ImportDiagnosticStage,
  type ImportFailureItem,
  type JarProbeSummary,
} from '@/services/ImportDiagnosticService';
import {
  importService,
  type ImportDiagnosticPrefetch,
  type ImportDiagnosticResult,
} from '@/services/importService';
import { useSourceStore } from '@/stores/sourceStore';
import { useUiStore } from '@/stores/uiStore';
import { useToast } from '@/composables/useToast';
import { isCanceled, toErrorShape } from '@/shared/errors';
import { isValidHttpUrl } from '@/shared/url';

type Phase = 'idle' | 'prefetching' | 'prefetched' | 'importing' | 'done';

const route = useRoute();
const router = useRouter();
const store = useSourceStore();
const ui = useUiStore();
const toast = useToast();

/** 卸载标记：异步完成后不再触发 toast / 状态写入 */
let alive = true;
/** 在途请求（取消与卸载时中止） */
let abortRef: AbortController | null = null;

const phase = ref<Phase>('idle');
const url = ref('');
const localError = ref<string | null>(null);
const error = ref<AppErrorShape | null>(null);
const progress = ref<ImportDiagnosticProgress | null>(null);
const prefetch = ref<ImportDiagnosticPrefetch | null>(null);
const result = ref<ImportDiagnosticResult | null>(null);
const duplicateStrategy = ref<'skip' | 'overwrite' | 'keep-both'>('skip');
const cleaning = ref(false);

const strategyOptions = [
  { value: 'skip', label: '跳过' },
  { value: 'overwrite', label: '覆盖' },
  { value: 'keep-both', label: '保留两份' },
];

const busy = computed(() => phase.value === 'prefetching' || phase.value === 'importing');
const importing = computed(() => phase.value === 'importing');
const prefetching = computed(() => phase.value === 'prefetching');

/** 当前展示的预览：导入完成后以结果里的预览为准 */
const preview = computed(() => result.value?.preview ?? prefetch.value?.preview ?? null);
const probes = computed<JarProbeSummary[]>(() => result.value?.probes ?? prefetch.value?.probes ?? []);

const cleanupCount = computed(() => store.failedEnabledSources.length);

const buckets = computed<FailureBucket[]>(() => result.value?.report.buckets ?? []);
const failures = computed<ImportFailureItem[]>(() => result.value?.failures ?? []);

const currentStage = computed<ImportDiagnosticStage>(() => {
  if (phase.value === 'done') return 'done';
  const current = progress.value;
  if (current === null || current.stage === 'idle') return 'idle';
  return current.stage;
});

const currentStageIndex = computed(() => stageIndexOf(currentStage.value));

const progressText = computed(() => {
  const current = progress.value;
  if (current === null) return '';
  switch (current.stage) {
    case 'parse':
      return current.done >= current.total ? '订阅解析完成' : '正在拉取并解析订阅…';
    case 'probe':
      return current.total > 0 ? `${current.label} ${current.done}/${current.total}` : '没有需要探测的 jar';
    case 'import':
      return `写入源 ${current.done}/${current.total}`;
    case 'done':
      return '诊断完成';
    default:
      return current.label;
  }
});

/* ---------- 预估与告警 ---------- */

const estimateText = computed(() => {
  const estimate = prefetch.value?.estimate ?? result.value?.estimate ?? null;
  if (estimate === null) return '没有可达的 jar，导入后无需额外下载';
  const parts = [
    `${estimate.jarCount} 个 jar`,
    formatBytes(estimate.bytes),
    `约 ${formatDuration(estimate.seconds)}`,
  ];
  if (estimate.assumedCount > 0) parts.push(`${estimate.assumedCount} 个按默认体积估算`);
  return parts.join(' · ');
});

const warnings = computed(() => prefetch.value?.warnings ?? result.value?.warnings ?? []);

/* ---------- 实时源状态 ---------- */

type RowStatus = 'imported' | 'pending' | 'excluded' | 'invalid' | 'duplicate';

interface EntryRow {
  key: string;
  name: string;
  type: string;
  jarUrl: string | null;
  status: RowStatus;
  statusLabel: string;
  detail: string;
}

const rows = computed<EntryRow[]>(() => {
  const source = preview.value;
  if (source === null) return [];
  const probeByUrl = new Map(probes.value.map((probe) => [probe.jarUrl, probe]));
  const done = result.value !== null;
  const duplicateKeys = new Set(
    (result.value?.failures ?? []).filter((item) => item.reason === 'duplicate').map((item) => item.key),
  );

  return source.entries.map((entry) => {
    const jarUrl = jarUrlOfEntry(entry);
    const probe = jarUrl === null ? null : (probeByUrl.get(jarUrl) ?? null);
    const name = entry.name.length > 0 ? entry.name : entry.key;
    const key = entry.normalized?.key ?? entry.key;

    if (!entry.valid || entry.normalized === null) {
      return {
        key,
        name,
        type: entry.type,
        jarUrl,
        status: 'invalid' as const,
        statusLabel: '配置无效',
        detail: entry.issues.find((issue) => issue.message.length > 0)?.message ?? '缺少必填字段',
      };
    }
    if (probe !== null && probe.verdict === 'dead') {
      return {
        key,
        name,
        type: entry.type,
        jarUrl,
        status: 'excluded' as const,
        statusLabel: 'jar 不可达',
        detail: probe.detail ?? (probe.httpStatus !== null ? `HTTP ${probe.httpStatus}` : 'HEAD 请求失败'),
      };
    }
    if (done && duplicateKeys.has(key)) {
      return {
        key,
        name,
        type: entry.type,
        jarUrl,
        status: 'duplicate' as const,
        statusLabel: '重复跳过',
        detail: FAILURE_CATEGORY_META.duplicate.hint,
      };
    }
    if (done) {
      return {
        key,
        name,
        type: entry.type,
        jarUrl,
        status: 'imported' as const,
        statusLabel: '已写入',
        detail: probe === null ? '无 jar 依赖' : `jar 可达${probe.httpStatus !== null ? `（HTTP ${probe.httpStatus}）` : ''}`,
      };
    }
    if (!entry.selected) {
      return {
        key,
        name,
        type: entry.type,
        jarUrl,
        status: 'excluded' as const,
        statusLabel: '未勾选',
        detail: '本次不会写入该源',
      };
    }
    return {
      key,
      name,
      type: entry.type,
      jarUrl,
      status: 'pending' as const,
      statusLabel: '待写入',
      detail: probe === null ? '无 jar 依赖' : `jar 可达${probe.httpStatus !== null ? `（HTTP ${probe.httpStatus}）` : ''}`,
    };
  });
});

const willImportCount = computed(
  () =>
    preview.value?.entries.filter(
      (entry) => entry.valid && entry.normalized !== null && entry.selected,
    ).length ?? 0,
);

const excludedCount = computed(() => {
  const seen = new Set<string>();
  let count = 0;
  for (const probe of probes.value) {
    if (probe.verdict === 'dead' && !seen.has(probe.jarUrl)) {
      seen.add(probe.jarUrl);
      count += 1;
    }
  }
  return count;
});

const confirmText = computed(() => {
  const total = preview.value?.total ?? 0;
  const parts = [`订阅共 ${total} 个条目`];
  if (excludedCount.value > 0) parts.push(`${excludedCount.value} 个 jar 不可达已排除`);
  return parts.join(' · ');
});

const canImport = computed(
  () => phase.value === 'prefetched' && willImportCount.value > 0 && !busy.value,
);

/* ---------- 交互 ---------- */

function handleProgress(next: ImportDiagnosticProgress): void {
  if (!alive) return;
  progress.value = next;
}

async function onStart(): Promise<void> {
  if (busy.value) return;
  const trimmed = url.value.trim();
  if (trimmed.length === 0) {
    localError.value = '请输入订阅地址';
    return;
  }
  if (!isValidHttpUrl(trimmed)) {
    localError.value = '订阅地址必须是 http(s):// 开头的合法地址';
    return;
  }

  localError.value = null;
  error.value = null;
  result.value = null;
  prefetch.value = null;
  progress.value = null;
  phase.value = 'prefetching';

  const controller = new AbortController();
  abortRef = controller;
  try {
    const next = await importService.prefetchImport(trimmed, {
      signal: controller.signal,
      onProgress: handleProgress,
    });
    if (!alive) return;
    prefetch.value = next;
    phase.value = 'prefetched';
    if (next.preview.entries.length === 0) toast.info('订阅里没有可导入的源');
    for (const warning of next.warnings) toast.info(warning);
  } catch (e) {
    if (!alive) return;
    if (isCanceled(e)) {
      phase.value = 'idle';
      toast.info('已取消诊断');
      return;
    }
    error.value = toErrorShape(e);
    phase.value = 'idle';
  } finally {
    if (abortRef === controller) abortRef = null;
  }
}

async function onImport(): Promise<void> {
  const current = prefetch.value;
  if (current === null || busy.value) return;

  phase.value = 'importing';
  error.value = null;
  const controller = new AbortController();
  abortRef = controller;
  try {
    const next = await importService.importWithDiagnostic(current.subscriptionUrl, {
      signal: controller.signal,
      preview: current.preview,
      probes: current.probes,
      onDuplicate: duplicateStrategy.value,
      onProgress: handleProgress,
    });
    if (!alive) return;
    result.value = next;
    phase.value = 'done';
    if (next.status === 'canceled') {
      toast.info(`已取消导入，${next.pending} 个条目未处理`);
    } else {
      const success = next.import?.success ?? 0;
      const failedPart = next.failures.length > 0 ? `，${next.failures.length} 条失败` : '';
      toast.success(`导入完成：写入 ${success} 个源${failedPart}`);
    }
    void store.loadHealthCenter();
  } catch (e) {
    if (!alive) return;
    if (isCanceled(e)) {
      phase.value = 'prefetched';
      toast.info('已取消导入');
      return;
    }
    error.value = toErrorShape(e);
    phase.value = 'prefetched';
  } finally {
    if (abortRef === controller) abortRef = null;
  }
}

function onCancel(): void {
  if (abortRef === null) return;
  abortRef.abort();
  abortRef = null;
}

function onExport(): void {
  const report = result.value?.report;
  if (!report) {
    toast.info('暂无可导出的报告');
    return;
  }
  const ok = downloadFailureReport(report);
  if (ok) toast.success('失败报告已导出');
  else toast.error('导出失败，请检查浏览器下载权限');
}

async function onCleanup(): Promise<void> {
  if (cleaning.value) return;
  const targets = store.failedEnabledSources;
  if (targets.length === 0) {
    toast.info('没有需要清理的失败源');
    return;
  }
  const names = targets
    .slice(0, 3)
    .map((source) => `「${source.name}」`)
    .join('、');
  const confirmed = await ui.confirm({
    title: `清理 ${targets.length} 个失败源？`,
    message: `将把这些源标记为「已禁用」（保留配置，可随时恢复）：${names}${
      targets.length > 3 ? ' 等' : ''
    }。`,
    confirmText: '清理',
    danger: true,
  });
  if (!confirmed || !alive) return;

  cleaning.value = true;
  try {
    const cleaned = await store.cleanupFailedSources();
    if (!alive) return;
    if (cleaned.done === 0 && cleaned.failed === 0) {
      toast.info('没有需要清理的失败源');
      return;
    }
    const failedPart = cleaned.failed > 0 ? `，${cleaned.failed} 个失败` : '';
    toast.success(`已禁用 ${cleaned.done} 个失败源${failedPart}`);
    void store.loadHealthCenter();
  } catch (e) {
    if (alive) toast.error(toErrorShape(e).message);
  } finally {
    cleaning.value = false;
  }
}

function goBack(): void {
  const h = globalThis.history;
  if (typeof h?.length === 'number' && h.length > 1) router.back();
  else void router.replace({ name: 'settings' });
}

function stageState(stage: ImportDiagnosticStage): 'done' | 'active' | 'todo' {
  const index = stageIndexOf(stage);
  if (currentStageIndex.value < 0) return 'todo';
  if (index < currentStageIndex.value) return 'done';
  if (index === currentStageIndex.value) return busy.value || phase.value === 'prefetched' ? 'active' : 'done';
  return 'todo';
}

onMounted(() => {
  const queryUrl = route.query.url;
  if (typeof queryUrl === 'string' && queryUrl.trim().length > 0) url.value = queryUrl.trim();
  void store.loadHealthCenter();
});

onUnmounted(() => {
  alive = false;
  if (abortRef !== null) {
    abortRef.abort();
    abortRef = null;
  }
});
</script>

<template>
  <div class="diagnostic">
    <AppHeader title="导入诊断" back @back="goBack" />

    <div class="diagnostic__body">
      <section class="diagnostic__form" aria-label="订阅地址">
        <label class="field">
          <span class="field__label">订阅地址</span>
          <input
            v-model="url"
            class="field__input"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://example.com/tvbox.json"
            :disabled="busy"
            @keyup.enter="onStart"
          />
        </label>

        <div v-if="!busy" class="diagnostic__strategy">
          <span class="diagnostic__strategy-label">同名源</span>
          <SegmentedControl
            v-model="duplicateStrategy"
            :options="strategyOptions"
            label="同名源处理策略"
          />
        </div>

        <p v-if="localError" class="diagnostic__error" role="alert">{{ localError }}</p>

        <div class="diagnostic__actions">
          <template v-if="phase === 'prefetched'">
            <button
              class="btn btn--primary btn--md diagnostic__primary"
              type="button"
              :disabled="!canImport"
              @click="onImport"
            >
              {{ willImportCount > 0 ? `开始导入（${willImportCount} 个源）` : '没有可导入的源' }}
            </button>
            <button class="btn btn--ghost btn--md" type="button" @click="onStart">重新诊断</button>
          </template>
          <button
            v-else
            class="btn btn--primary btn--md btn--block"
            type="button"
            :disabled="busy"
            @click="onStart"
          >
            <template v-if="prefetching">诊断中…</template>
            <template v-else-if="phase === 'done'">重新诊断</template>
            <template v-else>开始诊断</template>
          </button>
          <button
            v-if="busy"
            class="btn btn--ghost btn--md diagnostic__cancel"
            type="button"
            @click="onCancel"
          >
            取消
          </button>
        </div>
      </section>

      <ol class="diagnostic__stages" aria-label="诊断阶段">
        <li
          v-for="(item, index) in IMPORT_DIAGNOSTIC_STAGES"
          :key="item.stage"
          class="diagnostic__stage"
          :class="`diagnostic__stage--${stageState(item.stage)}`"
          :data-stage="item.stage"
        >
          <span class="diagnostic__stage-index">
            <LoadingSpinner
              v-if="stageState(item.stage) === 'active' && busy"
              :size="12"
            />
            <template v-else>{{ stageState(item.stage) === 'done' ? '✓' : index + 1 }}</template>
          </span>
          <span class="diagnostic__stage-label">{{ item.label }}</span>
        </li>
      </ol>

      <p v-if="progressText" class="diagnostic__progress" data-state="progress">{{ progressText }}</p>

      <ErrorState
        v-if="error"
        :error="error"
        :show-retry="true"
        hint="可能原因：订阅地址不可访问、内容不是订阅 JSON，或网络中断。修正后可重新诊断。"
        @retry="onStart"
      />

      <template v-else>
        <section v-if="preview" class="diagnostic__estimate" aria-label="下载耗时估算">
          <div class="diagnostic__estimate-head">
            <span class="diagnostic__estimate-title">预计导入耗时</span>
            <span class="diagnostic__estimate-value">{{ estimateText }}</span>
          </div>
          <p v-for="(warning, index) in warnings" :key="index" class="diagnostic__warning">
            {{ warning }}
          </p>
        </section>

        <section v-if="preview && preview.entries.length > 0" class="diagnostic__sources" aria-label="源状态">
          <div class="diagnostic__sources-head">
            <h2 class="section-title">源状态</h2>
            <span class="diagnostic__sources-meta">{{ confirmText }}</span>
          </div>
          <ul class="diagnostic__list">
            <li v-for="row in rows" :key="row.key" class="diagnostic__row">
              <div class="diagnostic__row-main">
                <span class="diagnostic__row-name truncate-1">{{ row.name }}</span>
                <span class="diagnostic__tag" :class="`diagnostic__tag--${row.status}`">
                  {{ row.statusLabel }}
                </span>
              </div>
              <p class="diagnostic__row-detail truncate-1">{{ row.type }} · {{ row.detail }}</p>
            </li>
          </ul>
        </section>

        <EmptyState
          v-else-if="preview"
          variant="source"
          title="订阅里没有可导入的源"
          description="该地址返回的内容不是可识别的订阅（可能是网页地址、直播列表或已失效的配置）。"
          action-text="换个地址再诊断"
          @action="onStart"
        />

        <ImportSummary
          :result="result"
          :loading="importing"
          :cleanup-count="cleanupCount"
          :cleaning="cleaning"
          @export="onExport"
          @cleanup="onCleanup"
        />

        <FailureClassification
          v-if="importing || result"
          :buckets="buckets"
          :failures="failures"
          :loading="importing"
          @export="onExport"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.diagnostic {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background-color: var(--color-bg-base);
}

.diagnostic__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: 0 var(--layout-page-padding-x) var(--space-8);
}

.diagnostic__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.diagnostic__strategy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.diagnostic__strategy-label {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.diagnostic__error {
  font: var(--text-caption);
  color: var(--color-danger);
}

.diagnostic__actions {
  display: flex;
  gap: var(--space-2);
}

.diagnostic__cancel {
  flex: 0 0 auto;
}

.diagnostic__primary {
  flex: 1 1 auto;
}

.diagnostic__stages {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.diagnostic__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.diagnostic__stage-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-5);
  height: var(--space-5);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-pressed);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.diagnostic__stage-label {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: center;
}

.diagnostic__stage--active {
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
}

.diagnostic__stage--active .diagnostic__stage-index {
  background-color: var(--color-brand);
  color: var(--color-text-on-brand);
}

.diagnostic__stage--active .diagnostic__stage-label {
  color: var(--color-brand-text);
}

.diagnostic__stage--done .diagnostic__stage-index {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.diagnostic__stage--done .diagnostic__stage-label {
  color: var(--color-text-secondary);
}

.diagnostic__progress {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.diagnostic__estimate {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-elevated);
}

.diagnostic__estimate-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.diagnostic__estimate-title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.diagnostic__estimate-value {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  text-align: right;
}

.diagnostic__warning {
  font: var(--text-caption);
  line-height: 1.6;
  color: var(--color-warning);
}

.diagnostic__sources {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.diagnostic__sources-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.diagnostic__sources-meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.diagnostic__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.diagnostic__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.diagnostic__row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.diagnostic__row-name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.diagnostic__row-detail {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.diagnostic__tag {
  flex: 0 0 auto;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font: var(--text-caption);
  line-height: var(--line-height-16);
  color: var(--color-text-secondary);
  background-color: var(--color-bg-pressed);
}

.diagnostic__tag--imported {
  color: var(--color-success);
  background-color: var(--color-success-soft);
}

.diagnostic__tag--pending {
  color: var(--color-brand-text);
  background-color: var(--color-brand-soft);
}

.diagnostic__tag--excluded,
.diagnostic__tag--duplicate {
  color: var(--color-text-secondary);
  background-color: var(--color-bg-pressed);
}

.diagnostic__tag--invalid {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}
</style>
