<script setup lang="ts">
/**
 * 直播（CHG-13，v1 / EXT-06）
 *
 * 顶部播放器 + 直播源 chips + 频道作用域（全部 / 自定义分组 / 源分组）+ 频道列表。
 * 频道按需拉取解析（liveService 5min 缓存），不落库、不写历史（v1 口径）。
 * EXT-06 新增：
 * - FR-69 分组管理（`ChannelGroupSheet`）与自定义排序（`ChannelSortList`，AC-166/167）
 * - FR-68 回看入口**不在本页**（需求 §5.3 / REV-02）：回看入口只在节目单页（EpgView），
 *   本页只保留「完整节目单 ›」跳转
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { ChannelPrefs, EpgChannelRef, LiveChannelExtrasMap, LiveGroup, LiveRecord } from '@/types';
import type { LiveChannel } from '@/sources/live/liveParsers';
import type { EpgProgramme } from '@/services/epgService';

import AppHeader from '@/components/layout/AppHeader.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import LivePlayer from '@/components/live/LivePlayer.vue';
import ChannelGroupSheet from '@/components/live/ChannelGroupSheet.vue';
import ChannelSortList from '@/components/live/ChannelSortList.vue';
import { liveService } from '@/services/liveService';
import { epgService } from '@/services/epgService';
import { channelPrefsService, emptyPrefs, sortByCustomOrder } from '@/services/channelPrefsService';
import {
  channelKeyFromLive,
  channelRefFromLive,
  extrasOfUrl,
} from '@/services/channelIdentity';
import { kvRepo } from '@/db/repositories/kvRepo';
import { LIVE_DEAD_STREAK, EPG_PREFETCH_MAX } from '@/shared/constants';
import { useToast } from '@/composables/useToast';
import { logger } from '@/shared/logger';
import { toErrorShape } from '@/shared/errors';

const toast = useToast();
const router = useRouter();
const route = useRoute();

const records = ref<LiveRecord[]>([]);
const activeId = ref<string | null>(null);
const groups = ref<LiveGroup[]>([]);
/** EXT-06：频道平铺表（分组 / 排序共用；回看判定已迁至 EpgView） */
const allChannels = ref<LiveChannel[]>([]);
const extras = ref<LiveChannelExtrasMap>({});
const prefs = ref<ChannelPrefs | null>(null);
/** 当前作用域：`all` | `g:<groupId>` | `s:<源分组名>` */
const activeScope = ref<string>('all');
const channelsLoading = ref(false);
const channelsError = ref<string | null>(null);

const playing = ref<{ url: string; title: string } | null>(null);
/** OPT-12: 频道切换过渡态（淡出/淡入） */
const channelSwitching = ref(false);

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

/**
 * REV-13：与分组 / 排序 / 节目单 / 提醒服务同口径的频道身份键。
 * 有 tvgId 用 `id:`，否则 `nm:`——统一走 `channelKeyFromLive`，不再只传频道名。
 */
function keyOf(channel: LiveChannel): string {
  return channelKeyFromLive({
    name: channel.name,
    extras: extrasOfUrl(extras.value, channel.url),
  });
}

function channelEpgRefByName(name: string): EpgChannelRef {
  const channel = allChannels.value.find((item) => item.name === name) ?? null;
  if (!channel) return { name, tvgId: null, tvgName: null };
  return channelRefFromLive(channel, extras.value);
}

/** EPG：频道切换后拉取当日节目单（失败静默，不影响播放） */
let epgToken = 0;
watch(
  () => playing.value?.title,
  async (channel) => {
    epgNow.value = null;
    epgNext.value = [];
    if (!channel) return;
    const token = ++epgToken;
    try {
      const merged = await epgService.programmesFor(channelEpgRefByName(channel), new Date());
      if (token !== epgToken) return;
      epgNow.value = epgService.nowPlaying(merged.programmes);
      epgNext.value = epgService.upNext(merged.programmes);
    } catch {
      // EPG 缺失不影响播放
    }
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
    // REV-18: 超时自动切路时也需设置过渡态，与 playChannel 行为一致
    channelSwitching.value = true;
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
  if (digitTimer !== null) {
    clearTimeout(digitTimer);
    digitTimer = null;
  }
  // REV-34：清掉挂起的排序提示定时器
  cancelReorderToast();
  clearFocusTimer();
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
      allChannels.value = [];
      extras.value = {};
      prefs.value = null;
      return;
    }
    /*
     * REV-11：优先按 `?source=` 选中记录；缺省时用 `?channel=` 反查所属源。
     * focusName 一路透传到 selectRecord，走「只定位不播放」分支。
     */
    const focusName = queryChannelName();
    const preferred =
      querySourceId() ??
      (focusName ? liveService.findSourceIdByChannelName(focusName) : null);
    const next =
      records.value.find((r) => r.id === preferred) ??
      records.value.find((r) => r.id === activeId.value) ??
      records.value[0];
    if (next) await selectRecord(next.id, focusName);
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

/* ---------- EXT-06：作用域（全部 / 自定义分组 / 源分组） ---------- */

const scopeList = computed(() => {
  const base = prefs.value ?? emptyPrefs(activeId.value ?? '');
  const scopes = channelPrefsService.buildScopes(
    allChannels.value.map((channel) => ({
      name: channel.name,
      sourceGroup: channel.group,
      // REV-13：带上 tvgId，作用域身份键与节目单/提醒一致
      tvgId: extrasOfUrl(extras.value, channel.url)?.tvgId ?? null,
    })),
    base,
  );
  /*
   * REV-23：「全部」始终可用；自定义分组**即使为空也要保留**（否则刚建好/清空的
   * 分组 chip 会消失，用户无处进入「从源分组添加频道」）；源分组按 m3u 生成，
   * 空分组（理论上不存在）仍过滤。
   */
  return scopes.filter(
    (scope) => scope.key === 'all' || scope.key.startsWith('g:') || scope.channelKeys.length > 0,
  );
});

/**
 * REV-12：同名多路频道（同 channelKey、不同 url）全部保留。
 * 此前 `Map<string, LiveChannel>` 只留第一路，切到备用线路就再也点不到。
 */
const channelsByKey = computed<Map<string, LiveChannel[]>>(() => {
  const map = new Map<string, LiveChannel[]>();
  for (const channel of allChannels.value) {
    const key = keyOf(channel);
    const list = map.get(key);
    if (list) list.push(channel);
    else map.set(key, [channel]);
  }
  return map;
});

const scopeChannels = computed<LiveChannel[]>(() => {
  const scope = scopeList.value.find((item) => item.key === activeScope.value);
  if (!scope) return allChannels.value.slice();
  const list: LiveChannel[] = [];
  const seenKeys = new Set<string>();
  for (const key of scope.channelKeys) {
    // buildScopes 按频道逐条 push key，同名多路会出现重复 key：先去重再整组展开
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const channels = channelsByKey.value.get(key);
    if (channels) list.push(...channels);
  }
  return list;
});

const currentOrder = computed<string[] | undefined>(() => prefs.value?.orders[activeScope.value]);

/**
 * AC-166 排序优先级：失效沉底 > 收藏置顶 > 自定义序 > 源顺序。
 * 先按自定义序稳定排序（定义基序），再按 rank 稳定排序（rank 优先，自定义序次之）。
 */
const visibleChannels = computed<LiveChannel[]>(() => {
  const ordered = sortByCustomOrder(scopeChannels.value, keyOf, currentOrder.value);
  const rank = (name: string): number => (isDead(name) ? 2 : isFavorite(name) ? 0 : 1);
  return [...ordered].sort((a, b) => rank(a.name) - rank(b.name));
});

function pickDefaultScope(): string {
  const first = scopeList.value.find((scope) => scope.key !== 'all' && scope.channelKeys.length > 0);
  return first?.key ?? 'all';
}

/** 分组被删除 / 改名后当前作用域可能失效，回落到「全部」 */
watch(scopeList, (list) => {
  if (!list.some((scope) => scope.key === activeScope.value)) activeScope.value = 'all';
});

/* ---------- REV-11：从提醒/外部链接定位频道（只定位，不自动播放 AC-168） ---------- */

/** 查询参数里的频道名（`/live?channel=<name>`） */
function queryChannelName(): string | null {
  const raw = route.query.channel;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** 查询参数里的直播源 id（`/live?source=<id>`） */
function querySourceId(): string | null {
  const raw = route.query.source;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** 高亮中的频道 url（2.5s 后自动清除） */
const focusUrl = ref<string | null>(null);
let focusTimer: ReturnType<typeof setTimeout> | null = null;
let focusToken = 0;

function clearFocusTimer(): void {
  if (focusTimer !== null) {
    clearTimeout(focusTimer);
    focusTimer = null;
  }
}

/**
 * 滚动并高亮指定频道行。
 * 只在「全部」作用域里找（REV-11：进入时 activeScope 固定为 all），不改变播放状态。
 */
async function focusChannel(name: string): Promise<void> {
  const token = ++focusToken;
  activeScope.value = 'all';
  await nextTick();
  if (token !== focusToken) return;
  const list = visibleChannels.value;
  const index = Math.max(
    list.findIndex((channel) => channel.name === name),
    list.findIndex((channel) => channel.name.startsWith(name)),
  );
  if (index < 0) return;
  const target = list[index]!;
  focusUrl.value = target.url;
  await nextTick();
  document.getElementById(`live-channel-${index}`)?.scrollIntoView({
    block: 'center',
    behavior: 'smooth',
  });
  clearFocusTimer();
  focusTimer = setTimeout(() => {
    focusUrl.value = null;
    focusTimer = null;
  }, 2500);
}

/**
 * REV-18：频道列表就绪后预取 EPG（收藏 + 当前作用域前 10 个，服务层封顶 30/并发 3）。
 * 失败静默、不阻塞渲染。
 */
const PREFETCH_SCOPE_HEAD = 10;

function prefetchEpg(): void {
  const favorites = allChannels.value.filter((channel) => isFavorite(channel.name));
  const head = visibleChannels.value.slice(0, PREFETCH_SCOPE_HEAD);
  const seen = new Set<string>();
  const refs: EpgChannelRef[] = [];
  for (const channel of [...favorites, ...head]) {
    const key = keyOf(channel);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(channelRefFromLive(channel, extras.value));
  }
  if (refs.length === 0) return;
  void epgService
    .prefetch(refs, new Date(), EPG_PREFETCH_MAX)
    .catch((error) => logger.debug('EPG 预取失败（静默）', error));
}

async function selectRecord(id: string, focusName: string | null = null): Promise<void> {
  const record = records.value.find((r) => r.id === id);
  if (!record) return;
  activeId.value = id;
  activeScope.value = 'all';
  playing.value = null;
  channelSwitching.value = false;
  channelsLoading.value = true;
  channelsError.value = null;
  try {
    const [data, nextPrefs] = await Promise.all([
      liveService.channelsWithExtrasOf(record),
      channelPrefsService.get(record.id),
    ]);
    groups.value = data.groups;
    allChannels.value = data.channels;
    extras.value = data.extras;
    prefs.value = nextPrefs;
    if (focusName) {
      // REV-11：定位模式——不自动播放，只滚动高亮（AC-168）
      activeScope.value = 'all';
    } else {
      // 默认选中第一个非空作用域并自动播第一个频道（打开即看，减少一次点击）
      activeScope.value = pickDefaultScope();
      const first = scopeChannels.value[0];
      if (first) playing.value = { url: first.url, title: first.name };
    }
  } catch (e) {
    channelsError.value = describeSourceError(e);
  } finally {
    channelsLoading.value = false;
  }
  if (focusName) await focusChannel(focusName);
  prefetchEpg();
}

async function loadPrefs(): Promise<void> {
  if (!activeId.value) return;
  try {
    prefs.value = await channelPrefsService.get(activeId.value);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function playChannel(channel: { name: string; url: string }): void {
  // OPT-12: 切换频道时先淡出
  if (playing.value && playing.value.url !== channel.url) {
    channelSwitching.value = true;
  }
  playing.value = { url: channel.url, title: channel.name };
}

/** OPT-12: 新流可播放后淡入 */
function onPlayerCanplay(): void {
  channelSwitching.value = false;
}

function openEpgFull(): void {
  const title = playing.value?.title;
  if (!title) return;
  const query: Record<string, string> = { ch: title };
  if (activeId.value) query.source = activeId.value;
  const channel = allChannels.value.find((item) => item.name === title) ?? null;
  const extra = channel ? extrasOfUrl(extras.value, channel.url) : null;
  if (extra?.tvgId) query.tvgId = extra.tvgId;
  // REV-14：tvg-name 一并透传，否则节目单页 L2（tvg-name）匹配永远失效
  if (extra?.tvgName) query.tvgName = extra.tvgName;
  void router.push({ name: 'epg', query });
}

/* ---------- EXT-06 / FR-69：分组管理与自定义排序 ---------- */

const groupSheetOpen = ref(false);
const sortOpen = ref(false);
const sortBusy = ref(false);

const currentChannel = computed<LiveChannel | null>(() => {
  const title = playing.value?.title;
  if (!title) return null;
  return allChannels.value.find((channel) => channel.name === title) ?? null;
});

const currentChannelKey = computed(() => (currentChannel.value ? keyOf(currentChannel.value) : ''));

const sortItems = computed(() =>
  visibleChannels.value.map((channel) => ({ key: keyOf(channel), name: channel.name })),
);

const hasCustomOrder = computed(() => Boolean(prefs.value?.orders[activeScope.value]));

async function onGroupChanged(): Promise<void> {
  await loadPrefs();
}

/** REV-34：↑/↓ 可连点，提示合并窗口（拖拽松手不受影响，仍即时提示） */
const REORDER_TOAST_DELAY_MS = 300;
let reorderToastTimer: ReturnType<typeof setTimeout> | null = null;

function cancelReorderToast(): void {
  if (reorderToastTimer !== null) {
    clearTimeout(reorderToastTimer);
    reorderToastTimer = null;
  }
}

function scheduleReorderToast(): void {
  cancelReorderToast();
  reorderToastTimer = setTimeout(() => {
    reorderToastTimer = null;
    toast.success('已保存频道顺序');
  }, REORDER_TOAST_DELAY_MS);
}

async function onReorder(keys: string[], origin: 'drag' | 'button' = 'button'): Promise<void> {
  const sourceId = activeId.value;
  if (!sourceId || sortBusy.value) return;
  sortBusy.value = true;
  try {
    await channelPrefsService.setOrder(sourceId, activeScope.value, keys);
    await loadPrefs();
    if (origin === 'drag') {
      cancelReorderToast();
      toast.success('已保存频道顺序');
    } else {
      scheduleReorderToast();
    }
  } catch (e) {
    // 失败必须立刻可见，不能被合并窗口吞掉
    cancelReorderToast();
    toast.error(toErrorShape(e).message);
  } finally {
    sortBusy.value = false;
  }
}

async function resetOrder(): Promise<void> {
  const sourceId = activeId.value;
  if (!sourceId || sortBusy.value) return;
  sortBusy.value = true;
  try {
    await channelPrefsService.resetOrder(sourceId, activeScope.value);
    await loadPrefs();
    toast.info('已恢复源顺序');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    sortBusy.value = false;
  }
}

/* ---------- REV-23：空自定义分组 → 从源分组添加频道 ---------- */

const addToGroupOpen = ref(false);

/** 当前作用域对应的自定义分组 id（源分组/全部时为 null） */
const activeCustomGroupId = computed<string | null>(() =>
  activeScope.value.startsWith('g:') ? activeScope.value.slice(2) : null,
);

/** 可加入当前分组的频道（已在组内 / 已被其它分组占用的都列出，按归属状态展示） */
const addableChannels = computed<LiveChannel[]>(() => {
  const groupId = activeCustomGroupId.value;
  if (!groupId) return [];
  const assignments = prefs.value?.assignments ?? {};
  return allChannels.value.filter((channel) => assignments[keyOf(channel)] !== groupId);
});

/** 当前源仍存在的频道身份键（分组弹层清理孤儿排序项用） */
const channelKeysOfSource = computed<string[]>(() =>
  allChannels.value.map((channel) => keyOf(channel)),
);

async function addChannelToGroup(channel: LiveChannel): Promise<void> {
  const groupId = activeCustomGroupId.value;
  const sourceId = activeId.value;
  if (!groupId || !sourceId) return;
  try {
    await channelPrefsService.assign(sourceId, keyOf(channel), groupId);
    await loadPrefs();
    toast.success(`已把「${channel.name}」加入分组`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

/* ---------- 直播源管理 ---------- */

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
  await channelPrefsService.remove(record.id).catch(() => undefined);
  toast.info(`已删除「${record.name}」`);
  if (activeId.value === record.id) {
    activeId.value = null;
    playing.value = null;
    groups.value = [];
    allChannels.value = [];
    extras.value = {};
    prefs.value = null;
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

        <LivePlayer
          :url="playing?.url ?? null"
          :title="playing?.title ?? ''"
          :loading="channelSwitching"
          @timeout="onChannelTimeout"
          @canplay="onPlayerCanplay"
        />

        <!-- v1.7/CHG-23：EPG 节目单（现在播 / 接下来） -->
        <div v-if="epgNow" class="live-epg">
          <p class="live-epg__now">
            <span class="live-epg__badge">正在播</span> {{ epgNow.start }} {{ epgNow.title }}
          </p>
          <p v-for="programme in epgNext" :key="`${programme.start}-${programme.title}`" class="live-epg__next">
            <span class="live-epg__badge live-epg__badge--muted">接下来</span> {{ programme.start }} {{ programme.title }}
          </p>
          <button class="btn btn--ghost btn--sm live-epg__full" type="button" @click="openEpgFull">
            完整节目单 ›
          </button>
        </div>

        <!-- EXT-06：作用域 chips + 分组管理 / 排序入口 -->
        <div class="live-tools">
          <div v-if="scopeList.length > 1" class="live-groups">
            <button
              v-for="scope in scopeList"
              :key="scope.key"
              class="live-group-chip"
              :class="{ 'live-group-chip--active': scope.key === activeScope }"
              type="button"
              @click="activeScope = scope.key"
            >
              {{ scope.title }}
            </button>
          </div>
          <div class="live-tools__actions">
            <button
              class="live-tool"
              type="button"
              :disabled="visibleChannels.length === 0"
              @click="sortOpen = true"
            >
              排序
            </button>
            <button
              class="live-tool"
              type="button"
              :disabled="currentChannel === null"
              @click="groupSheetOpen = true"
            >
              分组管理
            </button>
          </div>
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

        <!-- REV-23：空自定义分组给出「从源分组添加频道」入口，而不是一句死胡同文案 -->
        <div v-else-if="visibleChannels.length === 0" class="live-empty-scope">
          <p>该分组暂无频道</p>
          <button
            v-if="activeCustomGroupId"
            class="btn btn--secondary btn--sm live-empty-scope__add"
            type="button"
            @click="addToGroupOpen = true"
          >
            从源分组添加频道
          </button>
        </div>

        <ul v-else class="live-channels">
          <li
            v-for="(channel, idx) in visibleChannels"
            :id="`live-channel-${idx}`"
            :key="channel.url"
            class="live-channel-row"
          >
            <button
              class="live-channel"
              :class="{
                'live-channel--playing': playing?.url === channel.url,
                'live-channel--dead': isDead(channel.name),
                'live-channel--focus': focusUrl === channel.url,
              }"
              type="button"
              @click="playChannel(channel)"
            >
              <span class="live-channel__name truncate-1">{{ channel.name }}</span>
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

    <!-- EXT-06/FR-69：自定义排序 -->
    <BottomSheet v-model="sortOpen" title="频道排序">
      <div class="live-sort">
        <p class="live-sort__hint">
          长按（或按住手柄）拖动调整顺序；收藏与失效标记仍会优先于自定义顺序。
        </p>
        <ChannelSortList
          :items="sortItems"
          :busy="sortBusy"
          empty-text="该分组暂无频道"
          @reorder="onReorder"
        />
        <button
          class="btn btn--secondary btn--sm live-sort__reset"
          type="button"
          :disabled="!hasCustomOrder || sortBusy"
          @click="resetOrder"
        >
          恢复源顺序
        </button>
      </div>
    </BottomSheet>

    <!-- REV-23：从源分组添加频道到当前自定义分组（复用 channelPrefsService.assign） -->
    <BottomSheet v-model="addToGroupOpen" title="添加到分组">
      <div class="live-add-form">
        <p v-if="addableChannels.length === 0" class="live-empty-scope">该分组的频道已包含全部频道</p>
        <ul v-else class="live-manage">
          <li v-for="channel in addableChannels" :key="channel.url" class="live-manage__row">
            <span class="live-manage__name truncate-1">
              {{ channel.name }}
              <span class="live-manage__count">{{ channel.group || '未分组' }}</span>
            </span>
            <button
              class="btn btn--secondary btn--sm"
              type="button"
              @click="addChannelToGroup(channel)"
            >
              加入
            </button>
          </li>
        </ul>
      </div>
    </BottomSheet>

    <!-- EXT-06/FR-69：分组管理 -->
    <ChannelGroupSheet
      v-model="groupSheetOpen"
      :live-source-id="activeId ?? ''"
      :prefs="prefs"
      :channel-key="currentChannelKey"
      :channel-name="playing?.title ?? ''"
      :channel-keys="channelKeysOfSource"
      @changed="onGroupChanged"
    />
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
  padding-bottom: var(--layout-tabbar-safe);
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

/* EXT-06：作用域 chips 与工具按钮同行 */
.live-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
}

.live-groups {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  scrollbar-width: none;
}

.live-tools__actions {
  flex: 0 0 auto;
  display: flex;
  gap: var(--space-1);
}

.live-tool {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-secondary);
  font: var(--text-caption);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.live-tool:active:not(:disabled) {
  background-color: var(--color-bg-pressed);
}

.live-tool:disabled {
  opacity: 0.4;
  cursor: default;
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

.live-empty-scope {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.live-empty-scope__add {
  margin-top: var(--space-3);
}

/* REV-11：从通知/外部链接定位到频道时的高亮（2.5s 后自动消退） */
.live-channel--focus {
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
  box-shadow: var(--shadow-2);
}

.live-channels {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
}

.live-channel-row {
  display: flex;
  align-items: stretch;
  gap: var(--space-1);
  min-width: 0;
}

.live-channel {
  flex: 1 1 auto;
  min-width: 0;
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

.live-channel__name {
  min-width: 0;
}

.live-channel--playing {
  border-color: var(--color-brand);
  color: var(--color-brand-text);
  position: relative;
}

/* OPT-12: 选中频道左侧琥珀金竖条 indicator */
.live-channel--playing::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  width: 3px;
  height: 60%;
  border-radius: var(--radius-full);
  background-color: var(--color-brand);
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
  width: 32px;
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

.live-epg__full {
  align-self: flex-end;
  margin-top: var(--space-1);
  color: var(--color-brand-text);
  font: var(--text-caption);
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

/* EXT-06：排序弹层 */
.live-sort {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-2);
}

.live-sort__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.live-sort__reset {
  align-self: center;
}
</style>
