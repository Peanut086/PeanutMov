<script setup lang="ts">
/**
 * 筛选弹层（页面蓝图 §3.4）
 *
 * 三组条件：类型 / 年代 / 地区；可组合，底部「重置」+「应用（N）」。
 * 只编辑本地副本，点「应用」才向外 emit，避免每次勾选都触发请求。
 */
import { computed, ref, watch } from 'vue';

import type { LibraryFilters, MediaType } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';

const props = defineProps<{
  modelValue: boolean;
  filters: LibraryFilters;
  /** 可选地区列表（由当前分类数据推导） */
  areas?: string[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'apply', filters: LibraryFilters): void;
  (e: 'reset'): void;
}>();

const TYPE_OPTIONS: Array<{ value: MediaType; label: string }> = [
  { value: 'movie', label: '电影' },
  { value: 'series', label: '剧集' },
  { value: 'anime', label: '动漫' },
  { value: 'variety', label: '综艺' },
  { value: 'other', label: '其它' },
];

const YEAR_OPTIONS: Array<{ key: string; label: string; from: number | null; to: number | null }> = [
  { key: 'all', label: '不限', from: null, to: null },
  { key: '2020', label: '2020 年后', from: 2020, to: null },
  { key: '2010', label: '2010–2019', from: 2010, to: 2019 },
  { key: '2000', label: '2000–2009', from: 2000, to: 2009 },
  { key: '1990', label: '2000 年前', from: null, to: 1999 },
];

const draft = ref<LibraryFilters>({ ...props.filters });

watch(
  () => props.modelValue,
  (open) => {
    if (open) draft.value = { ...props.filters };
  },
);

const activeCount = computed(() => {
  let n = 0;
  if (draft.value.type !== null) n += 1;
  if (draft.value.area !== null) n += 1;
  if (draft.value.yearFrom !== null || draft.value.yearTo !== null) n += 1;
  return n;
});

const yearKey = computed(() => {
  const hit = YEAR_OPTIONS.find(
    (o) => o.from === draft.value.yearFrom && o.to === draft.value.yearTo,
  );
  return hit?.key ?? 'all';
});

const areaOptions = computed(() => {
  const base = props.areas && props.areas.length > 0 ? props.areas : ['中国', '美国', '日本', '韩国', '欧洲'];
  return ['不限', ...base];
});

function setType(type: MediaType | null): void {
  draft.value = { ...draft.value, type: draft.value.type === type ? null : type };
}

function setYear(key: string): void {
  const opt = YEAR_OPTIONS.find((o) => o.key === key);
  if (!opt) return;
  draft.value = { ...draft.value, yearFrom: opt.from, yearTo: opt.to };
}

function setArea(area: string): void {
  draft.value = { ...draft.value, area: area === '不限' ? null : area };
}

function reset(): void {
  draft.value = { type: null, yearFrom: null, yearTo: null, area: null };
  emit('reset');
}

function apply(): void {
  emit('apply', { ...draft.value });
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="筛选"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="filter-group">
      <h3 class="filter-group__title">类型</h3>
      <div class="filter-chips">
        <button
          v-for="opt in TYPE_OPTIONS"
          :key="opt.value"
          class="filter-chip"
          :class="{ 'filter-chip--active': draft.type === opt.value }"
          type="button"
          :aria-pressed="draft.type === opt.value"
          @click="setType(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div class="filter-group">
      <h3 class="filter-group__title">年代</h3>
      <div class="filter-chips">
        <button
          v-for="opt in YEAR_OPTIONS"
          :key="opt.key"
          class="filter-chip"
          :class="{ 'filter-chip--active': yearKey === opt.key }"
          type="button"
          :aria-pressed="yearKey === opt.key"
          @click="setYear(opt.key)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div class="filter-group">
      <h3 class="filter-group__title">地区</h3>
      <div class="filter-chips">
        <button
          v-for="area in areaOptions"
          :key="area"
          class="filter-chip"
          :class="{
            'filter-chip--active':
              (area === '不限' && draft.area === null) || draft.area === area,
          }"
          type="button"
          :aria-pressed="(area === '不限' && draft.area === null) || draft.area === area"
          @click="setArea(area)"
        >
          {{ area }}
        </button>
      </div>
    </div>

    <template #footer>
      <div class="filter-actions">
        <button class="btn btn--secondary btn--md" type="button" @click="reset">重置</button>
        <button class="btn btn--primary btn--md filter-actions__apply" type="button" @click="apply">
          应用{{ activeCount > 0 ? `（${activeCount}）` : '' }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.filter-group + .filter-group {
  margin-top: var(--space-5);
}

.filter-group__title {
  margin-bottom: var(--space-3);
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
}

.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.filter-chip {
  min-height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: 1px solid transparent;
  color: var(--color-text-secondary);
  font: var(--text-label-strong);
  transition: var(--transition-color);
}

.filter-chip--active {
  background-color: var(--color-brand-soft);
  border-color: var(--color-brand);
  color: var(--color-brand-text);
}

.filter-actions {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: var(--space-3);
}

.filter-actions__apply {
  width: 100%;
}
</style>
