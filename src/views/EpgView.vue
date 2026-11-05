<script setup lang="ts">
/**
 * EPG 节目单页（功能扩展-5）
 *
 * 展示某频道当日完整节目时间表。
 * - 日期切换：昨天 / 今天 / 明天
 * - 时间轴：按时间顺序列出所有节目，当前正在播的高亮并自动滚动到视口
 * - 数据来源：epgService（diyp / XMLTV，24h 缓存）
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { EpgProgramme } from '@/services/epgService';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { epgService } from '@/services/epgService';
import { toErrorShape } from '@/shared/errors';

defineOptions({ name: 'EpgView' });

const route = useRoute();
const router = useRouter();

const channelName = computed(() => String(route.query.ch ?? ''));
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const programmes = ref<EpgProgramme[]>([]);
const currentDate = ref(new Date());

/** 日期偏移：-1 昨天 / 0 今天 / +1 明天 */
const dateOffset = ref(0);

const isToday = computed(() => dateOffset.value === 0);

const dateLabel = computed(() => {
  const d = currentDate.value;
  const weekdays = ['周日', '周一一', '周二', '周三', '周四', '周五五', '周六'];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekday = weekdays[d.getDay()];
  let prefix = '';
  if (dateOffset.value === -1) prefix = '昨天 ';
  else if (dateOffset.value === 1) prefix = '明天 ';
  return `${prefix}${month}月${day}日 ${weekday}`;
});

const nowPlayingIndex = computed(() => {
  if (!isToday.value) return -1;
  const now = epgService.nowPlaying(programmes.value);
  if (!now) return -1;
  return programmes.value.findIndex((p) => p.startSec === now.startSec && p.title === now.title);
});

function shiftDate(delta: number): void {
  const next = dateOffset.value + delta;
  if (next < -1 || next > 1) return;
  dateOffset.value = next;
  const d = new Date();
  d.setDate(d.getDate() + next);
  currentDate.value = d;
}

async function loadProgrammes(): Promise<void> {
  if (!channelName.value) {
    errorMessage.value = '缺少频道信息';
    loading.value = false;
    return;
  }
  loading.value = true;
  errorMessage.value = null;
  try {
    programmes.value = await epgService.programmes(channelName.value, currentDate.value);
  } catch (e) {
    errorMessage.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}

/** 自动滚动到当前正在播的节目 */
async function scrollToNow(): Promise<void> {
  if (nowPlayingIndex.value < 0) return;
  await nextTick();
  const el = document.getElementById(`epg-item-${nowPlayingIndex.value}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

watch([channelName, () => currentDate.value], () => {
  void loadProgrammes().then(() => {
    if (isToday.value) void scrollToNow();
  });
});

onMounted(() => {
  void loadProgrammes().then(() => {
    if (isToday.value) void scrollToNow();
  });
});

function goBack(): void {
  if (window.history.length > 1) {
    router.back();
  } else {
    void router.push('/live');
  }
}

function formatDuration(startSec: number, endSec: number): string {
  const diff = endSec - startSec;
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}小时${minutes}分钟`;
  if (hours > 0) return `${hours}小时`;
  return `${minutes}分钟`;
}
</script>

<template>
  <SafeArea data-route="epg">
    <AppHeader :title="channelName || '节目单'" :back="true" @back="goBack" />

    <div class="epg-body">
      <!-- 日期选择 -->
      <div class="epg-date-bar">
        <button
          class="epg-date-btn"
          :class="{ 'epg-date-btn--disabled': dateOffset <= -1 }"
          :disabled="dateOffset <= -1"
          type="button"
          @click="shiftDate(-1)"
        >
          ‹ 前一天
        </button>
        <span class="epg-date-label" :class="{ 'epg-date-label--today': isToday }">
          {{ dateLabel }}
        </span>
        <button
          class="epg-date-btn"
          :class="{ 'epg-date-btn--disabled': dateOffset >= 1 }"
          :disabled="dateOffset >= 1"
          type="button"
          @click="shiftDate(1)"
        >
          后一天 ›
        </button>
      </div>

      <!-- 加载 -->
      <div v-if="loading" class="epg-loading" role="status">
        <LoadingSpinner :size="20" />
        <span>正在加载节目单…</span>
      </div>

      <!-- 错误 -->
      <div v-else-if="errorMessage" class="epg-error" role="alert">
        <span>{{ errorMessage }}</span>
        <button class="btn btn--secondary btn--sm" type="button" @click="loadProgrammes">重试</button>
      </div>

      <!-- 空态 -->
      <div v-else-if="programmes.length === 0" class="epg-empty">
        <p>暂无节目单数据</p>
        <p class="epg-empty__hint">该频道可能不支持 EPG，或当前日期无节目安排</p>
      </div>

      <!-- 节目列表 -->
      <ul v-else class="epg-list">
        <li
          v-for="(prog, idx) in programmes"
          :id="`epg-item-${idx}`"
          :key="`${prog.start}-${prog.title}`"
          class="epg-item"
          :class="{
            'epg-item--now': idx === nowPlayingIndex,
            'epg-item--past': isToday && prog.endSec <= (new Date().getHours() * 3600 + new Date().getMinutes() * 60),
          }"
        >
          <span class="epg-item__time">
            <span class="epg-item__start">{{ prog.start }}</span>
            <span v-if="prog.end" class="epg-item__end">– {{ prog.end }}</span>
          </span>
          <span class="epg-item__body">
            <span class="epg-item__title">{{ prog.title }}</span>
            <span v-if="prog.desc" class="epg-item__desc">{{ prog.desc }}</span>
            <span class="epg-item__duration">{{ formatDuration(prog.startSec, prog.endSec) }}</span>
          </span>
          <span v-if="idx === nowPlayingIndex" class="epg-item__badge">正在播</span>
        </li>
      </ul>
    </div>
  </SafeArea>
</template>

<style scoped>
.epg-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) var(--space-6);
}

/* ---------- 日期选择栏 ---------- */
.epg-date-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  position: sticky;
  top: 0;
  background-color: var(--color-bg-base);
  z-index: 1;
}

.epg-date-btn {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-brand-text);
  font: var(--text-caption);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.epg-date-btn:active:not(:disabled) {
  background-color: var(--color-bg-pressed);
}

.epg-date-btn--disabled {
  opacity: 0.35;
  cursor: default;
}

.epg-date-label {
  flex: 1 1 auto;
  text-align: center;
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.epg-date-label--today {
  color: var(--color-brand-text);
}

/* ---------- 加载 / 错误 / 空态 ---------- */
.epg-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) 0;
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.epg-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  border: 1px solid rgba(255, 90, 95, 0.3);
  font: var(--text-label);
  color: var(--color-text-primary);
  margin-top: var(--space-3);
}

.epg-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  text-align: center;
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.epg-empty__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  opacity: 0.7;
}

/* ---------- 节目列表 ---------- */
.epg-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.epg-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-md);
  transition: background-color var(--duration-fast);
}

.epg-item--past {
  opacity: 0.5;
}

.epg-item--now {
  background-color: var(--color-brand-soft);
  border: 1px solid rgba(40, 160, 80, 0.25);
  opacity: 1;
}

.epg-item__time {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  min-width: 52px;
  padding-top: 1px;
}

.epg-item__start {
  font: var(--font-weight-semibold) 14px / 1.2 var(--font-family-number);
  color: var(--color-text-primary);
}

.epg-item--now .epg-item__start {
  color: var(--color-brand-strong);
}

.epg-item__end {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.epg-item__body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.epg-item__title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  line-height: 1.4;
}

.epg-item--now .epg-item__title {
  color: var(--color-brand-strong);
}

.epg-item__desc {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.epg-item__duration {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.epg-item__badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background-color: var(--color-brand);
  color: #fff;
  font: var(--font-weight-semibold) 10px / 1.4 var(--font-family-base);
  white-space: nowrap;
  align-self: center;
}
</style>
