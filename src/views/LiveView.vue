<script setup lang="ts">
/**
 * 直播（CHG-13，v1）
 *
 * 顶部播放器 + 播放列表选择 chips + 频道分组列表。
 * 频道按需拉取解析（liveService 5min 缓存），不落库、不写历史（v1 口径）。
 * 添加直播源：底部「添加直播源」→ 名称 + m3u/txt 地址。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { LiveGroup, LiveRecord } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import LivePlayer from '@/components/live/LivePlayer.vue';
import { liveService } from '@/services/liveService';
import { epgService, type EpgProgramme } from '@/services/epgService';
import { kvRepo } from '@/db/repositories/kvRepo';
import { LIVE_DEAD_STREAK } from '@/shared/constants';
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

/* ---------- v1.7/CHG-23：EPG / 收藏 / 失效沉底 / 超时切路 ---------- */

/** 当前频道的节目单（现在播 + 接下来） */
const epgNow = ref<EpgProgramme | null>(null);
const epgNext = ref<EpgProgramme[]>([]);

/** 频道收藏（channel name 集合，落 kv，跨会话保留） */
const KV_LIVE_FAVORITES = 'live-channel-favorites';
const favoriteNames = ref<Set<string>>(new Set());

/** 失效频道：起播超时累计 ≥ LIVE_DEAD_STREAK 次沉底标记 */
const deadNames = ref<Set<string>>(new Set());
const failStreak = new Map<string, number>();

async function loadFavorites(): Promise<void> {
  const list = await kvRepo.get<string[]>(KV_LIVE_FAVORITES);
  favoriteNames.value = new Set(Array.isArray(list) ? list : []);
}

async function toggleFavorite(name: string): Promise<void> {
  const next = new Set(favoriteNames.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  favoriteNames.value = next;
  await kvRepo.set(KV_LIVE_FAVORITES, [...next]);
}

function isFavorite(name: string): boolean {
  return favoriteNames.value.has(name);
}

function isDead(name: string): boolean {
  return deadNames.value.has(name);
}

/** EPG：频道切换后拉取当日节目单（失败静默，不影响播放） */
watch(
  () => playing.value?.title,
  async (channel) => {
    epgNow.value = null;
    epgNext.value = [];
    if (!channel) return;
    const programmes = await epgService.programmes(channel);
    epgNow.value = epgService.nowPlaying(programmes);
    epgNext.value = epgService.upNext(programmes);
  },
);

/** 起播超时/失败：累计失效 → 切同组下一路（同名多路优先） */
function onChannelTimeout(failedUrl: string): void {
  const flat = groups.value.flatMap((g) => g.channels);
  const failed = flat.find((c) => c.url === failedUrl) ?? null;
  if (failed) {
    const streak = (failStreak.get(failed.name) ?? 0) + 1;
    failStreak.set(failed.name, streak);
    if (streak >= LIVE_DEAD_STREAK) deadNames.value = new Set([...deadNames.value, failed.name]);
  }
  const sameName = failed ? flat.filter((c) => c.name === failed.name && c.url !== failedUrl) : [];
  const idx = flat.findIndex((c) => c.url === failedUrl);
  const next = sameName[0] ?? (idx >= 0 ? flat[idx + 1] : undefined) ?? flat[0];
  if (next && next.url !== failedUrl) {
    toast.info(`频道无响应，已切换到「${next.name}」`);
    playing.value = { url: next.url, title: next.name };
  } else if (failed) {
    toast.error(`「${failed.name}」暂时无法播放`);
  }
}

const addOpen = ref(false);
const addName = ref('');
const addUrl = ref('');
const adding = ref(false);

const loading = ref(true);
const error = ref<string | null>(null);

const activeRecord = computed(() => records.value.find((r) => r.id === activeId.value) ?? null);

onMounted(() => {
  void reload();
  void loadFavorites();
  window.addEventListener('keydown', onDigitKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDigitKey);
});

/* ---------- v1.7/CHG-23：数字快速换台（1.5s 内连按数字，跳到第 N 个频道） ---------- */

let digitBuffer = '';
let digitTimer: ReturnType<typeof setTimeout> | null = null;

function onDigitKey(event: KeyboardEvent): void {
  if (!/^[0-9]$/.test(event.key)) return;
  digitBuffer += event.key;
  if (digitTimer !== null) clearTimeout(digitTimer);
  digitTimer = setTimeout(() => {
    const target = visibleChannels.value[Number.parseInt(digitBuffer, 10) - 1];
    digitBuffer = '';
    digitTimer = null;
    if (target) playChannel(target);
  }, 1500);
}

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
    error.value = describeSourceError(e);
  } finally {
    loading.value = false;
  }
}

/**
 * 直播源请求失败 → 用户可读原因。
 *
 * `httpClient` 把 fetch 层失败统一映射成 `E_NETWORK`（"网络不可用，请检查网络"），
 * 但直播源失败绝大多数是「源站挂了 / 域名被污染」而不是设备断网——按原文案展示会让
 * 用户去查 WiFi。这里用 `navigator.onLine` 区分：确实离线才保留网络文案，
 * 否则按「源不可用」提示换源。
 */
function describeSourceError(e: unknown): string {
  const shape = toErrorShape(e);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (shape.code === 'E_NETWORK' && !offline) {
    return '该直播源暂时不可用，请切换其他直播源或稍后重试';
  }
  return shape.message;
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
    channelsError.value = describeSourceError(e);
  } finally {
    channelsLoading.value = false;
  }
}

const visibleChannels = computed(() => {
  const list =
    activeGroup.value === null
      ? groups.value.flatMap((g) => g.channels)
      : (groups.value.find((g) => g.name === activeGroup.value)?.channels ?? []);
  // v1.7/CHG-23：收藏置顶，失效沉底（各自组内保持原顺序）
  const rank = (name: string): number => (isDead(name) ? 2 : isFavorite(name) ? 0 : 1);
  return [...list].sort((a, b) => rank(a.name) - rank(b.name));
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

        <LivePlayer :url="playing?.url ?? null" :title="playing?.title ?? ''" @timeout="onChannelTimeout" />

        <!-- v1.7/CHG-23：EPG 节目单（现在播 / 接下来） -->
        <div v-if="epgNow" class="live-epg">
          <p class="live-epg__now">
            <span class="live-epg__badge">正在播</span> {{ epgNow.start }} {{ epgNow.title }}
          </p>
          <p v-for="programme in epgNext" :key="`${programme.start}-${programme.title}`" class="live-epg__next">
            <span class="live-epg__badge live-epg__badge--muted">接下来</span> {{ programme.start }} {{ programme.title }}
          </p>
        </div>

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
              :class="{ 'live-channel--playing': playing?.url === channel.url, 'live-channel--dead': isDead(channel.name) }"
              type="button"
              @click="playChannel(channel)"
            >
              {{ channel.name }}
              <span v-if="isDead(channel.name)" class="live-channel__dead-badge">失效</span>
            </button>
            <button
              class="live-channel__fav"
              :class="{ 'live-channel__fav--on': isFavorite(channel.name) }"
              type="button"
              :aria-label="isFavorite(channel.name) ? `取消收藏 ${channel.name}` : `收藏 ${channel.name}`"
              @click.stop="toggleFavorite(channel.name)"
            >
              {{ isFavorite(channel.name) ? '★' : '☆' }}
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
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.live-channel--playing {
  border-color: var(--color-brand);
  color: var(--color-brand-text);
}

.live-channel--dead {
  opacity: 0.55;
}

.live-channel__dead-badge {
  font: var(--text-caption);
  color: var(--color-danger);
}

.live-channel__fav {
  flex: 0 0 auto;
  width: 36px;
  height: 44px;
  font-size: 18px;
  color: var(--color-text-tertiary);
}

.live-channel__fav--on {
  color: var(--color-brand-text);
}

/* v1.7/CHG-23：EPG 节目单 */
.live-epg {
  margin: var(--space-2) var(--space-4) 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  font: var(--text-caption);
  color: var(--color-text-secondary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.live-epg__badge {
  display: inline-block;
  margin-right: var(--space-1);
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  background-color: var(--color-brand-soft, rgba(124, 92, 255, 0.16));
  color: var(--color-brand-text);
  font-size: 11px;
}

.live-epg__badge--muted {
  background-color: transparent;
  border: 1px solid var(--color-divider);
  color: var(--color-text-tertiary);
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
