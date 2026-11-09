<script setup lang="ts">
/**
 * 运行日志查看页（P0-P3）
 *
 * 功能：
 * - 实时查看日志（1s 轮询原生文件尾部）
 * - 级别/标签/关键字过滤
 * - 暂停/自动滚动/复制/分享/清空
 * - 选择日期文件
 * - 错误/崩溃高亮
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type { LogLevel } from '@/shared/logLine';
import {
  extractTags,
  filterByLevel,
  filterByTag,
  formatEntry,
  parseLogText,
  search,
} from '@/shared/logLine';
import { logApi, type DebugLogStatus, type LogFile } from '@/native/logs';
import { useToast } from '@/composables/useToast';
import { toErrorShape } from '@/shared/errors';
import { isNative } from '@/shared/platform';
import { Share } from '@capacitor/share';
import { getBuffer } from '@/shared/logBus';

import AppHeader from '@/components/layout/AppHeader.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';

const toast = useToast();

// 状态
const loading = ref(true);
const error = ref<string | null>(null);
const status = ref<DebugLogStatus>({
  enabled: false,
  fileCount: 0,
  totalBytes: 0,
  retentionDays: 3,
});
const files = ref<LogFile[]>([]);
const selectedFile = ref<string>('');
const entries = ref<ReturnType<typeof parseLogText>>([]);
const cursor = ref({ file: '', offset: 0 });
const paused = ref(false);
const autoScroll = ref(true);
const pollTimer = ref<number | null>(null);

// 过滤
const levelFilter = ref<Set<LogLevel>>(new Set());
const tagFilter = ref<Set<string>>(new Set());
const keyword = ref('');
const tagSheetOpen = ref(false);
const dateSheetOpen = ref(false);
const errorOnly = ref(false);
const startTime = ref('');
const endTime = ref('');

// 清空确认
const clearOpen = ref(false);

// 列表容器引用（用于自动滚动）
const listRef = ref<HTMLElement | null>(null);

// 计算属性
const allTags = computed(() => extractTags(entries.value));
const filteredEntries = computed(() => {
  let result = entries.value;
  if (errorOnly.value) {
    result = result.filter((e) => e.level === 'E' || e.level === 'F');
  } else {
    if (levelFilter.value.size > 0) {
      result = filterByLevel(result, levelFilter.value);
    }
    if (tagFilter.value.size > 0) {
      result = filterByTag(result, tagFilter.value);
    }
  }
  if (keyword.value) {
    result = search(result, keyword.value);
  }
  // 时间范围筛选
  if (startTime.value) {
    const startTs = new Date(startTime.value).getTime();
    if (!isNaN(startTs)) {
      result = result.filter((e) => e.ts >= startTs);
    }
  }
  if (endTime.value) {
    const endTs = new Date(endTime.value).getTime();
    if (!isNaN(endTs)) {
      result = result.filter((e) => e.ts <= endTs);
    }
  }
  // 限制最多 2000 条
  if (result.length > 2000) {
    result = result.slice(-2000);
  }
  return result;
});

const hasEntries = computed(() => entries.value.length > 0);

// 初始化
onMounted(async () => {
  await refreshStatus();
  await startPolling();
});

onUnmounted(() => {
  stopPolling();
});

// 监听暂停状态
watch(paused, (p) => {
  if (p) stopPolling();
  else startPolling();
});

async function refreshStatus(): Promise<void> {
  try {
    status.value = await logApi.getStatus();
    files.value = await logApi.listFiles();
    if (files.value.length > 0 && !selectedFile.value) {
      selectedFile.value = files.value[files.value.length - 1].name;
    }
    error.value = null;
  } catch (e) {
    error.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}

async function startPolling(): Promise<void> {
  if (pollTimer.value !== null) return;
  await poll();
  pollTimer.value = window.setInterval(poll, 1000);
}

function stopPolling(): void {
  if (pollTimer.value !== null) {
    clearInterval(pollTimer.value);
    pollTimer.value = null;
  }
}

async function poll(): Promise<void> {
  if (!isNative()) {
    // Web 环境：直接从 logBus 读取
    // OPT-24: 增量追加（按 id 去重，避免每秒全量重建列表）
    const buffer = getBuffer();
    const existingIds = new Set(entries.value.map((e) => e.id));
    const newEntries = buffer
      .filter((e) => !existingIds.has(e.id))
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        level: e.level as LogLevel,
        thread: 'JS',
        tag: e.tag,
        message: e.message,
        raw: `${new Date(e.ts).toISOString()} ${e.level} [JS] ${e.tag}: ${e.message}`,
      }));
    if (newEntries.length > 0) {
      entries.value = [...entries.value, ...newEntries];
      if (autoScroll.value && listRef.value) {
        requestAnimationFrame(() => {
          if (listRef.value) {
            listRef.value.scrollTop = listRef.value.scrollHeight;
          }
        });
      }
    }
    return;
  }
  try {
    const result = await logApi.readTail(selectedFile.value, cursor.value.offset, 256 * 1024);
    if (result.reset) {
      entries.value = [];
      cursor.value = { file: '', offset: 0 };
    }
    if (result.text) {
      const newEntries = parseLogText(result.text, result.file, cursor.value.offset);
      entries.value = [...entries.value, ...newEntries].slice(-3000);
      cursor.value = { file: result.file, offset: result.offset };
    }
    if (autoScroll.value && listRef.value) {
      requestAnimationFrame(() => {
        if (listRef.value) {
          listRef.value.scrollTop = listRef.value.scrollHeight;
        }
      });
    }
  } catch (e) {
    console.warn('Poll failed', e);
  }
}

// 操作
async function toggleEnabled(enabled: boolean): Promise<void> {
  try {
    await logApi.setEnabled(enabled);
    await refreshStatus();
    toast.success(enabled ? '详细日志已启用' : '详细日志已关闭');
  } catch (e) {
    toast.error('设置失败：' + toErrorShape(e).message);
  }
}

async function clearLogs(): Promise<void> {
  clearOpen.value = false;
  try {
    await logApi.clearAll();
    entries.value = [];
    cursor.value = { file: '', offset: 0 };
    await refreshStatus();
    toast.success('日志已清空');
  } catch (e) {
    toast.error('清空失败：' + toErrorShape(e).message);
  }
}

async function exportLogs(): Promise<void> {
  try {
    const result = await logApi.export();
    await Share.share({
      title: 'PeanutMov 日志导出',
      text: `日志文件（${formatBytes(result.size)}）`,
      url: result.uri,
      dialogTitle: '分享日志文件',
    });
    toast.success('日志已导出');
  } catch (e) {
    toast.error('导出失败：' + toErrorShape(e).message);
  }
}

function copyAll(): void {
  const text = filteredEntries.value.map(formatEntry).join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast.success('已复制到剪贴板'),
    () => toast.error('复制失败'),
  );
}

function toggleLevel(level: LogLevel): void {
  if (levelFilter.value.has(level)) {
    levelFilter.value.delete(level);
  } else {
    levelFilter.value.add(level);
  }
  levelFilter.value = new Set(levelFilter.value);
}

function toggleTag(tag: string): void {
  if (tagFilter.value.has(tag)) {
    tagFilter.value.delete(tag);
  } else {
    tagFilter.value.add(tag);
  }
  tagFilter.value = new Set(tagFilter.value);
}

function selectFile(name: string): void {
  selectedFile.value = name;
  cursor.value = { file: '', offset: 0 };
  entries.value = [];
  dateSheetOpen.value = false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function levelClass(level: LogLevel): string {
  switch (level) {
    case 'E':
    case 'F':
      return 'log-entry--error';
    case 'W':
      return 'log-entry--warn';
    case 'I':
      return 'log-entry--info';
    default:
      return '';
  }
}

function formatTime(ts: number): string {
  if (!ts) return 'N/A';
  const d = new Date(ts);
  return d.toTimeString().slice(0, 12);
}
</script>

<template>
  <div class="logs-view">
    <AppHeader title="运行日志" back />

    <div v-if="loading" class="logs-loading">
      <LoadingSpinner :size="24" />
      <span>加载中…</span>
    </div>

    <EmptyState
      v-else-if="error"
      icon="⚠️"
      :title="error"
      action-label="重试"
      @action="refreshStatus"
    />

    <template v-else>
      <!-- 状态条 -->
      <div class="logs-status">
        <div class="logs-status__row">
          <span class="logs-status__label">详细日志</span>
          <ToggleSwitch
            :model-value="status.enabled"
            @update:model-value="toggleEnabled"
          />
        </div>
        <div class="logs-status__row">
          <span class="logs-status__label">文件</span>
          <span class="logs-status__value">
            {{ files.length }} 个 · {{ formatBytes(status.totalBytes) }}
          </span>
          <button class="logs-status__btn" @click="dateSheetOpen = true">选择</button>
        </div>
        <div class="logs-status__row">
          <span class="logs-status__label">保留</span>
          <span class="logs-status__value">{{ status.retentionDays }} 天</span>
        </div>
      </div>

      <!-- 过滤栏 -->
      <div class="logs-filter">
        <div class="logs-filter__levels">
          <button
            v-for="level in (['D', 'I', 'W', 'E'] as LogLevel[])"
            :key="level"
            class="logs-filter__chip"
            :class="{ 'logs-filter__chip--active': levelFilter.has(level) }"
            @click="toggleLevel(level)"
          >
            {{ level }}
          </button>
        </div>
        <input
          v-model="keyword"
          class="logs-filter__search"
          type="search"
          placeholder="搜索…"
        />
        <button
          class="logs-filter__btn"
          :class="{ 'logs-filter__btn--active': tagFilter.size > 0 }"
          @click="tagSheetOpen = true"
        >
          标签{{ tagFilter.size > 0 ? ` (${tagFilter.size})` : '' }}
        </button>
        <div class="logs-filter__time">
          <input
            v-model="startTime"
            class="logs-filter__time-input"
            type="datetime-local"
            placeholder="开始时间"
          />
          <span class="logs-filter__time-sep">至</span>
          <input
            v-model="endTime"
            class="logs-filter__time-input"
            type="datetime-local"
            placeholder="结束时间"
          />
        </div>
      </div>

      <!-- 日志列表 -->
      <div
        v-if="filteredEntries.length === 0"
        class="logs-empty"
      >
        <EmptyState
          icon="📋"
          :title="hasEntries ? '无匹配日志' : '暂无日志'"
          :description="!status.enabled ? '开启详细日志后复现问题' : undefined"
          :action-label="!status.enabled ? '开启' : undefined"
          @action="toggleEnabled(true)"
        />
      </div>
      <div
        v-else
        ref="listRef"
        class="logs-list"
      >
        <div
          v-for="entry in filteredEntries"
          :key="entry.id"
          class="log-entry"
          :class="levelClass(entry.level)"
        >
          <span class="log-entry__time">{{ formatTime(entry.ts) }}</span>
          <span class="log-entry__level">{{ entry.level }}</span>
          <span class="log-entry__tag">{{ entry.tag }}</span>
          <pre class="log-entry__msg">{{ entry.message }}</pre>
        </div>
      </div>

      <!-- 底部工具栏 -->
      <div class="logs-toolbar">
        <button
          class="logs-toolbar__btn"
          :class="{ 'logs-toolbar__btn--active': paused }"
          @click="paused = !paused"
        >
          {{ paused ? '继续' : '暂停' }}
        </button>
        <button
          class="logs-toolbar__btn"
          :class="{ 'logs-toolbar__btn--active': autoScroll }"
          @click="autoScroll = !autoScroll"
        >
          自动滚动
        </button>
        <button
          class="logs-toolbar__btn"
          :class="{ 'logs-toolbar__btn--active': errorOnly, 'logs-toolbar__btn--danger': errorOnly }"
          @click="errorOnly = !errorOnly"
        >
          只看错误
        </button>
        <button class="logs-toolbar__btn" @click="copyAll">复制</button>
        <button class="logs-toolbar__btn" @click="exportLogs">分享</button>
        <button class="logs-toolbar__btn logs-toolbar__btn--danger" @click="clearOpen = true">
          清空
        </button>
      </div>
    </template>

    <!-- 标签过滤弹层 -->
    <BottomSheet v-model="tagSheetOpen" title="标签过滤">
      <div class="tag-list">
        <button
          v-for="[tag, count] in allTags"
          :key="tag"
          class="tag-list__item"
          :class="{ 'tag-list__item--active': tagFilter.has(tag) }"
          @click="toggleTag(tag)"
        >
          <span>{{ tag }}</span>
          <span class="tag-list__count">{{ count }}</span>
        </button>
      </div>
    </BottomSheet>

    <!-- 日期选择弹层 -->
    <BottomSheet v-model="dateSheetOpen" title="选择日期">
      <div class="date-list">
        <button
          v-for="file in files"
          :key="file.name"
          class="date-list__item"
          :class="{ 'date-list__item--active': file.name === selectedFile }"
          @click="selectFile(file.name)"
        >
          <span>{{ file.name }}</span>
          <span class="date-list__size">{{ formatBytes(file.size) }}</span>
        </button>
      </div>
    </BottomSheet>

    <!-- 清空确认 -->
    <ConfirmDialog
      v-model="clearOpen"
      title="清空全部日志？"
      message="此操作不可恢复"
      confirm-text="清空"
      danger
      @confirm="clearLogs"
    />
  </div>
</template>

<style scoped>
.logs-view {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--color-bg-base);
}

.logs-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-8);
  color: var(--color-text-secondary);
}

.logs-status {
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
}

.logs-status__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.logs-status__label {
  flex: 0 0 auto;
  font: var(--font-weight-medium) 13px / 1.4 var(--font-family-base);
  color: var(--color-text-secondary);
}

.logs-status__value {
  flex: 1 1 auto;
  font: var(--font-weight-regular) 13px / 1.4 var(--font-family-number);
  color: var(--color-text-primary);
  text-align: right;
}

.logs-status__btn {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-2);
  font: var(--font-weight-medium) 12px / 1.4 var(--font-family-base);
  color: var(--color-accent);
  background: transparent;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.logs-filter {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
}

.logs-filter__levels {
  display: flex;
  gap: var(--space-1);
}

.logs-filter__chip {
  padding: var(--space-1) var(--space-2);
  font: var(--font-weight-medium) 11px / 1.4 var(--font-family-mono);
  color: var(--color-text-secondary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-standard);
}

.logs-filter__chip--active {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.logs-filter__search {
  flex: 1 1 auto;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
}

.logs-filter__search:focus {
  outline: none;
  border-color: var(--color-accent);
}

.logs-filter__btn {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-2);
  font: var(--font-weight-medium) 12px / 1.4 var(--font-family-base);
  color: var(--color-text-secondary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.logs-filter__btn--active {
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.logs-filter__time {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.logs-filter__time-input {
  flex: 1 1 auto;
  min-width: 140px;
  padding: var(--space-1) var(--space-2);
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
}

.logs-filter__time-input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.logs-filter__time-sep {
  flex: 0 0 auto;
  font: var(--font-weight-regular) 12px / 1 var(--font-family-base);
  color: var(--color-text-tertiary);
}

.logs-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
}

.logs-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-2);
  font: var(--font-weight-regular) 11px / 1.5 var(--font-family-mono);
}

.log-entry {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-divider-soft);
  content-visibility: auto;
  contain-intrinsic-size: 0 60px;
}

.log-entry--error {
  background: var(--color-danger-soft);
}

.log-entry--warn {
  background: var(--color-warning-soft);
}

.log-entry--info {
  background: var(--color-info-soft);
}

.log-entry__time {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
}

.log-entry__level {
  flex: 0 0 auto;
  min-width: 1.5em;
  font-weight: var(--font-weight-bold);
}

.log-entry--error .log-entry__level {
  color: var(--color-danger);
}

.log-entry--warn .log-entry__level {
  color: var(--color-warning);
}

.log-entry--info .log-entry__level {
  color: var(--color-info);
}

.log-entry__tag {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
}

.log-entry__msg {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-text-primary);
}

.logs-toolbar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-divider);
}

.logs-toolbar__btn {
  flex: 1 1 auto;
  padding: var(--space-2);
  font: var(--font-weight-medium) 13px / 1.4 var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-standard);
}

.logs-toolbar__btn:active {
  background: var(--color-overlay-press);
}

.logs-toolbar__btn--active {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.logs-toolbar__btn--danger {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

.tag-list,
.date-list {
  padding: var(--space-2);
}

.tag-list__item,
.date-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--space-3);
  font: var(--font-weight-regular) 14px / 1.4 var(--font-family-base);
  color: var(--color-text-primary);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-divider);
  cursor: pointer;
  text-align: left;
}

.tag-list__item:active,
.date-list__item:active {
  background: var(--color-overlay-press);
}

.tag-list__item--active,
.date-list__item--active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.tag-list__count,
.date-list__size {
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-number);
  color: var(--color-text-tertiary);
}
</style>
