<script setup lang="ts">
/**
 * 源管理内联区（OPT-09）
 *
 * 在设置页内就地管理源：列表 + 开关 + 新增/编辑/删除。
 * 复用 SourceCard 展示单源信息，SourceFormSheet 处理表单。
 * 不包含独立路由——所有操作通过 BottomSheet 完成。
 */
import { computed, ref } from 'vue';

import type { Source, SourceInput } from '@/types';

import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import SourceFormSheet from '@/components/source/SourceFormSheet.vue';
import HealthBadge from '@/components/source/HealthBadge.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { useToast } from '@/composables/useToast';
import { toErrorShape } from '@/shared/errors';

const sources = useSourceStore();
const settings = useSettingsStore();
const ui = useUiStore();
const toast = useToast();

/* ---------- 列表展示 ---------- */
const orderedSources = computed(() => {
  return [...sources.sources].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return (a.sort ?? 0) - (b.sort ?? 0);
  });
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
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
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
      const next = sources.enabledSources.find((s) => !s.builtin) ?? sources.enabledSources[0] ?? null;
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

async function menuDelete(): Promise<void> {
  if (!menuSource.value) return;
  const src = menuSource.value;
  closeMenu();
  await deleteSource(src);
}

/* ---------- 健康检查 ---------- */
const healthChecking = ref(false);

async function checkHealth(): Promise<void> {
  healthChecking.value = true;
  try {
    await sources.refreshHealth();
    toast.success('健康检查完成');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    healthChecking.value = false;
  }
}
</script>

<template>
  <div class="source-manage">
    <!-- 合规提示 -->
    <ComplianceNotice />

    <!-- 操作栏：新增 + 健康检查 -->
    <div class="source-manage__actions">
      <button class="btn btn--primary btn--sm" type="button" @click="openAdd">
        新增源
      </button>
      <button
        class="btn btn--secondary btn--sm"
        type="button"
        :disabled="healthChecking || sources.sources.length === 0"
        @click="checkHealth"
      >
        <LoadingSpinner v-if="healthChecking" :size="14" />
        {{ healthChecking ? '检查中…' : '健康检查' }}
      </button>
    </div>

    <!-- 源列表 -->
    <div v-if="orderedSources.length > 0" class="source-manage__list">
      <div
        v-for="source in orderedSources"
        :key="source.id"
        class="source-manage__row"
      >
        <button
          class="source-manage__card"
          type="button"
          @click="openEdit(source)"
        >
          <div class="source-manage__info">
            <span class="source-manage__name truncate-1">{{ source.name }}</span>
            <span class="source-manage__meta">
              <span class="source-manage__type">{{ source.type }}</span>
              <HealthBadge
                :health="source.health"
                :checking="healthChecking"
              />
              <span v-if="source.builtin" class="source-manage__builtin">内置</span>
            </span>
          </div>
          <span class="source-manage__addr truncate-1">{{ source.baseUrl }}</span>
        </button>

        <div class="source-manage__controls">
          <ToggleSwitch
            :model-value="source.enabled"
            :disabled="source.builtin"
            @update:model-value="toggleSource(source, $event)"
          />
          <button
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
      description="添加一个你自己的源（AList / WebDAV / Jellyfin / 站点）"
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
        <li>
          <button class="sheet-list__item" type="button" @click="menuEdit">
            编辑
          </button>
        </li>
        <li v-if="!menuSource.builtin">
          <button class="sheet-list__item" type="button" @click="menuSetDefault">
            设为默认源
          </button>
        </li>
        <li v-if="!menuSource.builtin">
          <button class="sheet-list__item sheet-list__item--danger" type="button" @click="menuDelete">
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

.source-manage__actions {
  display: flex;
  gap: var(--space-2);
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
