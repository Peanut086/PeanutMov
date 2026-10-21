<script setup lang="ts">
/**
 * 导入订阅（页面蓝图 §13）
 *
 * 输入方式（链接/文件）→ 解析预览（逐条状态与跳过原因）→ 同名策略 → 导入。
 *
 * v1.1 / CHG-02：解析与提交全部走 `importStore`（`previewFromUrl / previewFromFile /
 * previewFromText / commit`），内部由 `importService` 落库；预览结构以 `ImportPreview`
 * 契约字段为准（`entries[].valid/selected/duplicateOf/warning/issues/normalized`）。
 * 导入成功后源列表刷新由 `importService` 发出的 `sources:changed` 驱动，UI 不双写。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import type { ImportPreviewEntry, ImportResult } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ImportPreviewList from '@/components/source/ImportPreviewList.vue';
import { useImportStore } from '@/stores/importStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';
import { isValidHttpUrl } from '@/shared/url';

const router = useRouter();
const importer = useImportStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const mode = ref<'url' | 'file'>('url');
const url = ref('');
const fileName = ref<string | null>(null);
const selectedKeys = ref<string[]>([]);
const localError = ref<string | null>(null);
const duplicateStrategy = ref<'skip' | 'overwrite' | 'keep-both'>('skip');
const result = ref<ImportResult | null>(null);
/** 提交瞬间预览里「配置无效、未提交」的条目数（ImportResult.skipped 只统计同名跳过） */
const invalidAtCommit = ref(0);
const resultOpen = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

const strategyOptions = [
  { value: 'skip', label: '跳过' },
  { value: 'overwrite', label: '覆盖' },
  { value: 'keep-both', label: '保留两份' },
];

const preview = computed(() => importer.preview);
const parsing = computed(() => importer.parsing);
const importing = computed(() => importer.committing);
const hasPreview = computed(() => preview.value !== null);
const parseError = computed(() => localError.value ?? importer.error?.message ?? null);

const validEntries = computed<ImportPreviewEntry[]>(
  () => preview.value?.entries.filter((e) => e.valid) ?? [],
);
const importableCount = computed(
  () => validEntries.value.filter((e) => selectedKeys.value.includes(e.key)).length,
);
const validCount = computed(() => validEntries.value.length);
const skippedCount = computed(() => (preview.value?.entries.filter((e) => !e.valid).length ?? 0));

const globalWarnings = computed(
  () => preview.value?.globalIssues.filter((i) => i.level !== 'info') ?? [],
);
const globalErrors = computed(
  () => preview.value?.globalIssues.filter((i) => i.level === 'error') ?? [],
);

onMounted(() => {
  // 进入页面清空上一次会话的预览（保留历史导入记录）
  importer.reset();
});

/** 预览变化 → 默认全选有效条目（AC-08） */
watch(preview, (next) => {
  selectedKeys.value = next
    ? next.entries.filter((entry) => entry.valid && entry.selected).map((entry) => entry.key)
    : [];
});

/* ---------- 交互 ---------- */

async function fetchPreview(): Promise<void> {
  localError.value = null;
  result.value = null;
  const target = url.value.trim();
  if (!isValidHttpUrl(target)) {
    localError.value = '请填写合法的 http(s) 订阅地址';
    return;
  }
  if (isOffline.value) {
    localError.value = '网络不可用，请改用「从文件导入」';
    return;
  }
  await importer.previewFromUrl(target);
  if (preview.value === null) {
    // 解析失败：错误已落在 store.error（保留用户输入的 URL，AC-09/AC-10）
    return;
  }
}

function openFilePicker(): void {
  fileInputRef.value?.click();
}

async function onFileChange(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  localError.value = null;
  result.value = null;
  fileName.value = file.name;
  // 后缀 / 大小 / 空文件校验在 importService.previewFromFile 内（AC-12）
  await importer.previewFromFile(file);
}

function toggle(key: string, selected: boolean): void {
  selectedKeys.value = selected
    ? [...selectedKeys.value, key]
    : selectedKeys.value.filter((k) => k !== key);
}

function toggleAll(): void {
  const validKeys = validEntries.value.map((e) => e.key);
  selectedKeys.value = selectedKeys.value.length === validKeys.length ? [] : validKeys;
}

async function commit(): Promise<void> {
  if (!preview.value || importableCount.value === 0 || importing.value) return;
  if (globalErrors.value.length > 0) {
    toast.error(globalErrors.value[0]?.message ?? '订阅存在错误，无法导入');
    return;
  }
  try {
    // 记录本次提交前的无效条目数：`ImportResult.skipped` 只统计「同名已存在被跳过」，
    // 不含预览阶段就判定为无效（如缺 api）的条目，两者需分开如实展示（AC-13）。
    invalidAtCommit.value = skippedCount.value;
    const next = await importer.commit({
      selectedKeys: [...selectedKeys.value],
      onDuplicate: duplicateStrategy.value,
    });
    result.value = next;
    resultOpen.value = true;
    const skippedTotal = next.skipped + invalidAtCommit.value;
    if (next.failed > 0) {
      toast.error(`导入完成：成功 ${next.success}，跳过 ${skippedTotal}，失败 ${next.failed}`);
    } else {
      toast.success(`成功 ${next.success}，跳过 ${skippedTotal}，失败 ${next.failed}`);
    }
  } catch (e) {
    // 事务失败（全回滚）：错误明细进结果面板 + Toast
    const message = toErrorShape(e).message;
    invalidAtCommit.value = 0;
    result.value = {
      success: 0,
      skipped: 0,
      failed: importableCount.value,
      sourceIds: [],
      issues: [{ level: 'error', code: 'IMPORT_FAILED', field: null, message }],
    };
    resultOpen.value = true;
    toast.error(`导入失败，未写入任何源：${message}`);
  }
}

function closeResult(): void {
  resultOpen.value = false;
  const committed = result.value !== null && result.value.success > 0;
  if (committed) {
    // 已落库：清空预览避免重复提交（源列表已由 sources:changed 刷新）
    importer.reset();
    fileName.value = null;
    selectedKeys.value = [];
  }
}

function goBack(): void {
  if (preview.value) {
    void ui
      .confirm({
        title: '放弃导入？',
        message: '已解析的预览尚未导入。',
        confirmText: '放弃',
        danger: true,
      })
      .then((ok) => {
        if (ok) leave();
      });
    return;
  }
  leave();
}

function leave(): void {
  importer.reset();
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/settings/sources');
}
</script>

<template>
  <main class="import-page" data-route="source-import">
    <AppHeader title="导入订阅" back @back="goBack" />

    <div class="import-body">
      <ComplianceNotice />
      <OfflineBanner v-if="isOffline" text="离线模式，仅支持从文件导入" />

      <div class="import-mode">
        <SegmentedControl
          :model-value="mode"
          :options="[
            { value: 'url', label: '从链接导入' },
            { value: 'file', label: '从文件导入' },
          ]"
          label="导入方式"
          block
          @update:model-value="mode = $event === 'file' ? 'file' : 'url'"
        />
      </div>

      <section v-if="mode === 'url'" class="import-input-block">
        <label class="field__label" for="sub-url">订阅地址</label>
        <div class="import-input-row">
          <input
            id="sub-url"
            v-model="url"
            class="field__input"
            type="url"
            inputmode="url"
            placeholder="https://example.com/sub.json"
            :disabled="parsing || importing"
            @keydown.enter.prevent="fetchPreview"
          />
          <button
            class="btn btn--secondary btn--md import-fetch"
            type="button"
            :disabled="parsing || importing || isOffline"
            @click="fetchPreview"
          >
            <LoadingSpinner v-if="parsing" :size="16" />
            {{ parsing ? '获取中' : '获取' }}
          </button>
        </div>
        <p class="field__hint">支持 TVBox 风格 sites[] 或简化 sources[] 格式，单份上限 2MB。</p>
      </section>

      <section v-else class="import-input-block">
        <button
          class="import-dropzone"
          type="button"
          :disabled="parsing || importing"
          @click="openFilePicker"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3.6h8l4 4v12.8H6z" />
            <path d="M14 3.6v4h4" />
            <path d="M12 11v5M9.5 13.5 12 16l2.5-2.5" />
          </svg>
          <span>选择本地 JSON 文件</span>
          <span class="import-dropzone__hint">支持 .json，单文件上限 2MB</span>
        </button>
        <input
          ref="fileInputRef"
          class="import-file-input"
          type="file"
          accept=".json,application/json"
          @change="onFileChange"
        />
        <p v-if="fileName" class="import-file-name">已选择：{{ fileName }}</p>
      </section>

      <p v-if="parseError" class="import-error" role="alert">{{ parseError }}</p>

      <!-- 未解析 -->
      <EmptyState
        v-if="!hasPreview && !parsing && !parseError"
        variant="source"
        title="尚未解析订阅"
        description="粘贴订阅链接或选择本地 JSON 文件后，可在此预览将导入哪些源"
      />

      <!-- 预览 -->
      <template v-if="hasPreview && preview">
        <section class="import-summary">
          <div class="import-summary__head">
            <span class="import-summary__title">
              共 {{ preview.total }} 个源 · 可导入 {{ validCount }} · 跳过 {{ skippedCount }}
            </span>
            <button
              v-if="validCount > 0"
              class="import-summary__all"
              type="button"
              :disabled="importing"
              @click="toggleAll"
            >
              {{ selectedKeys.length === validCount ? '取消全选' : '全选' }}
            </button>
          </div>
          <p v-if="preview.name" class="import-summary__name">订阅名称：{{ preview.name }}</p>
          <p v-if="preview.sourceUrl" class="import-summary__name">来源：{{ preview.sourceUrl }}</p>
          <p v-else-if="preview.fileName" class="import-summary__name">来源：{{ preview.fileName }}</p>
          <p v-for="issue in globalWarnings" :key="issue.code" class="import-summary__warn">
            {{ issue.message }}
          </p>
        </section>

        <ImportPreviewList
          :entries="preview.entries"
          :selected-keys="selectedKeys"
          :disabled="importing"
          @toggle="toggle"
        />

        <!-- 缺字段 / 无效条目：逐条给出跳过原因（AC-09/AC-13） -->
        <section v-if="skippedCount > 0" class="import-skipped">
          <h2 class="field__label">将跳过 {{ skippedCount }} 个源</h2>
          <ul class="import-skipped__list">
            <li
              v-for="entry in preview.entries.filter((e) => !e.valid)"
              :key="`skip-${entry.key}`"
              class="import-skipped__item"
            >
              {{ entry.name || entry.key }}：{{
                entry.issues.find((i) => i.level === 'error')?.message ?? '配置无效'
              }}
            </li>
          </ul>
        </section>

        <section class="import-strategy">
          <h2 class="field__label">同名源处理</h2>
          <SegmentedControl v-model="duplicateStrategy" :options="strategyOptions" label="同名源处理" block />
          <p class="field__hint">
            默认「跳过」；「覆盖」会用订阅里的配置更新同名源；「保留两份」会生成新的 key。
          </p>
        </section>

        <button
          class="btn btn--primary btn--lg import-commit"
          type="button"
          :disabled="importableCount === 0 || importing"
          @click="commit"
        >
          <LoadingSpinner v-if="importing" :size="16" />
          {{ importing ? '正在导入…' : `导入 ${importableCount} 个源` }}
        </button>
      </template>
    </div>

    <!-- 导入结果 -->
    <div v-if="resultOpen" class="import-result" role="dialog" aria-modal="true" aria-label="导入结果">
      <div class="import-result__card">
        <h2 class="import-result__title">导入结果</h2>
        <p class="import-result__line">
          成功 {{ result?.success ?? 0 }} · 跳过
          {{ (result?.skipped ?? 0) + invalidAtCommit }} · 失败 {{ result?.failed ?? 0 }}
        </p>
        <p v-if="result && result.success > 0" class="import-result__sub">
          已写入 {{ result.sourceIds.length }} 个源，源列表已自动刷新
        </p>
        <p v-if="invalidAtCommit > 0" class="import-result__sub">
          其中 {{ invalidAtCommit }} 个源因配置不完整（如缺 api）未提交
        </p>
        <ul v-if="(result?.issues.length ?? 0) > 0" class="import-result__issues">
          <li
            v-for="(issue, index) in result?.issues ?? []"
            :key="`${issue.code}-${index}`"
            class="import-result__issue"
            :class="{ 'import-result__issue--error': issue.level === 'error' }"
          >
            {{ issue.message }}
          </li>
        </ul>
        <button class="btn btn--primary btn--md import-result__btn" type="button" @click="closeResult">
          {{ result && result.success > 0 ? '完成' : '知道了' }}
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.import-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.import-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.import-mode {
  display: flex;
  justify-content: center;
}

.import-input-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.import-input-row {
  display: flex;
  gap: var(--space-2);
}

.import-input-row .field__input {
  flex: 1 1 auto;
  min-width: 0;
}

.import-fetch {
  flex: 0 0 auto;
  min-width: 80px;
}

.import-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 120px;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 1.5px dashed var(--color-border-strong);
  background-color: var(--color-bg-surface);
  color: var(--color-text-primary);
  font: var(--text-label-strong);
}

.import-dropzone svg {
  width: 28px;
  height: 28px;
  color: var(--color-text-tertiary);
  margin-bottom: var(--space-1);
}

.import-dropzone__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-file-input {
  display: none;
}

.import-file-name {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.import-error {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-label);
}

.import-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.import-summary__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.import-summary__title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.import-summary__all {
  min-height: 36px;
  font: var(--text-label);
  color: var(--color-brand-text);
}

.import-summary__name {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  overflow-wrap: anywhere;
}

.import-summary__warn {
  font: var(--text-caption);
  color: var(--color-warning);
}

.import-skipped {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.import-skipped__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: disc;
  padding-left: var(--space-4);
}

.import-skipped__item {
  font: var(--text-caption);
  color: var(--color-danger);
  line-height: 1.5;
}

.import-strategy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.import-commit {
  margin-top: var(--space-2);
}

.import-result {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background-color: var(--color-bg-overlay);
}

.import-result__card {
  width: min(88vw, 360px);
  max-height: 72vh;
  overflow-y: auto;
  padding: var(--space-5);
  border-radius: var(--radius-xl);
  background-color: var(--color-bg-elevated);
  box-shadow: var(--shadow-4);
  text-align: center;
}

.import-result__title {
  font: var(--text-title-2);
  color: var(--color-text-primary);
}

.import-result__line {
  margin-top: var(--space-2);
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.import-result__sub {
  margin-top: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-result__issues {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-3);
  text-align: left;
  list-style: disc;
  padding-left: var(--space-4);
}

.import-result__issue {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.5;
}

.import-result__issue--error {
  color: var(--color-danger);
}

.import-result__btn {
  margin-top: var(--space-4);
  min-width: 120px;
}
</style>
