<script setup lang="ts">
/**
 * EXT-06/FR-69：频道分组管理弹层
 *
 * - 分组上限 LIVE_GROUP_MAX（20）、组名 1~LIVE_GROUP_NAME_MAX（10）字符、禁止重名与保留名
 * - 当前频道可分配到某一个分组，或移出自定义分组（回到源分组）
 * - 分组数据按 liveSourceId 隔离（AC-165）
 * - REV-22：分组可上移/下移（`reorderGroups` 整表覆盖），并可一键清理失效排序项
 *   （`countOrphans` 统计 → `prune` 清理，计数为 0 时按钮禁用）
 * - 空态：尚无自定义分组 → 引导输入框（输入框始终可见）
 */
import { computed, ref, watch } from 'vue';

import type { ChannelPrefs } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { LIVE_GROUP_MAX, LIVE_GROUP_NAME_MAX } from '@/shared/constants';
import { toErrorShape } from '@/shared/errors';
import { channelPrefsService } from '@/services/channelPrefsService';

const props = defineProps<{
  modelValue: boolean;
  liveSourceId: string;
  prefs: ChannelPrefs | null;
  /** 当前频道 */
  channelKey: string;
  channelName: string;
  /** REV-22：当前源「仍存在」的频道身份键（用于统计/清理失效排序项） */
  channelKeys?: string[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'changed'): void;
}>();

const busy = ref(false);
const errorText = ref<string | null>(null);
const newName = ref('');
/** 正在重命名的分组 id 与草稿名 */
const renamingId = ref<string | null>(null);
const renameDraft = ref('');
/** REV-22：失效排序项数量（排序列表里已不存在的频道） */
const orphanCount = ref(0);
/** REV-22：清理结果提示 */
const notice = ref<string | null>(null);

const groups = computed(() => props.prefs?.groups ?? []);

/** 分组内频道数（按 assignments 统计） */
const counts = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  const assignments = props.prefs?.assignments ?? {};
  for (const groupId of Object.values(assignments)) {
    result[groupId] = (result[groupId] ?? 0) + 1;
  }
  return result;
});

const currentGroupId = computed(() => props.prefs?.assignments[props.channelKey] ?? null);

const reachedLimit = computed(() => groups.value.length >= LIVE_GROUP_MAX);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorText.value = null;
      notice.value = null;
      newName.value = '';
      renamingId.value = null;
    }
    void refreshOrphans();
  },
  { immediate: true },
);

/** REV-22：统计失效排序项（已不存在的频道留下的排序/归属项） */
async function refreshOrphans(): Promise<void> {
  if (!props.liveSourceId) {
    orphanCount.value = 0;
    return;
  }
  try {
    orphanCount.value = await channelPrefsService.countOrphans(
      props.liveSourceId,
      props.channelKeys ?? [],
    );
  } catch {
    orphanCount.value = 0;
  }
}

async function run(task: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorText.value = null;
  try {
    await task();
    emit('changed');
    await refreshOrphans();
  } catch (e) {
    errorText.value = toErrorShape(e).message;
  } finally {
    busy.value = false;
  }
}

/** REV-22：分组上移/下移（整表覆盖，越界即忽略） */
function moveGroup(groupId: string, delta: -1 | 1): void {
  const ids = groups.value.map((group) => group.id);
  const from = ids.indexOf(groupId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  void run(() => channelPrefsService.reorderGroups(props.liveSourceId, next));
}

/** REV-22：清理失效排序项（计数为 0 时禁用） */
function pruneOrphans(): void {
  if (orphanCount.value === 0) return;
  void run(async () => {
    const result = await channelPrefsService.prune(props.liveSourceId, props.channelKeys ?? []);
    notice.value = `已清理 ${result.removedOrders + result.removedAssignments} 项失效记录`;
  });
}

function createGroup(): void {
  const name = newName.value.trim();
  if (name.length === 0) {
    errorText.value = '请输入分组名称';
    return;
  }
  void run(async () => {
    await channelPrefsService.createGroup(props.liveSourceId, name);
    newName.value = '';
  });
}

function startRename(groupId: string, name: string): void {
  renamingId.value = groupId;
  renameDraft.value = name;
}

function commitRename(): void {
  const id = renamingId.value;
  if (!id) return;
  const name = renameDraft.value.trim();
  const group = groups.value.find((item) => item.id === id);
  renamingId.value = null;
  if (!group || name === group.name) return;
  void run(() => channelPrefsService.renameGroup(props.liveSourceId, id, name));
}

function removeGroup(groupId: string): void {
  void run(() => channelPrefsService.removeGroup(props.liveSourceId, groupId));
}

function assignTo(groupId: string): void {
  void run(() => channelPrefsService.assign(props.liveSourceId, props.channelKey, groupId));
}

function removeFromGroup(): void {
  void run(async () => {
    await channelPrefsService.assign(props.liveSourceId, props.channelKey, null);
  });
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="分组管理"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="groups">
      <p class="groups__current truncate-1">当前频道：{{ channelName || '未选择' }}</p>

      <p v-if="errorText" class="groups__error" role="alert">{{ errorText }}</p>

      <!-- 新建分组 -->
      <div class="groups__create">
        <input
          v-model="newName"
          class="field__input groups__input"
          type="text"
          :maxlength="LIVE_GROUP_NAME_MAX"
          :placeholder="`新建分组（≤${LIVE_GROUP_NAME_MAX} 字）`"
          :disabled="busy || reachedLimit"
          @keydown.enter.prevent="createGroup"
        />
        <button
          class="btn btn--primary btn--sm groups__create-btn"
          type="button"
          :disabled="busy || reachedLimit || newName.trim().length === 0"
          @click="createGroup"
        >
          新建
        </button>
      </div>
      <p v-if="reachedLimit" class="groups__hint">已达分组上限（{{ LIVE_GROUP_MAX }} 个）</p>
      <p v-else class="groups__hint">已用 {{ groups.length }} / {{ LIVE_GROUP_MAX }} 个分组</p>

      <!-- 空态 -->
      <p v-if="groups.length === 0" class="groups__empty">
        还没有自定义分组。新建分组后，可把频道拖入分组并单独排序。
      </p>

      <ul v-else class="groups__list">
        <li v-for="group in groups" :key="group.id" class="groups__row">
          <template v-if="renamingId === group.id">
            <input
              v-model="renameDraft"
              class="field__input groups__input"
              type="text"
              :maxlength="LIVE_GROUP_NAME_MAX"
              @keydown.enter.prevent="commitRename"
            />
            <button class="btn btn--primary btn--sm" type="button" :disabled="busy" @click="commitRename">
              保存
            </button>
            <button class="btn btn--ghost btn--sm" type="button" @click="renamingId = null">取消</button>
          </template>
          <template v-else>
            <button
              class="groups__name"
              :class="{ 'groups__name--on': group.id === currentGroupId }"
              type="button"
              :aria-pressed="group.id === currentGroupId"
              :disabled="busy"
              @click="assignTo(group.id)"
            >
              <span class="truncate-1">{{ group.name }}</span>
              <span class="groups__count">{{ counts[group.id] ?? 0 }}</span>
            </button>
            <button
              class="groups__move"
              type="button"
              aria-label="分组上移"
              :disabled="busy || groups[0]?.id === group.id"
              @click="moveGroup(group.id, -1)"
            >
              ↑
            </button>
            <button
              class="groups__move"
              type="button"
              aria-label="分组下移"
              :disabled="busy || groups[groups.length - 1]?.id === group.id"
              @click="moveGroup(group.id, 1)"
            >
              ↓
            </button>
            <button class="btn btn--ghost btn--sm" type="button" :disabled="busy" @click="startRename(group.id, group.name)">
              重命名
            </button>
            <button
              class="btn btn--ghost btn--sm groups__danger"
              type="button"
              :disabled="busy"
              @click="removeGroup(group.id)"
            >
              删除
            </button>
          </template>
        </li>
      </ul>

      <p v-if="notice" class="groups__notice" role="status">{{ notice }}</p>
      <button
        class="btn btn--secondary btn--md groups__prune"
        type="button"
        :disabled="busy || orphanCount === 0"
        @click="pruneOrphans"
      >
        清理失效排序项（{{ orphanCount }}）
      </button>

      <button
        v-if="currentGroupId"
        class="btn btn--secondary btn--md groups__leave"
        type="button"
        :disabled="busy"
        @click="removeFromGroup"
      >
        移出自定义分组
      </button>

      <p class="groups__note">
        删除分组不会删除频道，组内频道会回到「未分组」；分组仅保存在本机，不随备份同步。
      </p>

      <LoadingSpinner v-if="busy" class="groups__spinner" :size="18" />
    </div>
  </BottomSheet>
</template>

<style scoped>
.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.groups__current {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.groups__error {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  font: var(--text-caption);
  color: var(--color-text-primary);
}

.groups__create {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.groups__input {
  flex: 1 1 auto;
  min-width: 0;
}

.groups__create-btn {
  flex: 0 0 auto;
}

.groups__hint,
.groups__note {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.groups__empty {
  padding: var(--space-4) 0;
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.groups__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  list-style: none;
  margin: 0;
  padding: 0;
}

.groups__row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 44px;
}

.groups__name {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-body);
  text-align: left;
}

.groups__name--on {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  color: var(--color-brand-text);
}

.groups__count {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-number);
}

.groups__danger {
  color: var(--color-danger);
}

/* REV-22：分组上下移 */
.groups__move {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-secondary);
  font: var(--text-caption);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.groups__move:active:not(:disabled) {
  background-color: var(--color-bg-pressed);
}

.groups__move:disabled {
  opacity: 0.4;
  cursor: default;
}

.groups__notice {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.groups__prune {
  width: 100%;
}

.groups__leave {
  margin-top: var(--space-2);
  width: 100%;
}

.groups__spinner {
  align-self: center;
}
</style>
