<script setup lang="ts">
/**
 * 源管理（页面蓝图 §11）
 *
 * 合规提示（固定） → 新增/导入两按钮 → 源卡片列表（健康状态 + 开关 + ⋯ 菜单）。
 * 四态：loading 骨架 / empty（仅演示源时给引导）/ error 错误卡 / offline 横幅。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { Source } from '@/types';
import {
  HEALTH_TIER_LABELS,
  healthTierOf,
  readSourceSortMode,
  sortSources,
  writeSourceSortMode,
} from '@/shared/healthTier';
import type { HealthTier, SourceSortMode } from '@/shared/healthTier';

import AppHeader from '@/components/layout/AppHeader.vue';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import SourceCard from '@/components/source/SourceCard.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { restoreDemoSource } from '@/stores/bootstrap';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const sources = useSourceStore();
const settings = useSettingsStore();
const downloads = useDownloadStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const active = ref<Source | null>(null);
const menuOpen = ref(false);
const healthChecking = ref(false);
const error = ref<string | null>(null);

const loading = computed(() => sources.loading && sources.sources.length === 0);
const isEmpty = computed(() => sources.sources.length === 0);

/** 排序模式（v1.2 / CHG-05 / AC-108）：偏好经 `shared/healthTier` 读写，本页不碰 localStorage key */
const sortMode = ref<SourceSortMode>(readSourceSortMode());
const SORT_OPTIONS = [
  { value: 'manual', label: '手动排序' },
  { value: 'tier', label: '按线路质量' },
];

function changeSortMode(value: string): void {
  const next: SourceSortMode = value === 'tier' ? 'tier' : 'manual';
  if (next === sortMode.value) return;
  sortMode.value = next;
  writeSourceSortMode(next);
  toast.info(next === 'tier' ? '已按线路质量排序' : '已切换为手动排序');
}

/** 延迟统一由 `sourceStore.latencyOf` 代理（UI 不得 import healthService） */
function latencyOf(id: string): number | null {
  return sources.latencyOf(id);
}

function tierOf(source: Source): HealthTier {
  return healthTierOf(source.health, latencyOf(source.id));
}

const ordered = computed(() => sortSources(sources.sources, sortMode.value, latencyOf));

/** 手动顺序：上移/下移始终作用于 `manual` 序列，避免在质量排序下打乱用户的手动顺序 */
const manualOrdered = computed(() => sortSources(sources.sources, 'manual', latencyOf));

/** 线路质量总览（AC-106 六档计数，数据来自 health 快照） */
const tierSummary = computed(() => {
  const counts: Record<HealthTier, number> = { fast: 0, good: 0, fair: 0, slow: 0, bad: 0, unknown: 0 };
  for (const source of sources.sources) counts[tierOf(source)] += 1;
  const order: HealthTier[] = ['fast', 'good', 'fair', 'slow', 'bad'];
  return order.map((tier) => ({ tier, label: HEALTH_TIER_LABELS[tier], count: counts[tier] }));
});

/** 至少有一个源检测过（非 unknown）才展示总览，避免首屏出现"全部未检测 0"的噪音 */
const showTierSummary = computed(() => sources.sources.some((source) => source.health !== 'unknown'));

/** 确定失效且仍启用的源（一键禁用目标；「连接超时」可能是瞬时网络慢，保留） */
const unhealthyEnabled = computed(() =>
  sources.sources.filter(
    (source) =>
      source.enabled &&
      source.healthCheckedAt !== null &&
      (source.health === 'unreachable' ||
        source.health === 'bad_config' ||
        source.health === 'auth_failed'),
  ),
);
const disablingUnhealthy = ref(false);

/** 一键禁用失效源（爬虫订阅场景：体检后隔离死源），确认后批量执行 */
async function disableUnhealthy(): Promise<void> {
  const targets = unhealthyEnabled.value;
  if (targets.length === 0 || disablingUnhealthy.value) return;
  const names = targets.slice(0, 3).map((s) => `「${s.name}」`).join('、');
  const ok = await ui.confirm({
    title: '禁用全部失效源？',
    message: `将禁用 ${targets.length} 个检测失效的源：${names}${targets.length > 3 ? ' 等' : ''}。「连接超时」的源可能是临时网络慢，不会被禁用；被禁用的源可随时重新启用。`,
    confirmText: '禁用',
  });
  if (!ok) return;
  disablingUnhealthy.value = true;
  try {
    const disabled = await sources.disableUnhealthy();
    // 默认源被批量禁用时，切到第一个可用源（与单源禁用同口径）
    if (defaultSourceId.value !== null && !sources.enabledSources.some((s) => s.id === defaultSourceId.value)) {
      const next = sources.enabledSources.find((s) => !s.builtin) ?? sources.enabledSources[0] ?? null;
      await settings.update({ defaultSourceId: next?.id ?? null });
    }
    toast.success(`已禁用 ${disabled} 个失效源`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    disablingUnhealthy.value = false;
  }
}

/** 进度文案（AC-107 / 17.5.2）：`检测中 12/49`，无进度时回落到 `检测中…` */
const progressText = computed(() => {
  const progress = sources.healthProgress;
  if (!progress || progress.done >= progress.total) return '检测中…';
  return `检测中 ${progress.done}/${progress.total}`;
});

const defaultSourceId = computed(() => settings.settings?.defaultSourceId ?? sources.defaultSource?.id ?? null);

/**
 * 演示源状态（REV-14 / FR-43 / AC-97）
 * 「恢复演示源」仅在内置源被禁用或被清空时可见；正常可用时不打扰用户。
 */
const demoSource = computed(() => sources.sources.find((s) => s.builtin && s.type === 'demo') ?? null);
const demoNeedsRestore = computed(() => demoSource.value === null || !demoSource.value.enabled);
const restoringDemo = ref(false);

onMounted(async () => {
  try {
    await Promise.all([sources.load(), settings.load(), downloads.load()]);
    void checkHealth();
  } catch (e) {
    error.value = toErrorShape(e).message;
  }
});

async function checkHealth(): Promise<void> {
  if (isOffline.value) {
    toast.info('当前离线，健康状态可能不准确');
  }
  healthChecking.value = true;
  try {
    await sources.refreshHealth();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    healthChecking.value = false;
  }
}

async function toggle(source: Source, enabled: boolean): Promise<void> {
  try {
    await sources.setEnabled(source.id, enabled);
    if (!enabled && defaultSourceId.value === source.id) {
      // 禁用默认源：回退到第一个已启用源（AC-07）
      const next = sources.enabledSources.find((s) => s.id !== source.id) ?? null;
      await settings.update({ defaultSourceId: next?.id ?? null });
      toast.info(`已禁用「${source.name}」，默认源已切换`);
      return;
    }
    toast.success(enabled ? `已启用「${source.name}」` : `已禁用「${source.name}」`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function openMenu(source: Source): void {
  active.value = source;
  menuOpen.value = true;
}

function edit(source: Source): void {
  menuOpen.value = false;
  void router.push({ name: 'source-edit', params: { id: source.id } });
}

async function setDefault(): Promise<void> {
  const source = active.value;
  if (!source) return;
  menuOpen.value = false;
  try {
    await settings.update({ defaultSourceId: source.id });
    toast.success(`已将「${source.name}」设为默认源`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function move(direction: -1 | 1): Promise<void> {
  const source = active.value;
  if (!source) return;
  menuOpen.value = false;
  // 手动顺序是唯一真值：质量排序下也按 manual 序列移动（AC-108 的 manual 语义不变）
  const list = [...manualOrdered.value];
  const idx = list.findIndex((s) => s.id === source.id);
  const target = idx + direction;
  if (idx < 0 || target < 0 || target >= list.length) {
    toast.info('已到边界');
    return;
  }
  const a = list[idx];
  const b = list[target];
  if (!a || !b) return;
  [list[idx], list[target]] = [b, a];
  try {
    await sources.reorder(list.map((s) => s.id));
    toast.success('排序已更新');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function remove(): Promise<void> {
  const source = active.value;
  if (!source) return;
  menuOpen.value = false;
  if (source.builtin) {
    toast.info('内置源不可删除，只能禁用');
    return;
  }
  const taskCount = downloads.tasks.filter((t) => t.sourceId === source.id).length;
  const ok = await ui.confirm({
    title: `删除「${source.name}」？`,
    message:
      taskCount > 0
        ? `该源有 ${taskCount} 个下载任务，删除源不会自动删除已下载文件，请到下载页单独清理。`
        : '删除后将无法从该源浏览内容，收藏与历史会保留。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    // v1.1 / CHG-01：真实删除；下载任务默认保留（已落盘文件由下载页单独清理）
    await sources.remove(source.id);
    active.value = null;
    toast.success(`已删除「${source.name}」`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function goNew(): void {
  void router.push('/settings/sources/new');
}

function goImport(): void {
  void router.push('/settings/sources/import');
}

/**
 * 恢复演示源（AC-97 后半段）：`seedService.restoreDemo()` 经 `@/stores/bootstrap` 调用，
 * 内部强制启用 + 幂等补齐条目（不重复插入），成功后 `sources:changed` 触发 Store 重载。
 */
async function restoreDemo(): Promise<void> {
  if (restoringDemo.value) return;
  restoringDemo.value = true;
  try {
    const source = await restoreDemoSource();
    await sources.load();
    toast.success(`已恢复「${source.name}」并补齐演示条目`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    restoringDemo.value = false;
  }
}


async function retry(): Promise<void> {
  error.value = null;
  await sources.load();
}
</script>

<template>
  <main class="sources-page" data-route="sources">
    <AppHeader title="片源管理" back>
      <template #actions>
        <button class="sources-add" type="button" aria-label="新增源" @click="goNew">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </template>
    </AppHeader>

    <div class="sources-body">
      <ComplianceNotice />

      <OfflineBanner v-if="isOffline" text="离线模式，健康状态可能不准确" />

      <!-- 恢复演示源（REV-14 / AC-97）：仅内置演示源被禁用或被清理时可见 -->
      <button
        v-if="demoNeedsRestore"
        class="sources-restore"
        type="button"
        :disabled="restoringDemo"
        @click="restoreDemo"
      >
        <LoadingSpinner v-if="restoringDemo" :size="16" />
        {{ restoringDemo ? '正在恢复…' : '恢复演示源' }}
      </button>

      <div class="sources-actions">
        <button class="btn btn--secondary btn--md sources-actions__btn" type="button" @click="goNew">
          新增源
        </button>
        <button class="btn btn--secondary btn--md sources-actions__btn" type="button" @click="goImport">
          导入订阅
        </button>
        <button
          class="btn btn--ghost btn--md sources-actions__refresh"
          type="button"
          :disabled="healthChecking"
          @click="checkHealth"
        >
          <LoadingSpinner v-if="healthChecking" :size="16" />
          {{ healthChecking ? progressText : '重新检测' }}
        </button>
      </div>

      <!-- 排序模式切换（CHG-05 / AC-108）：手动排序 ↔ 按线路质量，偏好经 shared/healthTier 持久化 -->
      <div v-if="!loading && !error && !isEmpty" class="sources-sort">
        <span class="sources-sort__label">排序</span>
        <SegmentedControl
          :model-value="sortMode"
          :options="SORT_OPTIONS"
          label="排序方式"
          @update:model-value="changeSortMode"
        />
      </div>

      <!-- 线路质量总览（CHG-05 / AC-106）：六档计数，仅在已有检测结果时展示 -->
      <div v-if="!loading && !error && !isEmpty && showTierSummary" class="sources-overview" aria-live="polite">
        <p class="sources-overview__text">
          <span>共 {{ sources.sources.length }} 条线路</span>
          <template v-for="item in tierSummary" :key="item.tier">
            <span class="sources-overview__sep" aria-hidden="true"> · </span>
            <span class="sources-overview__item" :data-tier="item.tier">{{ item.label }} {{ item.count }}</span>
          </template>
        </p>
        <!-- 一键隔离失效源：仅存在确定失效且仍启用的源时出现 -->
        <button
          v-if="unhealthyEnabled.length > 0"
          class="btn btn--secondary btn--sm sources-overview__disable"
          type="button"
          :disabled="disablingUnhealthy || healthChecking"
          @click="disableUnhealthy"
        >
          <LoadingSpinner v-if="disablingUnhealthy" :size="14" />
          禁用 {{ unhealthyEnabled.length }} 个失效源
        </button>
      </div>

      <div v-if="loading" class="sources-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在读取源…</span>
      </div>

      <ErrorState
        v-else-if="error"
        :error="{ code: 'E_DB', message: error, detail: null, retryable: true, httpStatus: null }"
        @retry="retry"
      />

      <template v-else>
        <ul v-if="!isEmpty" class="sources-list">
          <li v-for="source in ordered" :key="source.id">
            <SourceCard
              :source="source"
              :is-default="defaultSourceId === source.id"
              :checking="healthChecking"
              :tier="tierOf(source)"
              :latency-ms="latencyOf(source.id)"
              @select="edit"
              @toggle="toggle"
              @menu="openMenu"
            />
          </li>
        </ul>

        <EmptyState
          v-else
          variant="source"
          title="还没有配置源"
          description="添加你自己的源，或从订阅链接导入"
          action-text="新增源"
          @action="goNew"
        />

        <div v-if="ordered.length <= 1" class="sources-guide">
          <p class="sources-guide__title">添加你自己的源</p>
          <p class="sources-guide__desc">
            支持 AList、WebDAV、Jellyfin 与 TVBox 兼容站点。请仅添加你拥有访问权限的源。
          </p>
          <div class="sources-guide__actions">
            <button class="btn btn--primary btn--md" type="button" @click="goNew">新增源</button>
            <button class="btn btn--secondary btn--md" type="button" @click="goImport">导入订阅</button>
          </div>
        </div>
      </template>
    </div>

    <BottomSheet v-model="menuOpen" :title="active?.name ?? '源操作'">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="active && edit(active)">编辑</button></li>
        <li>
          <button class="sheet-list__item" type="button" :disabled="!active?.enabled" @click="setDefault">
            设为默认源
          </button>
        </li>
        <li><button class="sheet-list__item" type="button" @click="move(-1)">上移</button></li>
        <li><button class="sheet-list__item" type="button" @click="move(1)">下移</button></li>
        <li>
          <button
            class="sheet-list__item sheet-list__item--danger"
            type="button"
            :disabled="active?.builtin"
            @click="remove"
          >
            {{ active?.builtin ? '内置源不可删除' : '删除源' }}
          </button>
        </li>
      </ul>
    </BottomSheet>
  </main>
</template>

<style scoped>
.sources-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.sources-add {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-primary);
}

.sources-add svg {
  width: 22px;
  height: 22px;
}

.sources-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.sources-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.sources-restore {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  margin-top: var(--space-3);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  border: var(--border-strong);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--text-button-sm);
}

.sources-restore:disabled {
  color: var(--color-text-disabled);
  background-color: var(--color-bg-surface);
}

.sources-actions__btn {
  flex: 1 1 0;
}

.sources-actions__refresh {
  flex: 0 0 auto;
}

/* 线路质量总览 + 排序切换（CHG-05） */
.sources-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.sources-overview__text {
  font: var(--text-caption);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

/* 一键禁用失效源：窄条对齐总览文字 */
.sources-overview__disable {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.sources-overview__sep {
  color: var(--color-text-tertiary);
}

.sources-overview__item[data-tier='fast'] {
  color: var(--color-tier-fast);
}

.sources-overview__item[data-tier='good'] {
  color: var(--color-success);
}

.sources-overview__item[data-tier='fair'] {
  color: var(--color-warning);
}

.sources-overview__item[data-tier='slow'] {
  color: var(--color-text-secondary);
}

.sources-overview__item[data-tier='bad'] {
  color: var(--color-danger);
}

.sources-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.sources-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.sources-guide {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-5);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px dashed var(--color-border-strong);
  background-color: var(--color-bg-surface);
}

.sources-guide__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.sources-guide__desc {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.sources-guide__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.sheet-list__item:disabled {
  color: var(--color-text-disabled);
}

.sheet-list__item--danger {
  color: var(--color-danger);
}
</style>
