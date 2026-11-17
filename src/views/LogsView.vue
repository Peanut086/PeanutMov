<script setup lang="ts">
/**
 * 运行日志查看页（P0-P3 / 批次3 重做）
 *
 * 功能：
 * - 双 tab：崩溃（CrashPane）/ 日志
 * - 日志：全量加载单文件（readRange 分块，.gz 解压）+ 固定行高虚拟滚动
 * - 级别单选组（全部/警告+/仅错误）/ 标签 / 关键字（命中计数与跳转）
 * - 按小时直方图时间导航（错误小时标红，点柱跳转）
 * - 上下文抽屉：任意条 ±50 行，可复制此条/带上下文
 * - 跟随交互：上滑自动解除跟随，浮出「N 条新日志」，点击回底恢复
 * - live 轮询仅「最新明文文件 + 日志 tab + 页面可见」时运行；历史/.gz 文件静态查看
 * - 导出范围：全部 / 仅崩溃证据 / 今天 / 最近 1 小时
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import type { LogLevel } from '@/shared/logLine';
import {
  extractTags,
  filterByTag,
  formatEntry,
  formatLocalTs,
  parseLogText,
} from '@/shared/logLine';
import { logApi, type DebugLogStatus, type LogFile } from '@/native/logs';
import type { LogEntry } from '@/shared/logLine';
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
import CrashPane from '@/components/log/CrashPane.vue';
import { useVirtualRows } from '@/components/media/useVirtualRows';

const toast = useToast();

// 日志行固定高度（虚拟滚动的基准，CSS 里 .log-entry 必须同高）
const ROW_H = 24;

// 状态
const loading = ref(true);
const error = ref<string | null>(null);
const status = ref<DebugLogStatus>({
  enabled: false,
  fileCount: 0,
  totalBytes: 0,
  retentionDays: 7,
});
const files = ref<LogFile[]>([]);
const selectedFile = ref('');
const entries = ref<LogEntry[]>([]);
const cursor = ref({ file: '', offset: 0 });
const pollTimer = ref<number | null>(null);
const loadingFile = ref(false);
const fileRolled = ref(false);
let pollCount = 0;

// Tab：有崩溃记录时默认落在「崩溃」
const activeTab = ref<'crash' | 'logs'>('logs');
const crashCount = ref(0);

// 过滤
const LEVEL_OPTS = [
  { value: 'all', label: '全部' },
  { value: 'warn', label: '警告+' },
  { value: 'err', label: '仅错误' },
] as const;
const levelMode = ref<'all' | 'warn' | 'err'>('all');
const tagFilter = ref<Set<string>>(new Set());
const keyword = ref('');
const matchIndex = ref(0);
const tagSheetOpen = ref(false);
const dateSheetOpen = ref(false);

// 跟随：用户上滑解除，回底或点浮标恢复
const follow = ref(true);
const pendingNew = ref(0);
let lastScrollTop = 0;

// 上下文抽屉
const contextOpen = ref(false);
const contextEntry = ref<LogEntry | null>(null);

// 导出
const EXPORT_OPTS = [
  { value: 'all', label: '全部日志', desc: '全部文件 + 崩溃证据' },
  { value: 'crash', label: '仅崩溃证据', desc: 'tombstone + Java 崩溃栈' },
  { value: 'today', label: '今天的日志', desc: '今日文件 + 崩溃证据' },
  { value: 'recent1h', label: '最近 1 小时', desc: '一小时内日志行 + 崩溃证据' },
] as const;
const exportOpen = ref(false);
const exportScope = ref<'all' | 'crash' | 'today' | 'recent1h'>('all');
const exportBusy = ref(false);

// 清空确认
const clearOpen = ref(false);

// 初始化
onMounted(async () => {
  await refreshStatus();
  void loadCrashCount();
  await syncPolling();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopPolling();
});

// 文件按 lastModified 升序，末位即最新；最新且非压缩的才实时轮询
const latestFileName = computed(() =>
  files.value.length > 0 ? files.value[files.value.length - 1].name : '',
);
const isStaticFile = computed(
  () =>
    selectedFile.value.endsWith('.gz') ||
    (latestFileName.value !== '' && selectedFile.value !== latestFileName.value),
);

watch(selectedFile, async (name) => {
  fileRolled.value = false;
  entries.value = [];
  cursor.value = { file: '', offset: 0 };
  pendingNew.value = 0;
  lastScrollTop = 0;
  await loadFullFile(name);
  await syncPolling();
});

watch(activeTab, () => {
  void syncPolling();
});

async function loadCrashCount(): Promise<void> {
  const evts = await logApi.getCrashEvents();
  crashCount.value = evts.length;
  if (evts.length > 0) activeTab.value = 'crash';
}

function onVisibilityChange(): void {
  void syncPolling();
}

/** 轮询只在「日志 tab + 最新明文文件 + 页面可见」时运行 */
async function syncPolling(): Promise<void> {
  const shouldPoll =
    activeTab.value === 'logs' &&
    !isStaticFile.value &&
    document.visibilityState === 'visible';
  if (shouldPoll) {
    await startPolling();
  } else {
    stopPolling();
  }
}

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

let loadToken = 0;

/** 全量加载当前文件（明文/.gz 通用），live 文件末尾切回 readTail 增量 */
async function loadFullFile(name: string): Promise<void> {
  if (!isNative() || !name) return;
  const token = ++loadToken;
  loadingFile.value = true;
  try {
    let offset = 0;
    let text = '';
    let byteOffset = -1;
    for (let i = 0; i < 64; i++) {
      const r = await logApi.readRange(name, offset, 256 * 1024);
      text += r.text;
      offset = r.offset;
      if (r.eof) {
        byteOffset = r.byteOffset;
        break;
      }
    }
    if (token !== loadToken) return;
    const parsed = parseLogText(text, name, 0);
    parsed.forEach((e, i) => {
      e.seq = i;
    });
    entries.value = parsed;
    cursor.value = { file: name, offset: byteOffset >= 0 ? byteOffset : 0 };
    follow.value = true;
    pendingNew.value = 0;
    requestAnimationFrame(() => scrollToBottom());
  } catch (e) {
    console.warn('Load full file failed', e);
  } finally {
    if (token === loadToken) loadingFile.value = false;
  }
}

async function poll(): Promise<void> {
  if (!isNative()) {
    // Web 环境：直接从 logBus 读取（增量追加，按 id 去重）
    const buffer = getBuffer();
    const existingIds = new Set(entries.value.map((e) => e.id));
    const newEntries = buffer
      .filter((e) => !existingIds.has(e.id))
      .map((e, i) => {
        const entry: LogEntry = {
          id: e.id,
          ts: e.ts,
          level: e.level as LogLevel,
          thread: 'JS',
          tag: e.tag,
          message: e.message,
          raw: `${new Date(e.ts).toISOString()} ${e.level} [JS] ${e.tag}: ${e.message}`,
          seq: entries.value.length + i,
        };
        return entry;
      });
    if (newEntries.length > 0) {
      entries.value = [...entries.value, ...newEntries];
      if (follow.value) {
        requestAnimationFrame(() => scrollToBottom());
      } else {
        pendingNew.value += newEntries.length;
      }
    }
    return;
  }
  if (isStaticFile.value) return;
  pollCount++;
  try {
    // 每 ~10 秒核对一次最新文件：跨天滚动后旧文件不再增长，需提示用户跟随
    if (pollCount % 10 === 1) {
      const fresh = await logApi.listFiles();
      files.value = fresh;
      const newest = fresh.length > 0 ? fresh[fresh.length - 1].name : '';
      if (newest && newest !== selectedFile.value) {
        fileRolled.value = true;
        return;
      }
    }
    const result = await logApi.readTail(selectedFile.value, cursor.value.offset, 256 * 1024);
    if (result.reset) {
      entries.value = [];
      cursor.value = { file: '', offset: 0 };
    }
    if (result.text) {
      const newEntries = parseLogText(result.text, result.file, result.reset ? 0 : cursor.value.offset);
      const base = entries.value.length;
      newEntries.forEach((e, i) => {
        e.seq = base + i;
      });
      entries.value = [...entries.value, ...newEntries];
      cursor.value = { file: result.file, offset: result.offset };
      if (follow.value) {
        requestAnimationFrame(() => scrollToBottom());
      } else {
        pendingNew.value += newEntries.length;
      }
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
    selectedFile.value = '';
    await refreshStatus();
    toast.success('日志已清空');
  } catch (e) {
    toast.error('清空失败：' + toErrorShape(e).message);
  }
}

async function doExport(): Promise<void> {
  if (exportBusy.value) return;
  exportOpen.value = false;
  exportBusy.value = true;
  try {
    const result = await logApi.export(exportScope.value);
    await Share.share({
      title: 'PeanutMov 日志导出',
      // Share 插件只接受 file:// 或 http url，content:// 会被拒（Unsupported url）
      url: 'file://' + result.path,
      dialogTitle: '分享日志文件',
    });
    toast.success('日志已导出');
  } catch (e) {
    const err = toErrorShape(e);
    // 用户在分享面板取消不算错误
    if (err.message?.includes('cancel') || err.message?.includes('dismiss')) return;
    toast.error('导出失败：' + err.message);
  } finally {
    exportBusy.value = false;
  }
}

// 计算：过滤 / 虚拟滚动
const filteredEntries = computed(() => {
  let result = entries.value;
  if (levelMode.value === 'warn') {
    result = result.filter((e) => e.level === 'W' || e.level === 'E' || e.level === 'F');
  } else if (levelMode.value === 'err') {
    result = result.filter((e) => e.level === 'E' || e.level === 'F');
  }
  if (tagFilter.value.size > 0) {
    result = filterByTag(result, tagFilter.value);
  }
  if (keyword.value) {
    const kw = keyword.value.toLowerCase();
    result = result.filter(
      (e) => e.message.toLowerCase().includes(kw) || e.tag.toLowerCase().includes(kw),
    );
  }
  return result;
});

const filteredCount = computed(() => filteredEntries.value.length);
const { containerRef, win, padTop, padBottom, scrollToIndex, scrollToBottom } =
  useVirtualRows(filteredCount, ROW_H, 10);
const viewRows = computed(() => filteredEntries.value.slice(win.value.start, win.value.end));

const allTags = computed(() => extractTags(filteredEntries.value));
const hasEntries = computed(() => entries.value.length > 0);

watch([keyword, levelMode, tagFilter], () => {
  matchIndex.value = 0;
  if (follow.value) {
    requestAnimationFrame(() => scrollToBottom());
  }
});

function onUserScroll(): void {
  const el = containerRef.value;
  if (!el) return;
  const st = el.scrollTop;
  const nearBottom = st + el.clientHeight >= el.scrollHeight - ROW_H * 2;
  if (nearBottom) {
    follow.value = true;
    pendingNew.value = 0;
  } else if (st < lastScrollTop - 2) {
    // 只有用户主动上滑才解除跟随，程序化 scrollToBottom 不算
    follow.value = false;
  }
  lastScrollTop = st;
}

function jumpToBottom(): void {
  follow.value = true;
  pendingNew.value = 0;
  scrollToBottom();
}

function jumpMatch(dir: 1 | -1): void {
  const n = filteredEntries.value.length;
  if (!keyword.value || n === 0) return;
  matchIndex.value = (matchIndex.value + dir + n) % n;
  follow.value = false;
  scrollToIndex(matchIndex.value);
}

// 小时直方图
const hourBuckets = computed(() => {
  const buckets = Array.from({ length: 24 }, () => ({ total: 0, errs: 0, first: -1 }));
  filteredEntries.value.forEach((e, i) => {
    if (!e.ts) return;
    const h = new Date(e.ts).getHours();
    const b = buckets[h];
    b.total++;
    if (e.level === 'E' || e.level === 'F') b.errs++;
    if (b.first < 0) b.first = i;
  });
  return buckets;
});
const hourMax = computed(() => Math.max(1, ...hourBuckets.value.map((b) => b.total)));
const hasBuckets = computed(() => hourBuckets.value.some((b) => b.total > 0));

function barHeight(b: { total: number }): number {
  if (b.total === 0) return 0;
  return Math.max(15, Math.round(Math.sqrt(b.total / hourMax.value) * 100));
}

function jumpHour(h: number): void {
  const first = hourBuckets.value[h]?.first;
  if (first == null || first < 0) return;
  follow.value = false;
  scrollToIndex(first);
}

// 上下文抽屉
const contextAround = computed(() => {
  const e = contextEntry.value;
  if (!e || e.seq == null) return null;
  return {
    seq: e.seq,
    items: entries.value.slice(Math.max(0, e.seq - 50), e.seq + 51),
  };
});

function openContext(entry: LogEntry): void {
  contextEntry.value = entry;
  contextOpen.value = true;
}

function copyOne(): void {
  if (!contextEntry.value) return;
  navigator.clipboard.writeText(formatEntry(contextEntry.value)).then(
    () => toast.success('已复制此条'),
    () => toast.error('复制失败'),
  );
}

function copyContext(): void {
  const ctx = contextAround.value;
  if (!ctx) return;
  const text = ctx.items
    .map((it) => (it.seq === ctx.seq ? '▶ ' : '  ') + formatEntry(it))
    .join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast.success('已复制上下文（±50 行）'),
    () => toast.error('复制失败'),
  );
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
  dateSheetOpen.value = false;
}

function followLatestFile(): void {
  if (latestFileName.value) selectFile(latestFileName.value);
}

function copyAll(): void {
  const list = filteredEntries.value;
  const capped = list.length > 5000 ? list.slice(-5000) : list;
  const note =
    list.length > 5000
      ? `\n[仅复制最近 5000 条，共 ${list.length} 条，完整数据请用分享导出]`
      : '';
  navigator.clipboard.writeText(capped.map(formatEntry).join('\n') + note).then(
    () => toast.success(list.length > 5000 ? '已复制最近 5000 条' : '已复制到剪贴板'),
    () => toast.error('复制失败'),
  );
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
  return formatLocalTs(ts).slice(11);
}
</script>

<template>
  <div class="logs-view">
    <AppHeader title="运行日志" back>
      <template #actions>
        <button class="logs-clear" type="button" @click="clearOpen = true">清空</button>
      </template>
    </AppHeader>

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
      <!-- Tab 切换 -->
      <div class="logs-tabs">
        <button
          class="logs-tabs__btn"
          :class="{ 'logs-tabs__btn--active': activeTab === 'crash' }"
          type="button"
          @click="activeTab = 'crash'"
        >
          崩溃
          <span v-if="crashCount > 0" class="logs-tabs__badge">{{ crashCount }}</span>
        </button>
        <button
          class="logs-tabs__btn"
          :class="{ 'logs-tabs__btn--active': activeTab === 'logs' }"
          type="button"
          @click="activeTab = 'logs'"
        >
          日志
        </button>
      </div>

      <CrashPane v-if="activeTab === 'crash'" />

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
              v-for="opt in LEVEL_OPTS"
              :key="opt.value"
              class="logs-filter__chip"
              :class="{ 'logs-filter__chip--active': levelMode === opt.value }"
              @click="levelMode = opt.value"
            >
              {{ opt.label }}
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
        </div>

        <!-- 小时直方图 -->
        <div v-if="hasBuckets" class="logs-histogram">
          <div class="logs-histogram__bars">
            <button
              v-for="(b, h) in hourBuckets"
              :key="h"
              class="logs-histogram__bar"
              :class="{
                'logs-histogram__bar--err': b.errs > 0,
                'logs-histogram__bar--has': b.total > 0 && b.errs === 0,
              }"
              :style="{ height: barHeight(b) + '%' }"
              :disabled="b.total === 0"
              :title="`${h}:00 · ${b.total} 条 · 错误 ${b.errs}`"
              @click="jumpHour(h)"
            />
          </div>
          <div class="logs-histogram__ticks">
            <span>0时</span><span>6</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>

        <!-- 跨天滚动提示 -->
        <button v-if="fileRolled" class="logs-rolled" type="button" @click="followLatestFile">
          日志已滚动到新文件，点击跟随最新 →
        </button>

        <!-- 日志列表 -->
        <div class="logs-main">
          <div v-if="loadingFile && filteredEntries.length === 0" class="logs-loading">
            <LoadingSpinner :size="24" />
            <span>加载文件…</span>
          </div>

          <div v-else-if="filteredEntries.length === 0" class="logs-empty">
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
            ref="containerRef"
            class="logs-list"
            @scroll="onUserScroll"
          >
            <div :style="{ paddingTop: padTop + 'px', paddingBottom: padBottom + 'px' }">
              <div
                v-for="entry in viewRows"
                :key="entry.id"
                class="log-entry"
                :class="levelClass(entry.level)"
                :style="{ height: ROW_H + 'px' }"
                @click="openContext(entry)"
              >
                <span class="log-entry__time">{{ formatTime(entry.ts) }}</span>
                <span class="log-entry__level">{{ entry.level }}</span>
                <span class="log-entry__tag truncate-1">{{ entry.tag }}</span>
                <span class="log-entry__msg truncate-1">{{ entry.message }}</span>
              </div>
            </div>
          </div>

          <!-- 新日志浮标 -->
          <button
            v-if="!follow && pendingNew > 0"
            class="logs-newpill"
            type="button"
            @click="jumpToBottom"
          >
            ↓ {{ pendingNew }} 条新日志
          </button>
        </div>

        <!-- 底部工具栏 -->
        <div class="logs-toolbar">
          <div v-if="keyword" class="logs-toolbar__match">
            第 {{ Math.min(matchIndex + 1, filteredCount) }}/{{ filteredCount }} 条
            <button class="logs-toolbar__nav" @click="jumpMatch(-1)">↑</button>
            <button class="logs-toolbar__nav" @click="jumpMatch(1)">↓</button>
          </div>
          <button class="logs-toolbar__btn" @click="copyAll">复制</button>
          <button class="logs-toolbar__btn" @click="exportOpen = true">分享</button>
        </div>
      </template>
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

    <!-- 上下文抽屉 -->
    <BottomSheet v-model="contextOpen" title="日志上下文">
      <div class="ctx">
        <div v-if="contextAround" class="ctx__text">
          <div
            v-for="it in contextAround.items"
            :key="it.id"
            class="ctx__line"
            :class="{ 'ctx__line--focus': contextEntry && it.seq === contextEntry.seq }"
          >{{ it.raw }}</div>
        </div>
        <div class="ctx__actions">
          <button class="ctx__btn" @click="copyOne">复制此条</button>
          <button class="ctx__btn ctx__btn--primary" @click="copyContext">复制带上下文</button>
        </div>
      </div>
    </BottomSheet>

    <!-- 导出范围 -->
    <BottomSheet v-model="exportOpen" title="选择导出范围">
      <div class="export-list">
        <button
          v-for="opt in EXPORT_OPTS"
          :key="opt.value"
          class="export-list__item"
          :class="{ 'export-list__item--active': exportScope === opt.value }"
          @click="exportScope = opt.value"
        >
          <span>{{ opt.label }}</span>
          <span class="export-list__desc">{{ opt.desc }}</span>
        </button>
        <button class="export-list__go" :disabled="exportBusy" @click="doExport">
          {{ exportBusy ? '打包中…' : '导出并分享' }}
        </button>
      </div>
    </BottomSheet>

    <!-- 清空确认 -->
    <ConfirmDialog
      v-model="clearOpen"
      title="清空全部日志？"
      message="将删除全部日志与崩溃证据，且无法恢复"
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

.logs-clear {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-2);
  font: var(--font-weight-medium) 13px / 1.4 var(--font-family-base);
  color: var(--color-danger);
  background: transparent;
  border: none;
  cursor: pointer;
}

.logs-tabs {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-1) var(--space-4) 0;
  background: var(--color-bg-base);
  border-bottom: 1px solid var(--color-divider);
}

.logs-tabs__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  font: var(--font-weight-medium) 14px / 1.4 var(--font-family-base);
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}

.logs-tabs__btn--active {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.logs-tabs__badge {
  min-width: 18px;
  padding: 0 5px;
  font: var(--font-weight-bold) 11px / 1.7 var(--font-family-number);
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: 9px;
  text-align: center;
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
  font: var(--font-weight-medium) 11px / 1.4 var(--font-family-base);
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

.logs-histogram {
  padding: var(--space-2) var(--space-4) var(--space-1);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-divider);
}

.logs-histogram__bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 36px;
}

.logs-histogram__bar {
  flex: 1 1 0;
  min-height: 0;
  padding: 0;
  background: var(--color-bg-base);
  border: none;
  border-radius: 1px 1px 0 0;
  cursor: pointer;
}

.logs-histogram__bar--has {
  background: var(--color-info);
  opacity: 0.55;
}

.logs-histogram__bar--err {
  background: var(--color-danger);
  opacity: 0.8;
}

.logs-histogram__bar:disabled {
  cursor: default;
  background: var(--color-divider-soft);
  height: 2px !important;
  opacity: 1;
}

.logs-histogram__ticks {
  display: flex;
  justify-content: space-between;
  font: var(--font-weight-regular) 9px / 1.6 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.logs-rolled {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-4);
  font: var(--font-weight-medium) 13px / 1.4 var(--font-family-base);
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border: none;
  border-bottom: 1px solid var(--color-divider);
  cursor: pointer;
  text-align: center;
}

.logs-main {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
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
  padding: var(--space-1) 0;
  font: var(--font-weight-regular) 11px / 1.5 var(--font-family-mono);
}

.log-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider-soft);
  cursor: pointer;
}

.log-entry:active {
  background: var(--color-overlay-press);
}

.log-entry--error {
  background: var(--color-danger-soft);
}

.log-entry--warn {
  background: var(--color-warning-soft);
}

.log-entry__time {
  flex: 0 0 auto;
  font: var(--font-weight-regular) 10px / 1.4 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.log-entry__level {
  flex: 0 0 auto;
  min-width: 1.4em;
  font-weight: var(--font-weight-bold);
}

.log-entry--error .log-entry__level {
  color: var(--color-danger);
}

.log-entry--warn .log-entry__level {
  color: var(--color-warning);
}

.log-entry__tag {
  flex: 0 0 auto;
  max-width: 30%;
  color: var(--color-text-secondary);
}

.log-entry__msg {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--color-text-primary);
}

.logs-newpill {
  position: absolute;
  left: 50%;
  bottom: var(--space-3);
  transform: translateX(-50%);
  padding: var(--space-1) var(--space-3);
  font: var(--font-weight-medium) 12px / 1.6 var(--font-family-base);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent);
  border-radius: 999px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 20%);
  cursor: pointer;
}

.logs-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-divider);
}

.logs-toolbar__match {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-number);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.logs-toolbar__nav {
  width: 28px;
  height: 28px;
  padding: 0;
  font: var(--font-weight-medium) 14px / 1 var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: pointer;
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

.tag-list,
.date-list,
.export-list {
  padding: var(--space-2);
}

.tag-list__item,
.date-list__item,
.export-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
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
.date-list__item:active,
.export-list__item:active {
  background: var(--color-overlay-press);
}

.tag-list__item--active,
.date-list__item--active,
.export-list__item--active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.tag-list__count,
.date-list__size {
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.export-list__desc {
  font: var(--font-weight-regular) 12px / 1.4 var(--font-family-base);
  color: var(--color-text-tertiary);
}

.export-list__go {
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-3);
  font: var(--font-weight-medium) 14px / 1.4 var(--font-family-base);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.export-list__go:disabled {
  opacity: 0.6;
}

.ctx {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.ctx__text {
  max-height: 50vh;
  overflow-y: auto;
  padding: var(--space-2);
  font: var(--font-weight-regular) 11px / 1.5 var(--font-family-mono);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
}

.ctx__line {
  padding: 1px 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-text-primary);
}

.ctx__line--focus {
  padding-left: var(--space-1);
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-radius: var(--radius-sm);
}

.ctx__actions {
  display: flex;
  gap: var(--space-2);
}

.ctx__btn {
  flex: 1 1 auto;
  padding: var(--space-2);
  font: var(--font-weight-medium) 13px / 1.4 var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-base);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.ctx__btn--primary {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
</style>
