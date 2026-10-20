<script setup lang="ts">
/**
 * 导入订阅（页面蓝图 §13）
 *
 * 输入方式（链接/文件）→ 解析预览（逐条状态与跳过原因）→ 同名策略 → 导入。
 *
 * 契约缺口（重要）：
 * `importService`（API-05）不在 UI 包 import 白名单内（开发任务拆分 2.2），
 * API-14 也没有 import 相关 action，因此本视图保留**内置最小解析**用于预览
 * （支持 TVBox `sites[]` 与简化 `sources[]`、2MB 上限、必填字段校验、重复检测），
 * 提交时**如实告知未写入**，不伪造成功。预览结构已是 `ImportPreview` 契约，
 * 白名单放开或补 Store action 后只需替换 `fetchPreview` / `onFileChange` / `commit` 内部实现。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import type {
  ImportPreview,
  ImportPreviewEntry,
  ImportResult,
  SourceInput,
  SourceType,
} from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ImportPreviewList from '@/components/source/ImportPreviewList.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';
import { isValidHttpUrl, normalizeBaseUrl } from '@/shared/url';
import { MAX_SUBSCRIPTION_BYTES, MAX_SUBSCRIPTION_SOURCES } from '@/shared/constants';

const router = useRouter();
const sources = useSourceStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const mode = ref<'url' | 'file'>('url');
const url = ref('');
const loading = ref(false);
const fileName = ref<string | null>(null);
const preview = ref<ImportPreview | null>(null);
const selectedKeys = ref<string[]>([]);
const parseError = ref<string | null>(null);
const duplicateStrategy = ref<'skip' | 'overwrite' | 'keep-both'>('skip');
const importing = ref(false);
const result = ref<ImportResult | null>(null);
const resultOpen = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

const strategyOptions = [
  { value: 'skip', label: '跳过' },
  { value: 'overwrite', label: '覆盖' },
  { value: 'keep-both', label: '保留两份' },
];

const importableCount = computed(
  () => preview.value?.entries.filter((e) => e.valid && selectedKeys.value.includes(e.key)).length ?? 0,
);
const validCount = computed(() => preview.value?.entries.filter((e) => e.valid).length ?? 0);
const skippedCount = computed(() => preview.value?.entries.filter((e) => !e.valid).length ?? 0);
const hasPreview = computed(() => preview.value !== null);

const SENSITIVE_WORDS = ['破解', '盗版', '白嫖', '免费看'];

/* ---------- 临时解析（集成时替换为 importService） ---------- */

interface RawSite {
  key?: unknown;
  name?: unknown;
  type?: unknown;
  api?: unknown;
  searchable?: unknown;
  ext?: unknown;
}

function typeOf(raw: unknown): SourceType | 'unknown' {
  const value = String(raw ?? '').toLowerCase();
  if (value === '0' || value.includes('xml') || value.includes('site') || value.includes('cms')) return 'site';
  if (value === '1' || value.includes('alist')) return 'alist';
  if (value === '2' || value.includes('webdav')) return 'webdav';
  if (value === '3' || value.includes('jellyfin')) return 'jellyfin';
  if (value === 'demo') return 'demo';
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildPreview(json: unknown, origin: 'url' | 'file', name: string | null): ImportPreview {
  if (!isRecord(json)) throw new Error('订阅格式不支持：根节点必须是对象');
  const rawList = Array.isArray(json.sites)
    ? json.sites
    : Array.isArray(json.sources)
      ? json.sources
      : null;
  if (!rawList) throw new Error('订阅格式不支持：缺少 sites 或 sources 数组');
  if (rawList.length === 0) throw new Error('订阅中没有任何源');
  if (rawList.length > MAX_SUBSCRIPTION_SOURCES) {
    throw new Error(`订阅源数量超过上限（${MAX_SUBSCRIPTION_SOURCES} 个）`);
  }

  const existingKeys = new Set(sources.sources.map((s) => s.key));
  const existingUrls = new Set(sources.sources.map((s) => s.baseUrl).filter((u) => u.length > 0));
  const seenKeys = new Set<string>();

  const entries: ImportPreviewEntry[] = rawList.map((raw, index) => {
    const site: RawSite = isRecord(raw) ? raw : {};
    const nameValue = typeof site.name === 'string' ? site.name.trim() : '';
    const keyValue =
      typeof site.key === 'string' && site.key.trim().length > 0 ? site.key.trim() : `site-${index + 1}`;
    const apiValue = typeof site.api === 'string' ? site.api.trim() : '';
    const type = typeOf(site.type);
    const issues: ImportPreviewEntry['issues'] = [];

    if (nameValue.length === 0) issues.push({ level: 'error', code: 'missing_name', field: 'name', message: '缺少 name 字段' });
    if (apiValue.length === 0) issues.push({ level: 'error', code: 'missing_api', field: 'api', message: '缺少 api 字段' });
    else if (!isValidHttpUrl(apiValue)) {
      issues.push({ level: 'error', code: 'invalid_api', field: 'api', message: 'api 必须是 http(s) 地址' });
    }
    if (type === 'unknown') {
      issues.push({ level: 'warning', code: 'unknown_type', field: 'type', message: '未识别的源类型，将按站点处理' });
    }
    if (seenKeys.has(keyValue)) {
      issues.push({ level: 'error', code: 'duplicate_key_in_file', field: 'key', message: '同一订阅内 key 重复' });
    }
    seenKeys.add(keyValue);

    const valid = issues.every((i) => i.level !== 'error');
    const normalized: SourceInput | null = valid
      ? {
          name: nameValue.slice(0, 30),
          type: type === 'unknown' ? 'site' : type,
          baseUrl: normalizeBaseUrl(apiValue),
          key: keyValue,
        }
      : null;

    const warningHit = SENSITIVE_WORDS.find((w) => nameValue.includes(w) || apiValue.includes(w));
    const duplicateOf = existingKeys.has(keyValue)
      ? 'name'
      : existingUrls.has(normalizeBaseUrl(apiValue))
        ? 'url'
        : null;

    return {
      key: keyValue,
      name: nameValue,
      type,
      baseUrl: apiValue,
      enabled: true,
      selected: valid,
      valid,
      duplicateOf,
      warning: warningHit ? `名称或地址含敏感词「${warningHit}」，请确认拥有该源的访问权限` : null,
      issues,
      normalized,
    };
  });

  return {
    origin,
    sourceUrl: origin === 'url' ? url.value.trim() : null,
    fileName: name,
    fetchedAt: Date.now(),
    name: typeof json.name === 'string' ? json.name : null,
    total: entries.length,
    entries,
    globalIssues: [],
  };
}

function fileSizeError(file: File): string | null {
  if (!/\.json$/i.test(file.name)) return '仅支持 JSON 文件';
  if (file.size > MAX_SUBSCRIPTION_BYTES) return '文件过大（上限 2MB）';
  if (file.size === 0) return '文件内容为空';
  return null;
}

/* ---------- 交互 ---------- */

async function fetchPreview(): Promise<void> {
  parseError.value = null;
  result.value = null;
  const target = url.value.trim();
  if (!isValidHttpUrl(target)) {
    parseError.value = '请填写合法的 http(s) 订阅地址';
    return;
  }
  if (isOffline.value) {
    parseError.value = '网络不可用，请改用「从文件导入」';
    return;
  }
  loading.value = true;
  try {
    const res = await fetch(target);
    if (!res.ok) {
      parseError.value = `地址不可访问(${res.status})`;
      return;
    }
    const text = await res.text();
    if (text.length > MAX_SUBSCRIPTION_BYTES) {
      parseError.value = '订阅内容过大（上限 2MB）';
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      parseError.value = '内容不是合法 JSON';
      return;
    }
    await sources.load();
    const next = buildPreview(json, 'url', null);
    applyPreview(next);
  } catch (e) {
    parseError.value = toErrorShape(e, 'E_NETWORK').message;
  } finally {
    loading.value = false;
  }
}

function applyPreview(next: ImportPreview): void {
  preview.value = next;
  selectedKeys.value = next.entries.filter((e) => e.valid && e.selected).map((e) => e.key);
}

function openFilePicker(): void {
  fileInputRef.value?.click();
}

async function onFileChange(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  parseError.value = null;
  result.value = null;

  const sizeError = fileSizeError(file);
  if (sizeError) {
    parseError.value = sizeError;
    return;
  }

  loading.value = true;
  try {
    const text = await file.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      parseError.value = '内容不是合法 JSON';
      return;
    }
    await sources.load();
    const next = buildPreview(json, 'file', file.name);
    fileName.value = file.name;
    applyPreview(next);
  } catch (e) {
    parseError.value = toErrorShape(e, 'E_PARSE').message;
  } finally {
    loading.value = false;
  }
}

function toggle(key: string, selected: boolean): void {
  selectedKeys.value = selected
    ? [...selectedKeys.value, key]
    : selectedKeys.value.filter((k) => k !== key);
}

function toggleAll(): void {
  const validKeys = preview.value?.entries.filter((e) => e.valid).map((e) => e.key) ?? [];
  selectedKeys.value =
    selectedKeys.value.length === validKeys.length ? [] : validKeys;
}

async function commit(): Promise<void> {
  if (!preview.value || importableCount.value === 0) return;
  importing.value = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    // 契约未开放写入入口：结果必须如实反映"未写入"，不伪造成功
    result.value = {
      success: 0,
      skipped: preview.value.total - importableCount.value,
      failed: importableCount.value,
      sourceIds: [],
      issues: [
        {
          level: 'error',
          code: 'import_not_available',
          field: null,
          message: '应用内订阅导入暂未开放，本次未写入任何源',
        },
      ],
    };
    resultOpen.value = true;
    toast.info('应用内订阅导入暂未开放，未写入任何源');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    importing.value = false;
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
            :disabled="loading"
            @keydown.enter.prevent="fetchPreview"
          />
          <button
            class="btn btn--secondary btn--md import-fetch"
            type="button"
            :disabled="loading || isOffline"
            @click="fetchPreview"
          >
            <LoadingSpinner v-if="loading" :size="16" />
            {{ loading ? '获取中' : '获取' }}
          </button>
        </div>
        <p class="field__hint">支持 TVBox 风格 sites[] 或简化 sources[] 格式，单份上限 2MB。</p>
      </section>

      <section v-else class="import-input-block">
        <button class="import-dropzone" type="button" :disabled="loading" @click="openFilePicker">
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
        v-if="!hasPreview && !loading && !parseError"
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
            <button class="import-summary__all" type="button" @click="toggleAll">
              {{ selectedKeys.length === validCount ? '取消全选' : '全选' }}
            </button>
          </div>
          <p v-if="preview.name" class="import-summary__name">订阅名称：{{ preview.name }}</p>
        </section>

        <ImportPreviewList
          :entries="preview.entries"
          :selected-keys="selectedKeys"
          :disabled="importing"
          @toggle="toggle"
        />

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
    <div v-if="resultOpen" class="import-result" role="dialog" aria-modal="true">
      <div class="import-result__card">
        <h2 class="import-result__title">导入结果</h2>
        <p class="import-result__line">
          成功 {{ result?.success ?? 0 }} · 跳过 {{ result?.skipped ?? 0 }} · 失败 {{ result?.failed ?? 0 }}
        </p>
        <p v-for="issue in result?.issues ?? []" :key="issue.code" class="import-result__issue">
          {{ issue.message }}
        </p>
        <button class="btn btn--primary btn--md import-result__btn" type="button" @click="resultOpen = false">
          知道了
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

.import-result__issue {
  margin-top: var(--space-2);
  font: var(--text-caption);
  color: var(--color-danger);
}

.import-result__btn {
  margin-top: var(--space-4);
  min-width: 120px;
}
</style>
