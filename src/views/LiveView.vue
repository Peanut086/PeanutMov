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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { ChannelPrefs, EpgChannelRef, LiveChannelExtrasMap, LiveGroup, LiveRecord } from '@/types';
import type { LiveChannel } from '@/sources/live/liveParsers';
import type { EpgProgramme } from '@/services/epgService';

import AppHeader from '@/components/layout/AppHeader.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import SearchBar from '@/components/common/SearchBar.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { useVirtualGrid } from '@/components/media/useVirtualGrid';
import LivePlayer from '@/components/live/LivePlayer.vue';
import ChannelGroupSheet from '@/components/live/ChannelGroupSheet.vue';
import ChannelLogo from '@/components/live/ChannelLogo.vue';
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
import { appEvents } from '@/services/events';
import { LIVE_DEAD_STREAK, LIVE_AUTO_SWITCH_MAX, EPG_PREFETCH_MAX, CATCHUP_MAX_DAYS } from '@/shared/constants';
import { CATCHUP_TOKENS, validateCatchupTemplate } from '@/shared/catchupTemplate';
import { filterChannelsByQuery } from '@/shared/channelSearch';
import { prefersReducedMotion } from '@/composables/useSpring';
import { useDebounce } from '@/composables/useDebounce';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { logger } from '@/shared/logger';
import { toErrorShape } from '@/shared/errors';

const toast = useToast();
const ui = useUiStore();
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
/** FIX-L1: 自动切路计数器（达到上限后停止切路，避免死循环） */
const autoSwitchCount = ref(0);
/** FIX-L5: 全源不可用时展示引导卡片 */
const allChannelsDead = ref(false);

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

/**
 * 起播状态计数复位。
 *
 * 换源/重试是「新一轮起播」：上一源攒下的自动切路次数与失效频道名单若不带清零，
 * `LIVE_AUTO_SWITCH_MAX` 会在新源第一次失败时就触顶（直接弹「所有频道不可用」），
 * 上一源判死的频道名也会误伤新源里的同名频道。
 */
function resetSwitchCounters(): void {
  autoSwitchCount.value = 0;
  allChannelsDead.value = false;
  deadNames.value = new Set();
  failStreak.clear();
}

/** 起播超时/失败：累计失效 → 切同组下一路（同名多路优先，排除 dead 频道） */
function onChannelTimeout(failedUrl: string): void {
  /*
   * 只认「当前正在播的那一路」的失败：引擎销毁前可能还有异步 error 回调在飞，
   * 用户此时已手动换台，照单处理会把好端端的新流当成失败继续往下切，
   * 并给根本没试过的频道记一次失效。
   */
  if (playing.value?.url !== failedUrl) return;

  const flat = groups.value.flatMap((g) => g.channels);
  const failed = flat.find((c) => c.url === failedUrl) ?? null;
  if (failed) {
    const streak = (failStreak.get(failed.name) ?? 0) + 1;
    failStreak.set(failed.name, streak);
    if (streak >= LIVE_DEAD_STREAK) deadNames.value = new Set([...deadNames.value, failed.name]);
  }

  autoSwitchCount.value++;
  if (autoSwitchCount.value >= LIVE_AUTO_SWITCH_MAX) {
    allChannelsDead.value = true;
    playing.value = null;
    toast.error('多个频道无法播放，请检查网络或更换直播源');
    return;
  }

  const candidates = flat.filter((c) => !isDead(c.name) && c.url !== failedUrl);
  if (candidates.length === 0) {
    allChannelsDead.value = true;
    playing.value = null;
    toast.error('当前直播源所有频道均不可用，请更换直播源');
    return;
  }

  const sameName = failed ? candidates.filter((c) => c.name === failed.name) : [];
  const idx = flat.findIndex((c) => c.url === failedUrl);
  const nextInOrder = candidates.find((c) => flat.indexOf(c) > idx);
  const next = sameName[0] ?? nextInOrder ?? candidates[0];

  if (next) {
    toast.info(`频道无响应，已切换到「${next.name}」`);
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

// 备份导入/恢复后直播源与频道偏好可能整体换掉，重载列表与收藏
const offLiveChanged = appEvents.on('live:changed', () => {
  void reload();
  void loadFavorites();
});

onBeforeUnmount(() => {
  offLiveChanged();
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

/* ---------- C2：频道搜索（跨全部分组） ---------- */
const channelQuery = ref('');
/**
 * 真正生效的搜索词：输入框跟手，过滤 + 排序 + 窗口重建延后 300ms 才跑。
 * 一份 IPTV 订阅动辄几千个频道，每敲一个键就全表重排一次是白白付的钱。
 */
const committedQuery = ref('');
const commitQuery = useDebounce(() => {
  committedQuery.value = channelQuery.value;
}, 300);

watch(channelQuery, (next) => {
  // 清空要立刻生效：点「清除搜索」不该再等一个防抖周期
  if (next.trim() === '') {
    resetChannelQuery();
    return;
  }
  commitQuery();
});

/** 关键词作废（切源、定位频道、清除搜索）：挂起的那一次也必须一起作废 */
function resetChannelQuery(): void {
  commitQuery.cancel();
  channelQuery.value = '';
  committedQuery.value = '';
}

const searching = computed(() => committedQuery.value.trim().length > 0);

/** 搜索命中数（不含失效沉底重排，纯过滤结果） */
const searchHits = computed<LiveChannel[]>(() =>
  searching.value ? filterChannelsByQuery(allChannels.value, committedQuery.value) : [],
);

/**
 * AC-166 排序优先级：失效沉底 > 收藏置顶 > 自定义序 > 源顺序。
 * 先按自定义序稳定排序（定义基序），再按 rank 稳定排序（rank 优先，自定义序次之）。
 * 搜索态例外：相关性优先（否则搜「cctv」时收藏的杂台会压在精确命中前面），只保留失效沉底。
 */
const visibleChannels = computed<LiveChannel[]>(() => {
  if (searching.value) {
    return [...searchHits.value].sort((a, b) => Number(isDead(a.name)) - Number(isDead(b.name)));
  }
  const ordered = sortByCustomOrder(scopeChannels.value, keyOf, currentOrder.value);
  const rank = (name: string): number => (isDead(name) ? 2 : isFavorite(name) ? 0 : 1);
  return [...ordered].sort((a, b) => rank(a.name) - rank(b.name));
});

/** 切源等于换了一份频道表，旧关键词不该继续压在新列表上 */
watch(activeId, () => {
  resetChannelQuery();
});

/* ---------- 频道列表虚拟化 ---------- */

/**
 * 一份 IPTV 订阅动辄几千个频道，每个频道是 1 个 `li` + 2 个 `button` + ChannelLogo：
 * 全量渲染时打开直播页要卡一下，改一个搜索词还要把整表重建一次。
 *
 * 行高跟海报比例无关（单行文本），所以不走 `useVirtualGrid` 的海报公式，
 * 而是量一次真实行高（含 row-gap）给它当行步长。
 */
const channelsEl = useTemplateRef<HTMLElement>('channels');

function channelRowStride(): number {
  const ul = channelsEl.value;
  // 虚拟化以后首个子节点可能已经是别的东西，只认真实行类的节点量高度
  const row = ul?.querySelector<HTMLElement>('.live-channel-row');
  if (!ul || !row) return 0;
  const gap = Number.parseFloat(getComputedStyle(ul).rowGap);
  return row.offsetHeight + (Number.isFinite(gap) ? gap : 0);
}

const {
  visibleItems: renderChannels,
  padTop: channelsPadTop,
  padBottom: channelsPadBottom,
  startIndex: channelsStartIndex,
  scrollToIndex: scrollChannelsToIndex,
} = useVirtualGrid(() => channelsEl.value ?? null, {
  items: () => visibleChannels.value,
  columns: () => 2,
  paddingX: () => 0,
  showMeta: () => false,
  rowStride: channelRowStride,
});

/**
 * 占位靠容器自身的内边距撑开（不额外插占位节点）：
 * 上内边距 = 窗口前所有行的高度，下内边距 = 窗口后所有行的高度，
 * 于是滚动条长度与滚动位置都和全量渲染时一致。
 */
const channelsStyle = computed(() => ({
  paddingTop: `calc(var(--space-3) + ${channelsPadTop.value}px)`,
  paddingBottom: `${channelsPadBottom.value}px`,
}));

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
  // 搜索态的列表是过滤后的子集，下标对不上要定位的那一行
  resetChannelQuery();
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
  // 列表已窗口化：目标行不在窗口里时 DOM 压根没有这个节点，先把窗口挪过去再滚
  await scrollChannelsToIndex(index);
  document.getElementById(`live-channel-${index}`)?.scrollIntoView({
    block: 'center',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
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

/**
 * 切源请求令牌。
 *
 * `channelsWithExtrasOf` 是网络拉取，慢源先点、快源后点时，先点的那次会后落库：
 * 频道列表、分组和「自动播第一个频道」全被盖回旧源，而高亮仍停在后点的源上。
 * 递增号在每次写入前复核；拉取本身没有 AbortSignal 入口，所以只丢结果不取消请求。
 */
let sourceToken = 0;

async function selectRecord(id: string, focusName: string | null = null): Promise<void> {
  const record = records.value.find((r) => r.id === id);
  if (!record) return;
  const token = ++sourceToken;
  activeId.value = id;
  activeScope.value = 'all';
  playing.value = null;
  channelSwitching.value = false;
  channelsLoading.value = true;
  channelsError.value = null;
  resetSwitchCounters();
  try {
    const [data, nextPrefs] = await Promise.all([
      liveService.channelsWithExtrasOf(record),
      channelPrefsService.get(record.id),
    ]);
    if (token !== sourceToken) return;
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
    if (token !== sourceToken) return;
    channelsError.value = describeSourceError(e);
  } finally {
    // 只有仍代表最新一次切源时才回收 loading，否则会把后一次请求的骨架屏提前撤掉
    if (token === sourceToken) channelsLoading.value = false;
  }
  if (token !== sourceToken) return;
  if (focusName) await focusChannel(focusName);
  prefetchEpg();
}

async function loadPrefs(): Promise<void> {
  if (!activeId.value) return;
  const id = activeId.value;
  // 共享同一次切源的代次，但不递增：这是当前源的附属读取，不该作废在飞的切源拉取
  const token = sourceToken;
  try {
    const nextPrefs = await channelPrefsService.get(id);
    // 期间切了源：这份 prefs 属于旧源，写下去会盖掉新源刚落库的分组与排序
    if (token !== sourceToken || activeId.value !== id) return;
    prefs.value = nextPrefs;
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function playChannel(channel: { name: string; url: string }): void {
  // 手动换台只重置自动切路预算；失效名单是「沉底」依据，不清，否则每次点台都把死频道捞回来
  autoSwitchCount.value = 0;
  allChannelsDead.value = false;
  if (playing.value && playing.value.url !== channel.url) {
    channelSwitching.value = true;
  }
  playing.value = { url: channel.url, title: channel.name };
}

/** OPT-12: 新流可播放后淡入 */
function onPlayerCanplay(): void {
  channelSwitching.value = false;
}

/** FIX-L5: 重试当前直播源所有频道 */
function retryAllChannels(): void {
  resetSwitchCounters();
  void reload();
}

/** FIX-L5: 切换到下一个直播源 */
function switchToNextSource(): void {
  if (records.value.length <= 1) return;
  const idx = records.value.findIndex((r) => r.id === activeId.value);
  const nextIdx = (idx + 1) % records.value.length;
  const nextRecord = records.value[nextIdx];
  if (nextRecord) void selectRecord(nextRecord.id);
}

/** FIX-L5: 跳转到导入直播源页面 */
function goImportSource(): void {
  void router.push('/settings/sources/import');
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

/**
 * 删除直播源前先确认：这一步连带清掉该源的自定义分组/排序（`channelPrefsService.remove`），
 * 而重建只能回到「重新填 URL」，没有可撤销的还原路径。
 */
async function removeRecord(record: LiveRecord): Promise<void> {
  const ok = await ui.confirm({
    title: `删除「${record.name}」？`,
    message: '该源的频道列表、自定义分组与排序一并清除，需要重新粘贴源地址才能恢复。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
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
  } catch (e) {
    // 确认之后失败必须说话，否则用户以为已经删掉了
    toast.error(toErrorShape(e).message);
  }
}

/* ---------- 回看设置（P1-01 / FR-68：源级模板 + 回看天数） ---------- */

/** 合法占位符清单（与 `CATCHUP_TOKENS` 同源，避免帮助文案与实现漂移） */
const catchupTokenHint = CATCHUP_TOKENS.map((token) => `{${token}}`).join(' ');
const catchupDaysMax = CATCHUP_MAX_DAYS;

const catchupOpen = ref(false);
const catchupTarget = ref<LiveRecord | null>(null);
const catchupEnabled = ref(true);
const catchupTemplate = ref('');
const catchupDays = ref(1);
const catchupError = ref<string | null>(null);
const catchupSaving = ref(false);

/** 输入过程中的行内校验（空模板不算错，保存时才提示） */
const catchupTemplateError = computed(() => {
  const text = catchupTemplate.value.trim();
  return text ? validateCatchupTemplate(text) : null;
});

function openCatchup(record: LiveRecord): void {
  catchupTarget.value = record;
  const settings = record.catchup;
  catchupEnabled.value = settings?.enabled ?? true;
  catchupTemplate.value = settings?.template ?? '';
  catchupDays.value = settings?.days ?? 1;
  catchupError.value = null;
  // 单层弹层：先关「直播源管理」再开「回看设置」，避免双层 BottomSheet 抢焦点/双 Escape
  addOpen.value = false;
  catchupOpen.value = true;
}

async function saveCatchup(): Promise<void> {
  const record = catchupTarget.value;
  if (!record || catchupSaving.value) return;
  const invalid = validateCatchupTemplate(catchupTemplate.value.trim());
  if (invalid) {
    catchupError.value = invalid;
    return;
  }
  catchupSaving.value = true;
  catchupError.value = null;
  try {
    const updated = await liveService.updateCatchup(record.id, {
      enabled: catchupEnabled.value,
      template: catchupTemplate.value,
      days: catchupDays.value,
    });
    records.value = records.value.map((item) => (item.id === updated.id ? updated : item));
    catchupTarget.value = updated;
    catchupDays.value = updated.catchup?.days ?? 1;
    toast.success(`已保存「${updated.name}」的回看设置`);
    catchupOpen.value = false;
  } catch (e) {
    // 契约/校验类错误（含未知占位符清单）直接展示在行内，便于用户修正
    catchupError.value = toErrorShape(e).message;
  } finally {
    catchupSaving.value = false;
  }
}

async function clearCatchup(): Promise<void> {
  const record = catchupTarget.value;
  if (!record || catchupSaving.value) return;
  catchupSaving.value = true;
  catchupError.value = null;
  try {
    const updated = await liveService.updateCatchup(record.id, null);
    records.value = records.value.map((item) => (item.id === updated.id ? updated : item));
    catchupTemplate.value = '';
    catchupEnabled.value = true;
    catchupDays.value = 1;
    catchupTarget.value = updated;
    toast.info(`已清除「${updated.name}」的回看设置`);
  } catch (e) {
    catchupError.value = toErrorShape(e).message;
  } finally {
    catchupSaving.value = false;
  }
}
</script>

<template>
  <main class="live-page" data-route="live">
    <AppHeader title="直播" back />

    <div class="live-body" data-scroll="page">
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
          :logo="currentChannel?.logo ?? null"
          :loading="channelSwitching"
          @timeout="onChannelTimeout"
          @canplay="onPlayerCanplay"
        />

        <!-- FIX-L5: 全源不可用时展示引导卡片 -->
        <div v-if="allChannelsDead" class="live-dead-guide">
          <p class="live-dead-guide__title">当前直播源不可用</p>
          <p class="live-dead-guide__desc">所有频道均无法播放，可能是网络问题或直播源已失效</p>
          <div class="live-dead-guide__actions">
            <button class="btn btn--primary btn--sm" type="button" @click="retryAllChannels">
              重试
            </button>
            <button
              v-if="records.length > 1"
              class="btn btn--ghost btn--sm"
              type="button"
              @click="switchToNextSource"
            >
              切换直播源
            </button>
            <button class="btn btn--ghost btn--sm" type="button" @click="goImportSource">
              导入新直播源
            </button>
          </div>
        </div>

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

        <!-- C2：频道搜索——跨全部分组，命名归一化后匹配（cctv 1 / CCTV-1 高清 都能命中） -->
        <div v-if="allChannels.length > 0" class="live-search">
          <SearchBar v-model="channelQuery" placeholder="搜索频道，如 cctv1 / 卫视" />
          <p v-if="searching" class="live-search__summary">
            跨全部分组找到 <strong>{{ searchHits.length }}</strong> 个频道
          </p>
        </div>

        <!-- EXT-06：作用域 chips + 分组管理 / 排序入口 -->
        <div class="live-tools">
          <div v-if="scopeList.length > 1 && !searching" class="live-groups">
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
              :disabled="visibleChannels.length === 0 || searching"
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

        <!-- C2：搜不到时给出可行动出口，而不是复用「该分组暂无频道」 -->
        <div v-else-if="searching && visibleChannels.length === 0" class="live-empty-scope">
          <p>没找到「{{ committedQuery.trim() }}」</p>
          <button
            class="btn btn--secondary btn--sm live-empty-scope__add"
            type="button"
            @click="resetChannelQuery"
          >
            清除搜索
          </button>
        </div>

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

        <ul v-else ref="channels" class="live-channels state-enter" :style="channelsStyle">
          <li
            v-for="(channel, idx) in renderChannels"
            :id="`live-channel-${channelsStartIndex + idx}`"
            :key="channel.url"
            class="live-channel-row"
          >
            <button
              class="live-channel"
              :class="{
                'live-channel--playing': playing?.url === channel.url,
                'live-channel--dead': isDead(channel.name),
                'live-channel--focus': focusUrl === channel.url,
                'live-channel--dual': searching,
              }"
              type="button"
              @click="playChannel(channel)"
            >
              <ChannelLogo :src="channel.logo" :name="channel.name" :size="26" />
              <span class="live-channel__text">
                <span class="live-channel__name truncate-1">{{ channel.name }}</span>
                <span v-if="searching" class="live-channel__group truncate-1">
                  {{ channel.group || '未分组' }}
                </span>
              </span>
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
                <span v-if="record.catchup?.template" class="live-manage__count">· 回看 {{ record.catchup.days }} 天</span>
              </span>
              <span class="live-manage__actions">
                <button
                  class="btn btn--secondary btn--sm"
                  type="button"
                  @click="openCatchup(record)"
                >
                  回看
                </button>
                <button
                  class="btn btn--secondary btn--sm live-manage__remove"
                  type="button"
                  @click="removeRecord(record)"
                >
                  删除
                </button>
              </span>
            </li>
          </ul>
        </template>
      </div>
    </BottomSheet>

    <!-- EXT-06/FR-68（P1-01）源级回看模板 + 回看天数 -->
    <BottomSheet v-model="catchupOpen" title="回看设置">
      <div class="live-catchup">
        <p class="live-catchup__source truncate-1">
          {{ catchupTarget?.name ?? '' }}
        </p>
        <p class="field__hint">
          按节目时间渲染回看地址；频道自带 m3u catchup-source 时优先用频道的模板。
        </p>

        <div class="live-catchup__switch">
          <span class="field__label">启用源级回看</span>
          <ToggleSwitch v-model="catchupEnabled" label="启用源级回看" />
        </div>

        <label class="field__label" for="catchup-template">回看模板</label>
        <textarea
          id="catchup-template"
          v-model="catchupTemplate"
          class="field__input live-catchup__template"
          :class="{ 'field__input--error': Boolean(catchupTemplateError) }"
          rows="3"
          spellcheck="false"
          placeholder="https://cdn.example.com/{channelId}/{date}/{start}-{end}.m3u8"
        />
        <p class="live-catchup__tokens">合法占位符：{{ catchupTokenHint }}</p>

        <label class="field__label" for="catchup-days">回看天数（1~{{ catchupDaysMax }}，默认 1）</label>
        <input
          id="catchup-days"
          v-model.number="catchupDays"
          class="field__input"
          type="number"
          inputmode="numeric"
          :min="1"
          :max="catchupDaysMax"
        />

        <p v-if="catchupTemplateError" class="field__error" role="alert">
          {{ catchupTemplateError }}
        </p>
        <p v-if="catchupError" class="field__error" role="alert">{{ catchupError }}</p>

        <div class="live-catchup__actions">
          <button
            class="btn btn--primary btn--md"
            type="button"
            :disabled="catchupSaving"
            @click="saveCatchup"
          >
            <LoadingSpinner v-if="catchupSaving" :size="16" />
            {{ catchupSaving ? '正在保存…' : '保存' }}
          </button>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="catchupSaving || !catchupTarget?.catchup"
            @click="clearCatchup"
          >
            清除设置
          </button>
        </div>
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
            <ChannelLogo :src="channel.logo" :name="channel.name" :size="24" />
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

.live-search {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4) 0;
}

.live-search__summary {
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.live-search__summary strong {
  color: var(--color-brand-text);
  font-variant-numeric: tabular-nums;
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
  transition: var(--transition-color);
}

/* 批次 22：整行按下去要有反馈，否则长列表里点哪一下都不知道成没成 */
.live-channel:active {
  background-color: var(--color-bg-pressed);
}

.live-channel__text {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}

.live-channel__name {
  min-width: 0;
}

/* 搜索态跨分组，必须标出命中的台来自哪个分组 */
.live-channel__group {
  color: var(--color-text-tertiary);
  font: var(--text-caption);
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

.live-channel--dual {
  min-height: 56px;
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

.live-channel__fav:active {
  color: var(--color-text-primary);
  background-color: var(--color-overlay-press);
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

/* P1-01：行内操作组（回看 / 删除） */
.live-manage__actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* P1-01：回看设置弹层 */
.live-catchup {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.live-catchup__source {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.live-catchup__switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.live-catchup__template {
  padding: var(--space-3) var(--space-4);
  font: var(--text-caption);
  font-family: var(--font-family-number);
  resize: vertical;
}

.live-catchup__tokens {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  word-break: break-word;
}

.live-catchup__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
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

/* FIX-L5: 全源不可用引导卡片 */
.live-dead-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-4);
  margin: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
}

.live-dead-guide__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.live-dead-guide__desc {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  text-align: center;
}

.live-dead-guide__actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: center;
}
</style>
