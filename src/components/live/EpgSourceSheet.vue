<script setup lang="ts">
/**
 * EXT-06/FR-66：多 EPG 源管理弹层
 *
 * - 列出全部源（按优先级升序）：名称 / 地址 / 协议 / 匹配模式 / 最近错误
 * - 启用开关（启用数 ≤ limits.maxEnabled）、优先级上移下移、编辑、删除
 * - 新增：先探测（epgSourceService.add 内部探测后才落库），失败不落库（AC-156）
 * - 内置源不可删除（按钮禁用 + 说明，AC-156）
 * - 空/加载/错误/超限四态齐备（AC-155 上限提示）
 */
import { computed, onMounted, ref, watch } from 'vue';

import type { EpgMatchMode, EpgProtocol, EpgSource, EpgSourceLimits } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { toErrorShape } from '@/shared/errors';
import { epgSourceService } from '@/services/epgSourceService';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 源集合变化后通知父级重拉节目单 */
  (e: 'changed'): void;
}>();

const PROTOCOLS: Array<{ value: EpgProtocol; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'diyp', label: 'DIYP' },
  { value: 'xmltv', label: 'XMLTV' },
];

const MATCH_MODES: Array<{ value: EpgMatchMode; label: string }> = [
  { value: 'auto', label: '四级自动' },
  { value: 'xmltv-id', label: '仅 tvg-id' },
  { value: 'channel-name', label: '仅频道名' },
];

const loading = ref(false);
const busy = ref(false);
const errorText = ref<string | null>(null);
const sources = ref<EpgSource[]>([]);
const limits = ref<EpgSourceLimits>({ maxSources: 10, maxEnabled: 3 });

// 新增表单
const formOpen = ref(false);
const formName = ref('');
const formEndpoint = ref('');
const formProtocol = ref<EpgProtocol>('auto');
const formMatchMode = ref<EpgMatchMode>('auto');
const probing = ref(false);
const probeText = ref<string | null>(null);

// 编辑
const editingId = ref<string | null>(null);
const editName = ref('');
const editEndpoint = ref('');
const editProtocol = ref<EpgProtocol>('auto');
const editMatchMode = ref<EpgMatchMode>('auto');

const enabledCount = computed(() => sources.value.filter((source) => source.enabled).length);
const userCount = computed(() => sources.value.filter((source) => !source.builtin).length);
const atSourceLimit = computed(() => userCount.value >= limits.value.maxSources);
const atEnabledLimit = computed(() => enabledCount.value >= limits.value.maxEnabled);

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = null;
  try {
    const [list, nextLimits] = await Promise.all([epgSourceService.list(), epgSourceService.limits()]);
    sources.value = list;
    limits.value = nextLimits;
  } catch (e) {
    errorText.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}

async function run(task: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorText.value = null;
  try {
    await task();
    await load();
    emit('changed');
  } catch (e) {
    errorText.value = toErrorShape(e).message;
  } finally {
    busy.value = false;
  }
}

function toggleEnabled(source: EpgSource): void {
  const next = !source.enabled;
  if (next && atEnabledLimit.value) {
    errorText.value = `最多同时启用 ${limits.value.maxEnabled} 个 EPG 源，请先停用其他源`;
    return;
  }
  void run(() => epgSourceService.update(source.id, { enabled: next }));
}

function move(source: EpgSource, delta: number): void {
  const ids = sources.value.map((item) => item.id);
  const from = ids.indexOf(source.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, source.id);
  void run(() => epgSourceService.reorder(next));
}

function startEdit(source: EpgSource): void {
  editingId.value = source.id;
  editName.value = source.name;
  editEndpoint.value = source.endpoint;
  editProtocol.value = source.protocol;
  editMatchMode.value = source.matchMode;
}

function commitEdit(): void {
  const id = editingId.value;
  if (!id) return;
  editingId.value = null;
  void run(() =>
    epgSourceService.update(id, {
      name: editName.value,
      endpoint: editEndpoint.value,
      protocol: editProtocol.value,
      matchMode: editMatchMode.value,
    }),
  );
}

function removeSource(source: EpgSource): void {
  void run(() => epgSourceService.remove(source.id));
}

function resetForm(): void {
  formName.value = '';
  formEndpoint.value = '';
  formProtocol.value = 'auto';
  formMatchMode.value = 'auto';
  probeText.value = null;
  errorText.value = null;
}

async function submitForm(): Promise<void> {
  if (probing.value || busy.value) return;
  probing.value = true;
  probeText.value = null;
  errorText.value = null;
  try {
    const created = await epgSourceService.add({
      name: formName.value,
      endpoint: formEndpoint.value,
      protocol: formProtocol.value,
      matchMode: formMatchMode.value,
    });
    probeText.value = `探测通过：${created.name}`;
    formOpen.value = false;
    resetForm();
    await load();
    emit('changed');
  } catch (e) {
    probeText.value = null;
    errorText.value = toErrorShape(e).message;
  } finally {
    probing.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorText.value = null;
      probeText.value = null;
      formOpen.value = false;
      editingId.value = null;
      resetForm();
      void load();
    }
  },
);

onMounted(() => {
  if (props.modelValue) void load();
});
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="EPG 源管理"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="epg-src">
      <p class="epg-src__meta">
        已启用 {{ enabledCount }} / {{ limits.maxEnabled }}，已添加 {{ userCount }} / {{ limits.maxSources }}
      </p>

      <p v-if="errorText" class="epg-src__error" role="alert">{{ errorText }}</p>
      <p v-if="probeText" class="epg-src__ok" role="status">{{ probeText }}</p>

      <div v-if="loading" class="epg-src__state" role="status">
        <LoadingSpinner :size="20" />
        <span>正在读取 EPG 源…</span>
      </div>

      <div v-else-if="sources.length === 0" class="epg-src__state">
        <p>暂无 EPG 源</p>
        <p class="epg-src__hint">添加一个 DIYP 或 XMLTV 地址后即可合并节目单</p>
      </div>

      <ul v-else class="epg-src__list">
        <li v-for="(source, idx) in sources" :key="source.id" class="epg-src__row">
          <template v-if="editingId === source.id">
            <input v-model="editName" class="field__input" type="text" maxlength="20" placeholder="名称" />
            <input v-model="editEndpoint" class="field__input" type="url" placeholder="EPG 地址" />
            <div class="epg-src__picks">
              <select v-model="editProtocol" class="field__input epg-src__select" aria-label="协议">
                <option v-for="item in PROTOCOLS" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
              <select v-model="editMatchMode" class="field__input epg-src__select" aria-label="匹配模式">
                <option v-for="item in MATCH_MODES" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </div>
            <div class="epg-src__actions">
              <button class="btn btn--primary btn--sm" type="button" :disabled="busy" @click="commitEdit">
                保存
              </button>
              <button class="btn btn--ghost btn--sm" type="button" @click="editingId = null">取消</button>
            </div>
          </template>

          <template v-else>
            <div class="epg-src__head">
              <span class="epg-src__name truncate-1">{{ source.name }}</span>
              <span v-if="source.builtin" class="epg-src__tag">内置</span>
              <span class="epg-src__prio">#{idx + 1}</span>
            </div>
            <p class="epg-src__endpoint truncate-1">{{ source.endpoint }}</p>
            <p class="epg-src__props">
              {{ PROTOCOLS.find((p) => p.value === source.protocol)?.label ?? source.protocol }} ·
              {{ MATCH_MODES.find((m) => m.value === source.matchMode)?.label ?? source.matchMode }}
            </p>
            <p v-if="source.lastError" class="epg-src__last-error truncate-1">最近错误：{{ source.lastError }}</p>

            <div class="epg-src__actions">
              <button
                class="epg-src__toggle"
                :class="{ 'epg-src__toggle--on': source.enabled }"
                type="button"
                role="switch"
                :aria-checked="source.enabled"
                :disabled="busy"
                @click="toggleEnabled(source)"
              >
                {{ source.enabled ? '已启用' : '已停用' }}
              </button>
              <button
                class="epg-src__icon"
                type="button"
                aria-label="提高优先级"
                :disabled="busy || idx === 0"
                @click="move(source, -1)"
              >
                ↑
              </button>
              <button
                class="epg-src__icon"
                type="button"
                aria-label="降低优先级"
                :disabled="busy || idx === sources.length - 1"
                @click="move(source, 1)"
              >
                ↓
              </button>
              <button class="epg-src__icon" type="button" :disabled="busy" @click="startEdit(source)">
                编辑
              </button>
              <button
                class="epg-src__icon epg-src__icon--danger"
                type="button"
                :disabled="busy || source.builtin"
                :title="source.builtin ? '内置源不可删除' : '删除'"
                @click="removeSource(source)"
              >
                删除
              </button>
            </div>
          </template>
        </li>
      </ul>

      <!-- 新增 -->
      <template v-if="!formOpen">
        <button
          class="btn btn--secondary btn--md epg-src__add"
          type="button"
          :disabled="atSourceLimit"
          @click="formOpen = true"
        >
          {{ atSourceLimit ? `已达上限（${limits.maxSources} 个）` : '添加 EPG 源' }}
        </button>
      </template>

      <div v-else class="epg-src__form">
        <label class="field__label" for="epg-src-name">名称</label>
        <input
          id="epg-src-name"
          v-model="formName"
          class="field__input"
          type="text"
          maxlength="20"
          placeholder="如：公益 EPG"
        />
        <label class="field__label" for="epg-src-url">EPG 地址（DIYP / XMLTV）</label>
        <input
          id="epg-src-url"
          v-model="formEndpoint"
          class="field__input"
          type="url"
          inputmode="url"
          placeholder="https://example.com/epg.php"
          @keydown.enter.prevent="submitForm"
        />
        <div class="epg-src__picks">
          <select v-model="formProtocol" class="field__input epg-src__select" aria-label="协议">
            <option v-for="item in PROTOCOLS" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
          <select v-model="formMatchMode" class="field__input epg-src__select" aria-label="匹配模式">
            <option v-for="item in MATCH_MODES" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </div>
        <div class="epg-src__actions">
          <button
            class="btn btn--primary btn--sm"
            type="button"
            :disabled="probing || formName.trim().length === 0 || formEndpoint.trim().length === 0"
            @click="submitForm"
          >
            <LoadingSpinner v-if="probing" :size="14" />
            {{ probing ? '正在探测…' : '探测并保存' }}
          </button>
          <button class="btn btn--ghost btn--sm" type="button" :disabled="probing" @click="formOpen = false">
            取消
          </button>
        </div>
        <p class="epg-src__hint">保存前会先探测地址；探测失败不会写入（可用其他源兜底）。</p>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.epg-src {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.epg-src__meta {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.epg-src__error,
.epg-src__ok {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font: var(--text-caption);
}

.epg-src__error {
  background-color: var(--color-danger-soft);
  color: var(--color-text-primary);
}

.epg-src__ok {
  background-color: var(--color-success-soft);
  color: var(--color-text-primary);
}

.epg-src__state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 120px;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  flex-direction: column;
}

.epg-src__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.epg-src__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  margin: 0;
  padding: 0;
}

.epg-src__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.epg-src__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.epg-src__name {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.epg-src__tag {
  flex: 0 0 auto;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--text-caption);
}

.epg-src__prio {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-number);
}

.epg-src__endpoint,
.epg-src__props,
.epg-src__last-error {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.epg-src__last-error {
  color: var(--color-warning);
}

.epg-src__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
  flex-wrap: wrap;
}

.epg-src__toggle {
  min-height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-base);
  border: var(--border-default);
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.epg-src__toggle--on {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  color: var(--color-brand-text);
}

.epg-src__icon {
  min-width: 44px;
  min-height: 32px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.epg-src__icon--danger {
  color: var(--color-danger);
}

.epg-src__icon:disabled {
  color: var(--color-text-disabled);
}

.epg-src__add,
.epg-src__form {
  margin-top: var(--space-2);
}

.epg-src__add {
  width: 100%;
}

.epg-src__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-base);
}

.epg-src__picks {
  display: flex;
  gap: var(--space-2);
}

.epg-src__select {
  flex: 1 1 0;
  min-width: 0;
}
</style>
