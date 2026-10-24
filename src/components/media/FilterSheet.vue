<script setup lang="ts">
/**
 * 筛选弹层（页面蓝图 §3.4，筛选优化版）
 *
 * 两种模式：
 * - 服务端模式：当前分类带源 filter 配置（`dimensions` 非空）时，按源维度渲染，
 *   选中值写入 `filters.ext` 由 site/spider 透传服务端，分页天然对齐；
 * - 本地模式：无配置时渲染通用维度（类型/年代/地区），由服务层聚合分页生效。
 * 年代支持预设档 + 自定义起止。只编辑本地副本，点「应用」才向外 emit。
 */
import { computed, ref, watch } from 'vue';

import type { FilterDimension, LibraryFilters, MediaType } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';

const props = defineProps<{
  modelValue: boolean;
  filters: LibraryFilters;
  /** 当前分类的服务端筛选维度（无配置时不传/为空 → 本地模式） */
  dimensions?: FilterDimension[] | null;
  /** 本地模式地区候选（源缓存推导） */
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
/** 年代是否处于自定义输入模式（区别于「不限」预设） */
const customYearMode = ref(false);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
    draft.value = { ...props.filters, ext: props.filters.ext ? { ...props.filters.ext } : null };
    customYearMode.value =
      props.filters.yearFrom !== null || props.filters.yearTo !== null
        ? !YEAR_OPTIONS.some(
            (o) => o.from === props.filters.yearFrom && o.to === props.filters.yearTo,
          )
        : false;
  }
  },
);

/** 服务端模式：源配置维度 */
const serverDims = computed(() =>
  props.dimensions && props.dimensions.length > 0 ? props.dimensions : null,
);

const activeCount = computed(() => {
  let n = 0;
  if (draft.value.type !== null) n += 1;
  if (draft.value.area !== null) n += 1;
  if (draft.value.yearFrom !== null || draft.value.yearTo !== null) n += 1;
  if (draft.value.ext) n += Object.keys(draft.value.ext).length;
  return n;
});

const yearKey = computed(() => (customYearMode.value ? 'custom' : presetYearKey.value));

const presetYearKey = computed(() => {
  const hit = YEAR_OPTIONS.find(
    (o) => o.from === draft.value.yearFrom && o.to === draft.value.yearTo,
  );
  return hit?.key ?? 'all';
});

/** 自定义年代的输入镜像（空串表示未填） */
const customYearFrom = ref<string>('');
const customYearTo = ref<string>('');

function enterCustomYear(): void {
  if (customYearMode.value) return;
  customYearMode.value = true;
  customYearFrom.value = draft.value.yearFrom !== null ? String(draft.value.yearFrom) : '';
  customYearTo.value = draft.value.yearTo !== null ? String(draft.value.yearTo) : '';
  // 脱离预设档：清空即进入「自定义且未填」状态（不限）
  draft.value = { ...draft.value, yearFrom: null, yearTo: null };
}

function setCustomYear(): void {
  const from = Number.parseInt(customYearFrom.value, 10);
  const to = Number.parseInt(customYearTo.value, 10);
  draft.value = {
    ...draft.value,
    yearFrom: Number.isFinite(from) ? from : null,
    yearTo: Number.isFinite(to) ? to : null,
  };
}

const areaOptions = computed(() => {
  const base = props.areas && props.areas.length > 0 ? props.areas : ['中国', '美国', '日本', '韩国', '欧洲'];
  return ['不限', ...base];
});

function setType(type: MediaType | null): void {
  draft.value = { ...draft.value, type: draft.value.type === type ? null : type };
}

function setYear(key: string): void {
  if (key === 'custom') {
    enterCustomYear();
    return;
  }
  const opt = YEAR_OPTIONS.find((o) => o.key === key);
  if (!opt) return;
  customYearMode.value = false;
  draft.value = { ...draft.value, yearFrom: opt.from, yearTo: opt.to };
}

function setArea(area: string): void {
  draft.value = { ...draft.value, area: area === '不限' ? null : area };
}

/** 服务端维度单选：再次点击已选项 = 清除该维度 */
function setExt(dim: FilterDimension, value: string): void {
  const ext = { ...(draft.value.ext ?? {}) };
  if (ext[dim.key] === value) delete ext[dim.key];
  else ext[dim.key] = value;
  draft.value = { ...draft.value, ext: Object.keys(ext).length > 0 ? ext : null };
}

function extActive(dim: FilterDimension, value: string): boolean {
  return draft.value.ext?.[dim.key] === value;
}

function reset(): void {
  draft.value = { type: null, yearFrom: null, yearTo: null, area: null, ext: null };
  customYearMode.value = false;
  customYearFrom.value = '';
  customYearTo.value = '';
  emit('reset');
}

function apply(): void {
  emit('apply', { ...draft.value, ext: draft.value.ext ? { ...draft.value.ext } : null });
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="筛选"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 服务端模式：按源配置维度渲染 -->
    <template v-if="serverDims">
      <div v-for="dim in serverDims" :key="dim.key" class="filter-group">
        <h3 class="filter-group__title">{{ dim.name }}</h3>
        <div class="filter-chips">
          <button
            v-for="opt in dim.options"
            :key="opt.value"
            class="filter-chip"
            :class="{ 'filter-chip--active': extActive(dim, opt.value) }"
            type="button"
            :aria-pressed="extActive(dim, opt.value)"
            @click="setExt(dim, opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </template>

    <!-- 本地模式：通用维度 -->
    <template v-else>
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
          <button
            class="filter-chip"
            :class="{ 'filter-chip--active': yearKey === 'custom' }"
            type="button"
            :aria-pressed="yearKey === 'custom'"
            @click="setYear('custom')"
          >
            自定义
          </button>
        </div>
        <div v-if="yearKey === 'custom'" class="filter-year-custom">
          <input
            v-model="customYearFrom"
            class="filter-year-custom__input"
            type="number"
            inputmode="numeric"
            min="1900"
            :max="customYearTo || new Date().getFullYear()"
            placeholder="起始年"
            aria-label="起始年份"
            @input="setCustomYear"
          />
          <span class="filter-year-custom__sep">—</span>
          <input
            v-model="customYearTo"
            class="filter-year-custom__input"
            type="number"
            inputmode="numeric"
            :min="customYearFrom || 1900"
            :max="new Date().getFullYear()"
            placeholder="结束年"
            aria-label="结束年份"
            @input="setCustomYear"
          />
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
    </template>

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

.filter-year-custom {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.filter-year-custom__input {
  width: 110px;
  min-height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-divider);
  background-color: var(--color-bg-surface);
  color: var(--color-text-primary);
  font: var(--text-body);
}

.filter-year-custom__sep {
  color: var(--color-text-tertiary);
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
