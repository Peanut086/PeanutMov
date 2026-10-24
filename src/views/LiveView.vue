<script setup lang="ts">
/**
 * 直播（CHG-13，v1）
 *
 * 顶部播放器 + 播放列表选择 chips + 频道分组列表。
 * 频道按需拉取解析（liveService 5min 缓存），不落库、不写历史（v1 口径）。
 * 添加直播源：底部「添加直播源」→ 名称 + m3u/txt 地址。
 */
import { computed, onMounted, ref } from 'vue';

import type { LiveGroup, LiveRecord } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import LivePlayer from '@/components/live/LivePlayer.vue';
import { liveService } from '@/services/liveService';
import { useToast } from '@/composables/useToast';
import { toErrorShape } from '@/shared/errors';

const toast = useToast();

const records = ref<LiveRecord[]>([]);
const activeId = ref<string | null>(null);
const groups = ref<LiveGroup[]>([]);
const activeGroup = ref<string | null>(null);
const channelsLoading = ref(false);
const channelsError = ref<string | null>(null);

const playing = ref<{ url: string; title: string } | null>(null);

const addOpen = ref(false);
const addName = ref('');
const addUrl = ref('');
const adding = ref(false);

const loading = ref(true);
const error = ref<string | null>(null);

const activeRecord = computed(() => records.value.find((r) => r.id === activeId.value) ?? null);

onMounted(() => {
  void reload();
});

async function reload(): Promise<void> {
  error.value = null;
  try {
    records.value = await liveService.list();
    if (records.value.length === 0) {
      activeId.value = null;
      groups.value = [];
      return;
    }
    const next = records.value.find((r) => r.id === activeId.value) ?? records.value[0];
    if (next) await selectRecord(next.id);
  } catch (e) {
    error.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}

async function selectRecord(id: string): Promise<void> {
  const record = records.value.find((r) => r.id === id);
  if (!record) return;
  activeId.value = id;
  activeGroup.value = null;
  playing.value = null;
  channelsLoading.value = true;
  channelsError.value = null;
  try {
    groups.value = await liveService.channelsOf(record);
    // 默认选中第一个分组并自动播第一个频道（打开即看，减少一次点击）
    const first = groups.value[0];
    if (first) {
      activeGroup.value = first.name;
      const channel = first.channels[0];
      if (channel) playing.value = { url: channel.url, title: channel.name };
    }
  } catch (e) {
    channelsError.value = toErrorShape(e).message;
  } finally {
    channelsLoading.value = false;
  }
}

const visibleChannels = computed(() => {
  if (activeGroup.value === null) {
    return groups.value.flatMap((g) => g.channels);
  }
  return groups.value.find((g) => g.name === activeGroup.value)?.channels ?? [];
});

function playChannel(channel: { name: string; url: string }): void {
  playing.value = { url: channel.url, title: channel.name };
}

async function submitAdd(): Promise<void> {
  if (adding.value) return;
  adding.value = true;
  try {
    const record = await liveService.add({ name: addName.value, url: addUrl.value });
    addOpen.value = false;
    addName.value = '';
    addUrl.value = '';
    toast.success(`已添加「${record.name}」（${record.channelCount ?? 0} 个频道）`);
    await reload();
    activeId.value = record.id;
    await selectRecord(record.id);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    adding.value = false;
  }
}

async function removeRecord(record: LiveRecord): Promise<void> {
  await liveService.remove(record.id);
  toast.info(`已删除「${record.name}」`);
  if (activeId.value === record.id) {
    activeId.value = null;
    playing.value = null;
    groups.value = [];
  }
  await reload();
}
</script>

<template>
  <main class="live-page" data-route="live">
    <AppHeader title="直播" back />

    <div class="live-body">
      <div v-if="loading" class="live-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在读取直播源…</span>
      </div>

      <ErrorState
        v-else-if="error"
        :error="{ code: 'E_DB', message: error, detail: null, retryable: true, httpStatus: null }"
        @retry="reload"
      />

      <EmptyState
        v-else-if="records.length === 0"
        variant="source"
        title="还没有直播源"
        description="添加 m3u / TVBox txt 直播列表地址，或导入含 lives 字段的 TVBox 订阅（会自动识别）。"
        action-text="添加直播源"
        @action="addOpen = true"
      />

      <template v-else>
        <!-- 播放列表选择 -->
        <div class="live-sources">
          <button
            v-for="record in records"
            :key="record.id"
            class="live-source-chip"
            :class="{ 'live-source-chip--active': record.id === activeId }"
            type="button"
            @click="selectRecord(record.id)"
          >
            {{ record.name }}
          </button>
        </div>

        <LivePlayer :url="playing?.url ?? null" :title="playing?.title ?? ''" />

        <!-- 分组 chips -->
        <div v-if="groups.length > 0" class="live-groups">
          <button
            v-for="group in groups"
            :key="group.name"
            class="live-group-chip"
            :class="{ 'live-group-chip--active': group.name === activeGroup }"
            type="button"
            @click="activeGroup = group.name"
          >
            {{ group.name }}
          </button>
        </div>

        <div v-if="channelsLoading" class="live-loading" role="status">
          <LoadingSpinner :size="16" />
          <span>正在拉取频道列表…</span>
        </div>
        <p v-else-if="channelsError" class="live-error">
          {{ channelsError }}
          <button class="live-retry" type="button" @click="activeRecord && selectRecord(activeRecord.id)">
            重试
          </button>
        </p>

        <ul v-else class="live-channels">
          <li v-for="channel in visibleChannels" :key="channel.url">
            <button
              class="live-channel"
              :class="{ 'live-channel--playing': playing?.url === channel.url }"
              type="button"
              @click="playChannel(channel)"
            >
              {{ channel.name }}
            </button>
          </li>
        </ul>

        <button class="btn btn--secondary btn--md live-add" type="button" @click="addOpen = true">
          管理直播源
        </button>
      </template>
    </div>

    <BottomSheet v-model="addOpen" title="直播源管理">
      <div class="live-add-form">
        <label class="field__label" for="live-name">名称</label>
        <input
          id="live-name"
          v-model="addName"
          class="field__input"
          type="text"
          maxlength="30"
          placeholder="如：央卫视聚合"
        />
        <label class="field__label" for="live-url">播放列表地址（m3u / TVBox txt）</label>
        <input
          id="live-url"
          v-model="addUrl"
          class="field__input"
          type="url"
          inputmode="url"
          placeholder="https://example.com/live.m3u"
          @keydown.enter.prevent="submitAdd"
        />
        <button
          class="btn btn--primary btn--md live-add__submit"
          type="button"
          :disabled="adding || addName.trim().length === 0 || addUrl.trim().length === 0"
          @click="submitAdd"
        >
          <LoadingSpinner v-if="adding" :size="16" />
          {{ adding ? '正在验证…' : '添加' }}
        </button>

        <template v-if="records.length > 0">
          <p class="field__label live-manage__title">已添加（{{ records.length }}）</p>
          <ul class="live-manage">
            <li v-for="record in records" :key="record.id" class="live-manage__row">
              <span class="live-manage__name truncate-1">
                {{ record.name }}
                <span class="live-manage__count">{{ record.channelCount ?? '?' }} 频道</span>
              </span>
              <button
                class="btn btn--secondary btn--sm live-manage__remove"
                type="button"
                @click="removeRecord(record)"
              >
                删除
              </button>
            </li>
          </ul>
        </template>
      </div>
    </BottomSheet>
  </main>
</template>

<style scoped>
.live-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-base);
}

.live-body {
  flex: 1 1 auto;
  padding-bottom: calc(var(--space-6) + var(--safe-bottom));
}

.live-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.live-sources {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding: var(--space-3) var(--space-4) 0;
  scrollbar-width: none;
}

.live-source-chip {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.live-source-chip--active {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  color: var(--color-brand-text);
}

.live-groups {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding: var(--space-3) var(--space-4) 0;
  scrollbar-width: none;
}

.live-group-chip {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.live-group-chip--active {
  color: var(--color-brand);
  font-weight: 600;
}

.live-channels {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
}

.live-channel {
  width: 100%;
  min-height: 44px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-body);
  text-align: left;
}

.live-channel--playing {
  border-color: var(--color-brand);
  color: var(--color-brand-text);
}

.live-error {
  padding: var(--space-4);
  font: var(--text-caption);
  color: var(--color-danger);
  text-align: center;
}

.live-retry {
  margin-left: var(--space-2);
  color: var(--color-brand);
  text-decoration: underline;
}

.live-add {
  margin: var(--space-4) var(--space-4) 0;
  width: calc(100% - 2 * var(--space-4));
}

.live-add-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.live-add__submit {
  margin-top: var(--space-3);
}

.live-manage__title {
  margin-top: var(--space-4);
}

.live-manage {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.live-manage__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.live-manage__name {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-body);
  color: var(--color-text-primary);
}

.live-manage__count {
  margin-left: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.live-manage__remove {
  flex: 0 0 auto;
  color: var(--color-danger);
}
</style>
