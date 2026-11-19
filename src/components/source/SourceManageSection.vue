<script setup lang="ts">
/**
 * 源管理内联区（OPT-09）
 *
 * 在设置页内就地管理源：列表 + 开关 + 新增/编辑/删除。
 * 复用 SourceCard 展示单源信息，SourceFormSheet 处理表单。
 * 不包含独立路由——所有操作通过 BottomSheet 完成。
 *
 * FIX-01（Q-04=A）：把内联化时丢失的能力补回本区，不恢复旧独立路由：
 * 1. 采集接口入口 → SourceForm 的类型卡「采集接口」（ext.cmsDirect）；
 * 2. 恢复演示源（AC-97，幂等补齐、不重复）；
 * 3. 自动禁用角标 / 单条与一键恢复 / 订阅健康摘要（AC-117、AC-119）；
 * 4. 检测进度「检测中 n/total」+ 六档质量排序持久化（AC-106~108）；
 * 5. 批量清理：禁用全部失效源、删除全部已禁用源（确认 + 统计）。
 * OPT-03：健康检查支持取消与「仅检测失败源」。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { Source, SourceInput } from '@/types';
import type { HealthTier, SourceSortMode } from '@/shared/healthTier';
import {
  HEALTH_TIER_LABELS,
  healthTierOf,
  readSourceSortMode,
  sortSources,
  writeSourceSortMode,
} from '@/shared/healthTier';
import { toErrorShape } from '@/shared/errors';
import { DEMO_SOURCE_ID } from '@/data/demo/demoSeed';

import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import SourceFormSheet from '@/components/source/SourceFormSheet.vue';
import HealthBadge from '@/components/source/HealthBadge.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { restoreDemoSource } from '@/stores/bootstrap';
import { refreshSummaryText } from '@/services/subscriptionLifecycleService';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';

const router = useRouter();
const sources = useSourceStore();
const settings = useSettingsStore();
const ui = useUiStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();

function openImport(): void {
  void router.push({ name: 'source-import' });
}

function openHealthCenter(): void {
  void router.push('/health-center');
}

function openImportDiagnostic(): void {
  void router.push('/import-diagnostic');
}

/* ---------- 排序与质量概览（AC-106 / AC-108） ---------- */
const SORT_OPTIONS = [
  { value: 'manual', label: '手动排序' },
  { value: 'tier', label: '按线路质量' },
];
const sortMode = ref<SourceSortMode>(readSourceSortMode());

function latencyOf(id: string): number | null {
  return sources.latencyOf(id);
}

function tierOf(source: Source): HealthTier {
  return healthTierOf(source.health, latencyOf(source.id));
}

const orderedSources = computed(() => sortSources(sources.sources, sortMode.value, latencyOf));

function changeSortMode(value: string): void {
  const next: SourceSortMode = value === 'tier' ? 'tier' : 'manual';
  if (next === sortMode.value) return;
  sortMode.value = next;
  writeSourceSortMode(next);
  toast.info(next === 'tier' ? '已按线路质量排序' : '已切换为手动排序');
}

/** 至少一个源检测过（非 unknown）才展示总览，避免首屏「全部未检测」噪音 */
const showTierSummary = computed(() =>
  sources.sources.some((source) => source.health !== 'unknown'),
);

const tierSummary = computed(() => {
  const counts: Record<HealthTier, number> = {
    fast: 0,
    good: 0,
    fair: 0,
    slow: 0,
    bad: 0,
    unknown: 0,
  };
  for (const source of sources.sources) counts[tierOf(source)] += 1;
  const order: HealthTier[] = ['fast', 'good', 'fair', 'slow', 'bad'];
  return order.map((tier) => ({ tier, label: HEALTH_TIER_LABELS[tier], count: counts[tier] }));
});

/* ---------- 新增/编辑表单 ---------- */
const formOpen = ref(false);
const editingSource = ref<Source | null>(null);
const formSaving = ref(false);
const formTesting = ref(false);
const formTestResult = ref<{ ok: boolean; message: string } | null>(null);

function openAdd(): void {
  editingSource.value = null;
  formTestResult.value = null;
  formOpen.value = true;
}

function openEdit(source: Source): void {
  // 演示源类型不可变更，表单会把 demo 映射成 alist 导致保存必然失败
  if (source.type === 'demo') {
    toast.info('内置演示源不支持编辑，可禁用后恢复');
    return;
  }
  editingSource.value = source;
  formTestResult.value = null;
  formOpen.value = true;
}

async function onFormSubmit(input: SourceInput): Promise<void> {
  formSaving.value = true;
  formTestResult.value = null;
  try {
    if (editingSource.value) {
      await sources.update(editingSource.value.id, input);
      toast.success(`已更新「${input.name}」`);
    } else {
      await sources.create(input);
      toast.success(`已添加「${input.name}」`);
    }
    formOpen.value = false;
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    formSaving.value = false;
  }
}

async function onFormTest(input: SourceInput): Promise<void> {
  formTesting.value = true;
  formTestResult.value = null;
  try {
    const result = await sources.testConnection(input);
    formTestResult.value = { ok: result.ok, message: result.message };
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
  } catch (e) {
    formTestResult.value = { ok: false, message: toErrorShape(e).message };
    toast.error(toErrorShape(e).message);
  } finally {
    formTesting.value = false;
  }
}

function onFormCancel(): void {
  formOpen.value = false;
  editingSource.value = null;
  formTestResult.value = null;
}

/* ---------- 开关/删除 ---------- */
async function toggleSource(source: Source, enabled: boolean): Promise<void> {
  try {
    await sources.setEnabled(source.id, enabled);
    // 默认源被禁用时，切到下一个可用源
    if (!enabled && settings.settings?.defaultSourceId === source.id) {
      const next =
        sources.enabledSources.find((s) => !s.builtin) ?? sources.enabledSources[0] ?? null;
      await settings.update({ defaultSourceId: next?.id ?? null });
    }
    toast.success(enabled ? `已启用「${source.name}」` : `已禁用「${source.name}」`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function deleteSource(source: Source): Promise<void> {
  if (source.builtin) {
    toast.info('内置源不可删除');
    return;
  }
  const ok = await ui.confirm({
    title: `删除「${source.name}」？`,
    message: '删除后不可恢复，相关下载任务不受影响。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await sources.remove(source.id);
    toast.success(`已删除「${source.name}」`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

/* ---------- 菜单操作（⋯ 按钮） ---------- */
const menuSource = ref<Source | null>(null);
const menuOpen = ref(false);

function openMenu(source: Source): void {
  menuSource.value = source;
  menuOpen.value = true;
}

function closeMenu(): void {
  menuOpen.value = false;
  menuSource.value = null;
}

function menuEdit(): void {
  if (menuSource.value) openEdit(menuSource.value);
  closeMenu();
}

async function menuSetDefault(): Promise<void> {
  if (!menuSource.value) return;
  try {
    await settings.update({ defaultSourceId: menuSource.value.id });
    toast.success(`已设「${menuSource.value.name}」为默认源`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
  closeMenu();
}

async function menuRestoreAuto(): Promise<void> {
  if (!menuSource.value) return;
  const target = menuSource.value;
  closeMenu();
  try {
    await sources.restoreAutoDisabled(target.id);
    toast.success(`已恢复「${target.name}」并重新启用`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function menuDelete(): Promise<void> {
  if (!menuSource.value) return;
  const src = menuSource.value;
  closeMenu();
  await deleteSource(src);
}

/* ---------- 恢复演示源（AC-97） ---------- */
const demoSource = computed(
  () => sources.sources.find((source) => source.id === DEMO_SOURCE_ID) ?? null,
);
const demoNeedsRestore = computed(() => demoSource.value === null || !demoSource.value.enabled);
const restoringDemo = ref(false);

async function restoreDemo(): Promise<void> {
  if (restoringDemo.value) return;
  restoringDemo.value = true;
  try {
    const source = await restoreDemoSource();
    await sources.load();
    void sources.loadSummaries();
    toast.success(`已恢复「${source.name}」并补齐演示条目`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    restoringDemo.value = false;
  }
}

/* ---------- 健康检查 / 取消 / 仅失败源（OPT-03） ---------- */
const healthChecking = computed(() => sources.healthChecking);
const cancelRequested = ref(false);

const progressText = computed(() => {
  const progress = sources.healthProgress;
  if (!progress || progress.total === 0 || progress.done >= progress.total) return '检测中…';
  return `检测中 ${progress.done}/${progress.total}`;
});

const failedTargets = computed(() =>
  sources.sources.filter(
    (source) =>
      source.enabled &&
      source.healthCheckedAt !== null &&
      source.health !== 'ok' &&
      source.health !== 'unknown',
  ),
);

async function checkHealth(): Promise<void> {
  cancelRequested.value = false;
  try {
    await sources.refreshHealth();
    if (!cancelRequested.value) toast.success('健康检查完成');
  } catch (e) {
    if (!cancelRequested.value) toast.error(toErrorShape(e).message);
  }
}

async function checkFailed(): Promise<void> {
  const total = failedTargets.value.length;
  if (total === 0) {
    toast.info('没有需要复检的失败源');
    return;
  }
  cancelRequested.value = false;
  try {
    await sources.refreshHealth({ failedOnly: true });
    if (!cancelRequested.value) toast.success(`已复检 ${total} 个失败源`);
  } catch (e) {
    if (!cancelRequested.value) toast.error(toErrorShape(e).message);
  }
}

function cancelHealth(): void {
  if (!healthChecking.value) return;
  cancelRequested.value = true;
  sources.cancelHealthCheck();
  toast.info('已取消健康检查');
}

/* ---------- 批量治理（FIX-01） ---------- */
const batchBusy = ref<'disable' | 'purge' | 'restore' | null>(null);
const batchProgress = ref<{ done: number; total: number } | null>(null);
const batchText = computed(() =>
  batchProgress.value ? `处理中 ${batchProgress.value.done}/${batchProgress.value.total}` : '处理中…',
);

function onBatchProgress(done: number, total: number): void {
  batchProgress.value = { done, total };
}

const unhealthyEnabled = computed(() =>
  sources.sources.filter(
    (source) =>
      source.enabled &&
      source.healthCheckedAt !== null &&
      (source.health === 'unreachable' ||
        source.health === 'bad_config' ||
        source.health === 'auth_failed' ||
        source.health === 'empty'),
  ),
);

const disabledRemovable = computed(() => sources.sources.filter((s) => !s.enabled && !s.builtin));

async function disableUnhealthy(): Promise<void> {
  const targets = unhealthyEnabled.value;
  if (targets.length === 0 || batchBusy.value !== null) return;
  const names = targets
    .slice(0, 3)
    .map((s) => `「${s.name}」`)
    .join('、');
  const ok = await ui.confirm({
    title: '禁用全部失效源？',
    message: `将禁用 ${targets.length} 个检测失效的源：${names}${targets.length > 3 ? ' 等' : ''}。「连接超时」的源可能是临时网络慢，不会被禁用；被禁用的源可随时重新启用。`,
    confirmText: '禁用',
  });
  if (!ok) return;
  batchBusy.value = 'disable';
  batchProgress.value = { done: 0, total: targets.length };
  try {
    const disabled = await sources.disableUnhealthy(onBatchProgress);
    const defaultId = settings.settings?.defaultSourceId ?? null;
    if (defaultId !== null && !sources.enabledSources.some((s) => s.id === defaultId)) {
      const next =
        sources.enabledSources.find((s) => !s.builtin) ?? sources.enabledSources[0] ?? null;
      await settings.update({ defaultSourceId: next?.id ?? null });
    }
    toast.success(`已禁用 ${disabled} 个失效源`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    batchBusy.value = null;
    batchProgress.value = null;
  }
}

async function purgeDisabled(): Promise<void> {
  const targets = disabledRemovable.value;
  if (targets.length === 0 || batchBusy.value !== null) return;
  const ok = await ui.confirm({
    title: `清理 ${targets.length} 个已禁用源？`,
    message:
      '只删除当前处于禁用状态的源，内置源与正在使用的源不受影响。收藏与观看历史会保留；已下载的文件不会被删除。此操作不可撤销。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  batchBusy.value = 'purge';
  batchProgress.value = { done: 0, total: targets.length };
  try {
    const result = await sources.purgeDisabled(onBatchProgress);
    const failedPart = result.failed > 0 ? `，${result.failed} 个失败` : '';
    toast.success(`已清理 ${result.removed} 个已禁用源${failedPart}`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    batchBusy.value = null;
    batchProgress.value = null;
  }
}

/* ---------- 自动禁用恢复（AC-117）与订阅摘要（AC-119） ---------- */
const autoDisabledSources = computed(() => sources.sources.filter((source) => source.autoDisabledAt));

async function restoreAutoDisabled(id: string): Promise<void> {
  try {
    await sources.restoreAutoDisabled(id);
    toast.success('已恢复该源并重新启用');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function restoreAllAutoDisabled(): Promise<void> {
  const total = autoDisabledSources.value.length;
  if (total === 0 || batchBusy.value !== null) return;
  const ok = await ui.confirm({
    title: `恢复全部 ${total} 个自动禁用源？`,
    message: '将清除自动禁用标记并重新启用；恢复后建议再执行一次健康检查确认可用性。',
    confirmText: '恢复',
  });
  if (!ok) return;
  batchBusy.value = 'restore';
  batchProgress.value = { done: 0, total };
  try {
    const restored = await sources.restoreAllAutoDisabled(onBatchProgress);
    toast.success(`已恢复 ${restored} 个源`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    batchBusy.value = null;
    batchProgress.value = null;
  }
}

/** 订阅摘要标签：URL 取主机名，文件名取末段，避免直接展示超长 ID */
function subscriptionLabel(id: string): string {
  try {
    const url = new URL(id);
    return url.hostname;
  } catch {
    const clean = id.split('?')[0] ?? id;
    const parts = clean.split('/');
    return parts[parts.length - 1] || clean;
  }
}

const refreshingSubscriptions = computed(() => sources.refreshingSubscriptions);

async function refreshSubscriptions(): Promise<void> {
  if (isOffline.value) {
    toast.info('当前离线，无法刷新订阅');
    return;
  }
  try {
    // 文案与订阅管理页共用 `refreshSummaryText`：跳过条数不是失败，也不能不说
    const summary = refreshSummaryText(await sources.refreshAllSubscriptions());
    toast[summary.tone](summary.text);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

onMounted(() => {
  void sources.loadSummaries();
});
</script>

<template>
  <div class="source-manage">
    <!-- 合规提示 -->
    <ComplianceNotice />

    <!-- 演示源恢复（AC-97） -->
    <div v-if="demoNeedsRestore" class="source-manage__notice">
      <span class="source-manage__notice-text">
        演示源已禁用或被清理，媒体库不再展示演示条目。
      </span>
      <button
        class="btn btn--secondary btn--sm"
        type="button"
        :disabled="restoringDemo"
        @click="restoreDemo"
      >
        <LoadingSpinner v-if="restoringDemo" :size="14" />
        {{ restoringDemo ? '恢复中…' : '恢复演示源' }}
      </button>
    </div>

    <!-- 操作栏：新增 + 导入 + 诊断 + 健康中心 + 健康检查（支持取消 / 仅失败源） -->
    <div class="source-manage__actions">
      <button class="btn btn--primary btn--sm" type="button" @click="openAdd">新增源</button>
      <button class="btn btn--secondary btn--sm" type="button" @click="openImport">
        导入订阅
      </button>
      <button class="btn btn--secondary btn--sm" type="button" @click="openImportDiagnostic">
        导入诊断
      </button>
      <button class="btn btn--secondary btn--sm" type="button" @click="openHealthCenter">
        健康中心
      </button>
      <button
        v-if="!healthChecking"
        class="btn btn--secondary btn--sm"
        type="button"
        :disabled="sources.sources.length === 0"
        @click="checkHealth"
      >
        健康检查
      </button>
      <button
        v-else
        class="btn btn--secondary btn--sm"
        type="button"
        disabled
      >
        <LoadingSpinner :size="14" />
        {{ progressText }}
      </button>
      <button
        v-if="healthChecking"
        class="btn btn--secondary btn--sm"
        type="button"
        @click="cancelHealth"
      >
        取消
      </button>
      <button
        v-else
        class="btn btn--secondary btn--sm"
        type="button"
        :disabled="failedTargets.length === 0"
        @click="checkFailed"
      >
        仅检测失败源（{{ failedTargets.length }}）
      </button>
    </div>

    <!-- 排序 + 质量概览（AC-106 / AC-108） -->
    <div v-if="sources.sources.length > 0" class="source-manage__sort">
      <span class="source-manage__sort-label">排序</span>
      <SegmentedControl
        :model-value="sortMode"
        :options="SORT_OPTIONS"
        label="源排序方式"
        @update:model-value="changeSortMode"
      />
    </div>
    <p v-if="sources.sources.length > 0 && showTierSummary" class="source-manage__overview">
      共 {{ sources.sources.length }} 条线路
      <template v-for="item in tierSummary" :key="item.tier">
        <span class="source-manage__sep">·</span>
        <span :data-tier="item.tier">{{ item.label }} {{ item.count }}</span>
      </template>
    </p>

    <!-- 批量治理（FIX-01） -->
    <div v-if="sources.sources.length > 0" class="source-manage__batch">
      <button
        class="btn btn--secondary btn--sm"
        type="button"
        :disabled="unhealthyEnabled.length === 0 || batchBusy !== null"
        @click="disableUnhealthy"
      >
        {{ batchBusy === 'disable' ? batchText : `禁用 ${unhealthyEnabled.length} 个失效源` }}
      </button>
      <button
        class="btn btn--secondary btn--sm"
        type="button"
        :disabled="disabledRemovable.length === 0 || batchBusy !== null"
        @click="purgeDisabled"
      >
        {{ batchBusy === 'purge' ? batchText : `清理 ${disabledRemovable.length} 个已禁用源` }}
      </button>
    </div>

    <!-- 自动禁用治理（AC-117） -->
    <section v-if="autoDisabledSources.length > 0" class="source-manage__panel">
      <div class="source-manage__panel-head">
        <span class="source-manage__panel-title">
          已自动禁用（连续体检失败）· {{ autoDisabledSources.length }}
        </span>
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          :disabled="batchBusy !== null"
          @click="restoreAllAutoDisabled"
        >
          {{ batchBusy === 'restore' ? batchText : '全部恢复' }}
        </button>
      </div>
      <ul class="source-manage__panel-list">
        <li
          v-for="source in autoDisabledSources"
          :key="source.id"
          class="source-manage__panel-row"
        >
          <span class="truncate-1">{{ source.name }}</span>
          <button
            class="btn btn--secondary btn--sm"
            type="button"
            :disabled="batchBusy !== null"
            @click="restoreAutoDisabled(source.id)"
          >
            恢复
          </button>
        </li>
      </ul>
    </section>

    <!-- 订阅健康摘要（AC-119） -->
    <section v-if="sources.subscriptionSummaries.length > 0" class="source-manage__panel">
      <div class="source-manage__panel-head">
        <span class="source-manage__panel-title">订阅健康摘要</span>
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          :disabled="refreshingSubscriptions"
          @click="refreshSubscriptions"
        >
          <LoadingSpinner v-if="refreshingSubscriptions" :size="14" />
          {{ refreshingSubscriptions ? '刷新中…' : '全部刷新' }}
        </button>
      </div>
      <ul class="source-manage__panel-list">
        <li
          v-for="summary in sources.subscriptionSummaries"
          :key="summary.subscriptionId"
          class="source-manage__panel-row"
        >
          <span class="source-manage__summary">
            <span class="source-manage__summary-id truncate-1" :title="summary.subscriptionId">
              {{ subscriptionLabel(summary.subscriptionId) }}
            </span>
            <span class="source-manage__summary-meta">
              {{ summary.sourceCount }} 源 · 存活 {{ summary.alive }} · 失效 {{ summary.dead }}
              <template v-if="summary.jarDead > 0"> · jar 失效 {{ summary.jarDead }}</template>
            </span>
          </span>
        </li>
      </ul>
    </section>

    <!-- 源列表 -->
    <div v-if="orderedSources.length > 0" class="source-manage__list">
      <div v-for="source in orderedSources" :key="source.id" class="source-manage__row">
        <button class="source-manage__card" type="button" @click="openEdit(source)">
          <div class="source-manage__info">
            <span class="source-manage__name truncate-1">{{ source.name }}</span>
            <span class="source-manage__meta">
              <span class="source-manage__type">{{ source.type }}</span>
              <HealthBadge
                :health="source.health"
                :tier="tierOf(source)"
                :latency-ms="latencyOf(source.id)"
              />
              <span v-if="source.builtin" class="source-manage__builtin">内置</span>
              <span v-if="source.autoDisabledAt" class="source-manage__auto">已自动禁用</span>
            </span>
          </div>
          <span class="source-manage__addr truncate-1">{{ source.baseUrl }}</span>
        </button>

        <div class="source-manage__controls">
          <ToggleSwitch
            :model-value="source.enabled"
            @update:model-value="toggleSource(source, $event)"
          />
          <button
            v-if="source.type !== 'demo'"
            class="source-manage__menu tap-target"
            type="button"
            aria-label="更多操作"
            aria-haspopup="menu"
            :aria-expanded="menuOpen && menuSource?.id === source.id"
            @click="openMenu(source)"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
              <circle cx="5.5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="18.5" cy="12" r="1.7" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <EmptyState
      v-else
      variant="source"
      title="还没有源"
      description="添加一个你自己的源（AList / WebDAV / Jellyfin / 采集接口 / 站点）"
      action-text="新增源"
      @action="openAdd"
    />

    <!-- 源表单弹层 -->
    <SourceFormSheet
      v-model:open="formOpen"
      :source="editingSource"
      :saving="formSaving"
      :testing="formTesting"
      :test-result="formTestResult"
      @submit="onFormSubmit"
      @test="onFormTest"
      @cancel="onFormCancel"
    />

    <!-- 更多操作菜单 -->
    <BottomSheet v-model="menuOpen" title="源操作">
      <ul v-if="menuSource" class="sheet-list">
        <li v-if="menuSource.type !== 'demo'">
          <button class="sheet-list__item" type="button" @click="menuEdit">编辑</button>
        </li>
        <li v-if="!menuSource.builtin">
          <button class="sheet-list__item" type="button" @click="menuSetDefault">
            设为默认源
          </button>
        </li>
        <li v-if="menuSource.autoDisabledAt">
          <button class="sheet-list__item" type="button" @click="menuRestoreAuto">
            恢复自动禁用（重新启用）
          </button>
        </li>
        <li v-if="!menuSource.builtin">
          <button
            class="sheet-list__item sheet-list__item--danger"
            type="button"
            @click="menuDelete"
          >
            删除
          </button>
        </li>
      </ul>
    </BottomSheet>
  </div>
</template>

<style scoped>
.source-manage {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* 演示源恢复提示（AC-97） */
.source-manage__notice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-warning-soft);
}

.source-manage__notice-text {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-label);
  color: var(--color-text-primary);
}

.source-manage__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.source-manage__sort {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.source-manage__sort-label {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.source-manage__overview {
  display: flex;
  flex-wrap: wrap;
  font: var(--text-caption);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.source-manage__sep {
  margin: 0 var(--space-1);
  color: var(--color-text-tertiary);
}

.source-manage__overview [data-tier='fast'] {
  color: var(--color-tier-fast);
}
.source-manage__overview [data-tier='good'] {
  color: var(--color-success);
}
.source-manage__overview [data-tier='fair'] {
  color: var(--color-warning);
}
.source-manage__overview [data-tier='slow'] {
  color: var(--color-text-secondary);
}
.source-manage__overview [data-tier='bad'] {
  color: var(--color-danger);
}

.source-manage__batch {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* 自动禁用 / 订阅摘要面板 */
.source-manage__panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.source-manage__panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.source-manage__panel-title {
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
}

.source-manage__panel-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.source-manage__panel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 40px;
  font: var(--text-label);
  color: var(--color-text-primary);
}

.source-manage__summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.source-manage__summary-id {
  font: var(--font-weight-medium) 12px / 1.35 var(--font-family-number);
  color: var(--color-text-secondary);
}

.source-manage__summary-meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.source-manage__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.source-manage__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.source-manage__card {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.source-manage__info {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.source-manage__name {
  font: var(--font-weight-semibold) 14px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.source-manage__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  flex: 0 0 auto;
}

.source-manage__type {
  font: var(--font-weight-regular) 10px / 1 var(--font-family-number);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-wide);
}

.source-manage__builtin {
  font: var(--font-weight-regular) 10px / 1 var(--font-family-base);
  color: var(--color-brand-text);
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  background-color: var(--color-brand-soft);
}

.source-manage__auto {
  font: var(--font-weight-regular) 10px / 1 var(--font-family-base);
  color: var(--color-warning);
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  background-color: var(--color-warning-soft);
  white-space: nowrap;
}

.source-manage__addr {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.source-manage__controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.source-manage__menu {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: none;
  border: none;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.source-manage__menu:active {
  background-color: var(--color-overlay-press);
}

/* 复用 SettingsRow 的 sheet-list 样式（由 SettingsView 全局提供） */
.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid var(--color-divider);
  cursor: pointer;
}

.sheet-list__item--danger {
  color: var(--color-danger);
}
</style>
