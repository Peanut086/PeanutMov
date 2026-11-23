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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { ImportPreviewEntry, ImportResult, ImportSuggestion } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ImportPreviewList from '@/components/source/ImportPreviewList.vue';
import { useImportStore } from '@/stores/importStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { liveService } from '@/services/liveService';
import { recommendedSubscriptions, type RecommendedSubscription } from '@/data/recommended/recommended';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';
import { getHost, isValidHttpUrl } from '@/shared/url';
import { normalizeImportUrl } from '@/shared/urlNormalize';

const router = useRouter();
const route = useRoute();
const importer = useImportStore();
const sourceStore = useSourceStore();
const settings = useSettingsStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const mode = ref<'url' | 'file'>('url');
const url = ref('');
const fileName = ref<string | null>(null);
const selectedKeys = ref<string[]>([]);
const localError = ref<string | null>(null);
const duplicateStrategy = ref<'skip' | 'overwrite' | 'keep-both'>('skip');
/**
 * P1-3：「覆盖」时是否连带清空该源已缓存的内容（默认开 = FR-04 现行为）。
 * 关掉后首页「最近添加」不缩水、详情不重新回源，但订阅里新增的条目要等下次浏览才入库。
 */
const clearCacheOnOverwrite = ref(true);
const result = ref<ImportResult | null>(null);
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
const repoList = computed(() => preview.value?.repos ?? []);
const isMultiRepo = computed(() => repoList.value.length > 0);

/* ---------- v1.7/CHG-18：非订阅内容的可操作建议 ---------- */
const suggestions = computed<ImportSuggestion[]>(() => preview.value?.suggestions ?? []);

/** v1.7/CHG-24：内置推荐订阅（设置可整体关闭） */
const recommended = computed<RecommendedSubscription[]>(() =>
  settings.settings?.showRecommendedSubscriptions === false ? [] : recommendedSubscriptions().items,
);

async function applySuggestion(suggestion: ImportSuggestion): Promise<void> {
  try {
    if (suggestion.action === 'add-live' || suggestion.action === 'add-channel') {
      const name = suggestion.action === 'add-channel' ? `单流 ${getHost(suggestion.payload)}` : `直播源 ${getHost(suggestion.payload)}`;
      await liveService.add({
        name,
        url: suggestion.payload,
        format: suggestion.action === 'add-channel' ? 'm3u' : 'auto',
        subscriptionId: preview.value?.sourceUrl ?? null,
      });
      toast.success('已添加到「直播」页');
    } else {
      const host = getHost(suggestion.payload);
      await sourceStore.create({
        name: host.length > 0 ? host : '采集接口',
        type: 'site',
        baseUrl: suggestion.payload,
        ext: { cmsDirect: true, searchable: true },
      });
      toast.success('已添加为采集接口源，可去源管理查看');
    }
    importer.reset();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

/** 推荐项：预填地址并立即评测展示（导入仍需用户逐项确认） */
function useRecommended(item: RecommendedSubscription): void {
  mode.value = 'url';
  url.value = item.url;
  void fetchPreview();
}

onMounted(async () => {
  // 进入页面清空上一次会话的预览（保留历史导入记录）
  importer.reset();
  try {
    if (!settings.settings) await settings.load();
  } catch {
    /* 设置加载失败不阻塞导入 */
  }
  // 批量评测页「导入」跳转预填（CHG-12）：支持 ?url= 自动获取预览
  const prefill = route.query.url;
  if (typeof prefill === 'string' && isValidHttpUrl(prefill.trim())) {
    url.value = prefill.trim();
    void fetchPreview();
  }
});

// P0-2：本页不在 KeepAlive 名单内，离开即销毁——顺手中止在途解析，别让它继续在后台占请求
onBeforeUnmount(() => {
  importer.abortPreview();
});

/** 跳批量评测页（CHG-12） */
function goEval(): void {
  void router.push('/settings/subscriptions/eval');
}

/* ---------- v1.8/CHG-26：解析失败可操作化（原因之外给下一步动作） ---------- */

/** 归一化结果：修正地址（blob→raw 等）与镜像变体（剥代理前缀/镜像站） */
const urlFix = computed(() => {
  const target = url.value.trim();
  if (!isValidHttpUrl(target)) return null;
  try {
    const n = normalizeImportUrl(target);
    return {
      corrected: n.url !== target ? n.url : null,
      mirror: n.variants.find((v) => v !== n.url) ?? null,
      notes: n.notes,
    };
  } catch {
    return null;
  }
});

function retryFetch(): void {
  void fetchPreview();
}

/** 用归一化修正地址重试（如 GitHub blob 页 → raw） */
function retryWithFixed(): void {
  const fixed = urlFix.value?.corrected;
  if (!fixed) return;
  url.value = fixed;
  void fetchPreview();
}

/** 换镜像变体重试（剥 gh-proxy 前缀直连 / 镜像站） */
function retryWithMirror(): void {
  const mirror = urlFix.value?.mirror;
  if (!mirror) return;
  url.value = mirror;
  void fetchPreview();
}

/** 复制诊断：地址 + 错误 + 归一化提示，便于反馈或换工具排查 */
async function copyDiagnostic(): Promise<void> {
  const lines = [
    `地址：${url.value.trim()}`,
    `错误：${parseError.value ?? '未知错误'}`,
    ...(urlFix.value?.notes ?? []).map((n) => `提示：${n}`),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast.success('诊断信息已复制');
  } catch {
    toast.error('复制失败，请长按地址栏手动复制');
  }
}

/** 带当前地址跳批量评测（粘贴侧已有 URL，评测排行判断订阅死活） */
function goEvalWithUrl(): void {
  const target = url.value.trim();
  void router.push({
    path: '/settings/subscriptions/eval',
    query: isValidHttpUrl(target) ? { url: target } : undefined,
  });
}

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

/** 多仓索引：选中一个仓库展开成源列表 */
async function expandRepo(repoUrl: string): Promise<void> {
  localError.value = null;
  result.value = null;
  await importer.previewFromRepo(repoUrl);
  if (preview.value === null) {
    localError.value = importer.error?.message ?? '该仓库解析失败，请换一个仓库';
    return;
  }
  // 展开后来源变成具体仓库地址，方便用户回溯
  url.value = repoUrl;
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
  importCheckResult.value = null;
  if (globalErrors.value.length > 0) {
    toast.error(globalErrors.value[0]?.message ?? '订阅存在错误，无法导入');
    return;
  }
  try {
    // CHG-03：`ImportResult.skipped` 已统一包含「预览无效」与「同名跳过」两类，
    // 展示层不再额外补偿，避免重复计数（AC-13）。
    const next = await importer.commit({
      selectedKeys: [...selectedKeys.value],
      onDuplicate: duplicateStrategy.value,
      clearCache: clearCacheOnOverwrite.value,
    });
    result.value = next;
    resultOpen.value = true;
    // CHG-13：订阅带 lives[] 直播源时自动添加到直播页（幂等，同 URL 跳过）
    const lives = preview.value?.lives ?? [];
    if (lives.length > 0 && next.success > 0) {
      const livesResult = await liveService.addTvboxLives(lives, url.value.trim() || fileName.value);
      if (livesResult.added > 0) {
        toast.info(`识别到 ${livesResult.added} 个直播源，已添加到「直播」页`);
      }
      if (livesResult.failed > 0) {
        toast.error(`直播源有 ${livesResult.failed} 个没能添加，可到「直播」页手动补`);
      }
    }
    const skippedTotal = next.skipped;
    if (next.failed > 0) {
      toast.error(`导入完成：成功 ${next.success}，跳过 ${skippedTotal}，失败 ${next.failed}`);
    } else {
      toast.success(`成功 ${next.success}，跳过 ${skippedTotal}，失败 ${next.failed}`);
    }
  } catch (e) {
    // 事务失败（全回滚）：错误明细进结果面板 + Toast
    const message = toErrorShape(e).message;
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

/**
 * P1-1：体检刚导入的这批源。
 *
 * 常规 commit 不做任何探测（只有 `importWithDiagnostic` 路径会处置退化源），
 * 于是"导入 30 个源、其中 12 个是死的"只能靠用户去搜索时撞错误发现。
 * 这里复用 `sourceStore.checkSources` → `healthService.check(ids)`，
 * 取消也复用同一条 `cancelHealthCheck` 通路（不新造探测实现）。
 */
const importCheckResult = ref<{ checked: number; ok: number; bad: number } | null>(null);

async function checkImported(): Promise<void> {
  const ids = result.value?.sourceIds ?? [];
  if (ids.length === 0 || sourceStore.healthChecking) return;
  importCheckResult.value = null;
  try {
    const report = await sourceStore.checkSources(ids);
    if (report.aborted) {
      toast.info('已取消检测，已检测的部分结果可在源列表看到');
      return;
    }
    importCheckResult.value = report;
    const text = `刚导入的 ${report.checked} 个源：可用 ${report.ok}，失效 ${report.bad}`;
    toast[report.bad > 0 ? 'info' : 'success'](text);
  } catch (e) {
    toast.error(toErrorShape(e).message);
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
  else void router.replace('/settings');
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
        <button class="import-eval-link" type="button" @click="goEval">
          手里有一批订阅？→ 批量评测排行
        </button>
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
          <!-- P0-2：解析可取消——旧口径只能"丢弃结果"，请求仍会跑满 10s 预算 -->
          <button
            v-if="parsing"
            class="btn btn--ghost btn--md import-fetch"
            type="button"
            @click="importer.abortPreview()"
          >
            取消
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

      <!-- v1.8/CHG-26：解析失败可操作化——重试/修正地址/换镜像/复制诊断/去批量评测 -->
      <div v-if="parseError" class="import-error__actions">
        <button class="btn btn--secondary btn--sm" type="button" @click="retryFetch">重试</button>
        <button
          v-if="urlFix?.corrected"
          class="btn btn--secondary btn--sm"
          type="button"
          @click="retryWithFixed"
        >
          用修正地址重试
        </button>
        <button
          v-if="urlFix?.mirror"
          class="btn btn--secondary btn--sm"
          type="button"
          @click="retryWithMirror"
        >
          换镜像重试
        </button>
        <button class="btn btn--ghost btn--sm" type="button" @click="copyDiagnostic">复制诊断</button>
        <button class="btn btn--ghost btn--sm" type="button" @click="goEvalWithUrl">去批量评测</button>
      </div>
      <p v-if="parseError && urlFix?.notes?.length" class="field__hint">
        {{ urlFix.notes.join('；') }}
      </p>

      <!-- v1.7/CHG-18：内容不是普通订阅，但可以一键落地 -->
      <section v-if="hasPreview && suggestions.length > 0" class="import-summary">
        <div class="import-summary__head">
          <span class="import-summary__title">这不是普通订阅，但可以：</span>
        </div>
        <ul class="import-skipped__list">
          <li v-for="(suggestion, index) in suggestions" :key="`sg-${index}`" class="import-skipped__item">
            <button class="btn btn--secondary btn--md" type="button" :disabled="importing" @click="applySuggestion(suggestion)">
              {{
                suggestion.action === 'add-live'
                  ? `加入直播源（${suggestion.channelCount} 个频道）`
                  : suggestion.action === 'add-channel'
                    ? '加入自定义频道'
                    : '添加为采集接口源'
              }}
            </button>
          </li>
        </ul>
        <p class="field__hint">添加动作在当前页面完成，不会写入订阅源列表。</p>
      </section>

      <!-- 未解析 -->
      <EmptyState
        v-if="!hasPreview && !parsing && !parseError"
        variant="source"
        title="尚未解析订阅"
        description="粘贴订阅链接或选择本地 JSON 文件后，可在此预览将导入哪些源"
      />

      <!-- v1.7/CHG-24：内置推荐订阅（评测展示，导入需逐项确认） -->
      <section v-if="recommended.length > 0" class="import-summary">
        <div class="import-summary__head">
          <span class="import-summary__title">推荐订阅（随版本内置，点击评测后自行确认导入）</span>
        </div>
        <ul class="import-skipped__list">
          <li v-for="item in recommended" :key="item.url" class="import-skipped__item import-recommend">
            <div class="import-recommend__text">
              <strong>{{ item.name }}</strong>
              <span class="import-recommend__note">{{ item.note }}</span>
              <span v-if="item.tags.length > 0" class="import-recommend__tags">
                <span v-for="tag in item.tags" :key="tag" class="import-recommend__tag">{{ tag }}</span>
              </span>
            </div>
            <button class="btn btn--secondary btn--md" type="button" :disabled="parsing" @click="useRecommended(item)">
              评测
            </button>
          </li>
        </ul>
      </section>

      <!-- 预览 -->
      <template v-if="hasPreview && preview">
        <section v-if="isMultiRepo" class="import-summary">
          <div class="import-summary__head">
            <span class="import-summary__title">多仓索引 · 共 {{ repoList.length }} 个仓库</span>
          </div>
          <p class="import-summary__name">
            这是多仓索引，请选择其中一个仓库展开后再导入。
          </p>
        </section>

        <section v-if="isMultiRepo" class="import-skipped">
          <ul class="import-skipped__list">
            <li v-for="repo in repoList" :key="repo" class="import-skipped__item">
              <button
                class="btn btn--secondary btn--md"
                type="button"
                :disabled="parsing || importing"
                @click="expandRepo(repo)"
              >
                展开 {{ repo }}
              </button>
            </li>
          </ul>
        </section>

        <template v-if="!isMultiRepo">
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
            <!-- P1-3：覆盖策略唯一的副作用（连带清缓存）单独给一个出口，默认仍为 FR-04 行为 -->
            <div v-if="duplicateStrategy === 'overwrite'" class="import-strategy__cache">
              <div class="import-strategy__cache-texts">
                <span class="import-strategy__cache-label">覆盖时清理该源缓存</span>
                <span class="import-strategy__cache-hint">
                  关闭后保留已缓存的影片与选集，订阅里新增的条目要等下次浏览才入库
                </span>
              </div>
              <ToggleSwitch v-model="clearCacheOnOverwrite" label="覆盖时清理该源缓存" />
            </div>
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
      </template>
    </div>

    <!-- 导入结果 -->
    <div v-if="resultOpen" class="import-result" role="dialog" aria-modal="true" aria-label="导入结果">
      <div class="import-result__card">
        <h2 class="import-result__title">导入结果</h2>
        <p class="import-result__line">
          成功 {{ result?.success ?? 0 }} · 跳过
          {{ result?.skipped ?? 0 }} · 失败 {{ result?.failed ?? 0 }}
        </p>
        <p v-if="result && result.success > 0" class="import-result__sub">
          已写入 {{ result.sourceIds.length }} 个源，源列表已自动刷新
        </p>
        <!-- P1-1：新导入的源没有健康记录，这里给一次只测本批的体检入口 -->
        <div
          v-if="result && result.success > 0 && result.sourceIds.length > 0"
          class="import-result__check"
        >
          <div class="import-result__check-actions">
            <button
              class="btn btn--secondary btn--sm"
              type="button"
              :disabled="sourceStore.healthChecking"
              title="只检测本次导入的源，不影响其它源的健康状态"
              @click="checkImported"
            >
              <LoadingSpinner v-if="sourceStore.healthChecking" :size="14" />
              {{
                sourceStore.healthChecking
                  ? '检测中…'
                  : `体检刚导入的 ${result.sourceIds.length} 个源`
              }}
            </button>
            <button
              v-if="sourceStore.healthChecking"
              class="btn btn--ghost btn--sm"
              type="button"
              @click="sourceStore.cancelHealthCheck()"
            >
              取消
            </button>
          </div>
          <p v-if="importCheckResult" class="import-result__check-note">
            可用 {{ importCheckResult.ok }} · 失效 {{ importCheckResult.bad }}
            <template v-if="importCheckResult.bad > 0">（失效原因见源列表的健康徽章）</template>
          </p>
        </div>
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
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

/* 批量评测入口（CHG-12）：弱化的文字按钮 */
.import-eval-link {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-decoration: underline;
  text-underline-offset: 3px;
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

/* v1.8/CHG-26：解析失败动作条 */
.import-error__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: calc(-1 * var(--space-1));
  margin-bottom: var(--space-2);
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

/* v1.7：suggestions 动作条与推荐区块复用 skipped 容器，去掉危险色 */
.import-skipped__item button {
  color: inherit;
}

.import-recommend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--color-text);
  list-style: none;
}

.import-recommend__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.import-recommend__note {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-recommend__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.import-recommend__tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius-full, 999px);
  background-color: var(--color-bg-base, #f5f5f5);
  color: var(--color-text-secondary, #666);
  font-size: 11px;
  line-height: 18px;
}

.import-strategy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* P1-3：覆盖策略下的缓存清理开关（沿用设置页开关行：surface + border，命中区 44） */
.import-strategy__cache {
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

.import-strategy__cache-texts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.import-strategy__cache-label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.import-strategy__cache-hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
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

/* P1-1：导入后体检（按钮 + 结果一行，不抢主按钮的视觉权重） */
.import-result__check {
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.import-result__check-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.import-result__check-note {
  font: var(--text-caption);
  color: var(--color-text-secondary);
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
