<script setup lang="ts">
/**
 * EPG 节目单页（功能扩展-5 / EXT-06）
 *
 * 展示某频道当日节目时间表（多 EPG 源合并，`epgService.programmesFor`）。
 * - 日期切换：昨天 / 今天 / 明天
 * - 时间轴：按时间顺序列出所有节目，当前正在播的高亮并自动滚动到视口
 * - EXT-06/FR-66：右上角「EPG 源管理」→ `EpgSourceSheet`
 * - EXT-06/FR-71：未开播节目可「设置提醒」→ `ReminderSheet`
 * - EXT-06/FR-68：**回看入口只在节目单页**——已结束且在回看窗口内的节目显示「回看」，
 *   点击先渲染地址、再探测能力（AC-162），可用才跳转 `/replay/:sourceId/:programId`
 * - 数据来源：epgService（多源合并，24h 缓存；源失败静默降级）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { EpgProgramme } from '@/services/epgService';
import type { CatchupPlan } from '@/services/replayService';
import type { CatchupCapability, ChannelEpgResult, EpgChannelRef, Reminder, ReminderLead } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import EpgSourceSheet from '@/components/live/EpgSourceSheet.vue';
import ReminderSheet from '@/components/live/ReminderSheet.vue';
import { epgService } from '@/services/epgService';
import { epgSourceService } from '@/services/epgSourceService';
import { liveService } from '@/services/liveService';
import { reminderService } from '@/services/reminderService';
import { replayService } from '@/services/replayService';
import { channelKeyFromLive } from '@/services/channelIdentity';
import { toErrorShape } from '@/shared/errors';
import { useToast } from '@/composables/useToast';

defineOptions({ name: 'EpgView' });

const route = useRoute();
const router = useRouter();
const toast = useToast();

const channelName = computed(() => String(route.query.ch ?? ''));
const queryTvgId = computed(() => {
  const raw = route.query.tvgId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
});
const queryTvgName = computed(() => {
  const raw = route.query.tvgName;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
});
/**
 * REV-14：tvgId / tvgName 可能不在查询参数里（旧链接、从提醒点进来的链接）。
 * 反查直播源旁路属性后补全，否则 `tvgName` 恒 null → L2（tvg-name）永不命中。
 */
const discoveredTvgId = ref<string | null>(null);
const discoveredTvgName = ref<string | null>(null);
const tvgId = computed(() => queryTvgId.value ?? discoveredTvgId.value);
const tvgName = computed(() => queryTvgName.value ?? discoveredTvgName.value);
/** 频道变了就丢弃旧的旁路属性，避免把上一个频道的 tvgId 带过来 */
watch(channelName, () => {
  discoveredTvgId.value = null;
  discoveredTvgName.value = null;
});
/** 提醒 / 分组的频道身份键（与直播页同口径） */
const channelKey = computed(() =>
  channelKeyFromLive({ name: channelName.value, tvgId: tvgId.value }),
);
const channelRef = computed<EpgChannelRef>(() => ({
  name: channelName.value,
  tvgId: tvgId.value,
  tvgName: tvgName.value,
}));

/** 归属直播源：查询参数优先，其次从直播频道缓存反查（只读内存，不发请求） */
const liveSourceId = computed<string | null>(() => {
  const raw = route.query.source;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return liveService.findSourceIdByChannelName(channelName.value);
});

const loading = ref(true);
const errorMessage = ref<string | null>(null);
const result = ref<ChannelEpgResult | null>(null);
const programmes = computed<EpgProgramme[]>(() => result.value?.programmes ?? []);
const enabledSourceCount = ref(0);
const currentDate = ref(new Date());

/** 日期偏移：-1 昨天 / 0 今天 / +1 明天 */
const dateOffset = ref(0);

const isToday = computed(() => dateOffset.value === 0);

const dateLabel = computed(() => {
  const d = currentDate.value;
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekday = weekdays[d.getDay()];
  let prefix = '';
  if (dateOffset.value === -1) prefix = '昨天 ';
  else if (dateOffset.value === 1) prefix = '明天 ';
  return `${prefix}${month}月${day}日 ${weekday}`;
});

/* ---------- 时钟（每 30s 刷新，驱动「正在播 / 已过期 / 可提醒」判定） ---------- */

const nowTick = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

const nowSecOfDay = computed(() => {
  const d = new Date(nowTick.value);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
});

const nowPlayingIndex = computed(() => {
  if (!isToday.value) return -1;
  const now = epgService.nowPlaying(programmes.value, new Date(nowTick.value));
  if (!now) return -1;
  return programmes.value.findIndex((p) => p.startSec === now.startSec && p.title === now.title);
});

const dayStartMs = computed(() => {
  const d = currentDate.value;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
});

/** 节目绝对开始时刻：多源结果带 `startAt`；缺省按当天 0 点 + 秒偏移回推 */
function startAtOf(prog: EpgProgramme): number {
  if (typeof prog.startAt === 'number' && prog.startAt > 0) return prog.startAt;
  return dayStartMs.value + prog.startSec * 1000;
}

function endAtOf(prog: EpgProgramme): number {
  if (typeof prog.endAt === 'number' && prog.endAt > 0) return prog.endAt;
  const startAt = startAtOf(prog);
  return startAt + Math.max(60, prog.endSec - prog.startSec) * 1000;
}

/** 未开播才允许设置提醒 */
function canRemind(prog: EpgProgramme): boolean {
  return startAtOf(prog) > nowTick.value;
}

/* ---------- EXT-06/FR-68：回看（入口在节目单页，不在直播页） ---------- */

/** 频道侧回看素材：渲染 `{base}`/`{tvgId}` 需要频道 URL 与 m3u 旁路属性 */
interface ReplayContext {
  url: string;
  tvgId: string | null;
  catchupTemplate: string | null;
  catchupDays: number | null;
}

const replayContext = ref<ReplayContext | null>(null);
const replayPlan = ref<CatchupPlan | null>(null);
/** AC-162：能力探测结果（kv 已 6h 缓存，这里只负责 UI 呈现） */
const replayCapability = ref<CatchupCapability | null>(null);
const replayPendingKey = ref<string | null>(null);

/**
 * 载入回看上下文（频道 URL + 模板/天数）。
 * 失败静默：回看入口不出现，节目单照常展示。
 *
 * REV-14：同一份 `channelsWithExtrasOf` 结果顺带反查 tvgId / tvgName，
 * 补齐查询参数缺失时（提醒跳转 / 旧链接）的频道身份，保证 L2（tvg-name）可命中。
 */
async function loadReplayContext(): Promise<void> {
  replayContext.value = null;
  replayPlan.value = null;
  replayCapability.value = null;
  replayPendingKey.value = null;
  const sourceId = liveSourceId.value;
  if (!sourceId || !channelName.value) return;
  try {
    const records = await liveService.list();
    const record = records.find((item) => item.id === sourceId) ?? null;
    if (!record) return;
    const data = await liveService.channelsWithExtrasOf(record);
    const channel =
      data.channels.find((item) => item.name === channelName.value) ??
      data.channels.find(
        (item) =>
          channelKeyFromLive({ name: item.name, extras: data.extras[item.url] ?? null }) ===
          channelKey.value,
      ) ??
      null;
    if (!channel) return;
    const extra = data.extras[channel.url] ?? null;
    if (!queryTvgId.value) discoveredTvgId.value = extra?.tvgId ?? null;
    if (!queryTvgName.value) discoveredTvgName.value = extra?.tvgName ?? null;
    replayContext.value = {
      url: channel.url,
      tvgId: extra?.tvgId ?? null,
      catchupTemplate: extra?.catchupTemplate ?? null,
      catchupDays: extra?.catchupDays ?? null,
    };
    replayPlan.value = await replayService.plan({
      liveSourceId: sourceId,
      channel: { name: channel.name, tvgId: extra?.tvgId ?? null, url: channel.url },
      extrasTemplate: extra?.catchupTemplate ?? null,
      extrasDays: extra?.catchupDays ?? null,
    });
  } catch {
    replayContext.value = null;
    replayPlan.value = null;
  }
}

/** 节目是否展示回看入口：模板侧支持 + 已结束 + 在回看窗口内（AC-162） */
function canReplay(prog: EpgProgramme): boolean {
  const plan = replayPlan.value;
  if (!plan || !plan.supported || !replayContext.value) return false;
  return replayService.withinWindow(startAtOf(prog), endAtOf(prog), plan.days, nowTick.value);
}

/** 探测失败且判定为「不可用」时的置灰原因（AC-162） */
const replayBlockedReason = computed<string | null>(() => {
  const capability = replayCapability.value;
  if (!capability) return null;
  if (capability.state === 'not_found' || capability.state === 'unreachable') {
    return replayService.describeFailure(capability);
  }
  return null;
});

function replayKeyOf(prog: EpgProgramme): string {
  return prog.key ?? `${startAtOf(prog)}:${prog.title}`;
}

async function openReplay(prog: EpgProgramme): Promise<void> {
  const sourceId = liveSourceId.value;
  const context = replayContext.value;
  const plan = replayPlan.value;
  if (!sourceId || !context || !plan || replayPendingKey.value !== null) return;
  if (replayBlockedReason.value) {
    toast.info(replayBlockedReason.value);
    return;
  }
  const startAt = startAtOf(prog);
  const endAt = endAtOf(prog);
  replayPendingKey.value = replayKeyOf(prog);
  try {
    const resolved = await replayService.resolve({
      liveSourceId: sourceId,
      channel: { name: channelName.value, tvgId: context.tvgId, url: context.url },
      programme: { startAt, endAt },
      overrideTemplate: context.catchupTemplate,
      overrideDays: context.catchupDays,
    });
    const capability = await replayService.capabilityOf({
      liveSourceId: sourceId,
      channelKey: channelKey.value,
      url: resolved.url,
      days: plan.days,
    });
    replayCapability.value = capability;
    if (capability.state === 'auth_required') {
      toast.error('该源可能不支持回看（403：可能需要鉴权）');
      return;
    }
    if (capability.state !== 'available') {
      toast.error(replayService.describeFailure(capability));
      return;
    }
    const query: Record<string, string> = {
      source: sourceId,
      ch: channelName.value,
      title: prog.title,
      start: String(startAt),
      end: String(endAt),
    };
    if (context.tvgId) query.tvgId = context.tvgId;
    await router.push({
      name: 'replay',
      // REV-31：路径参数名与实义对齐（sourceId = 直播源 id）
      params: { sourceId, programId: replayKeyOf(prog) },
      query,
    });
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    replayPendingKey.value = null;
  }
}

/* ---------- 提醒（FR-71） ---------- */

/** key = `${channelKey}:${startAt}`（REV-21：跨频道/跨天隔离，避免只按 startAt 撞车） */
const reminderMap = ref<Map<string, Reminder>>(new Map());
const reminderOpen = ref(false);
const reminderSaving = ref(false);
const reminderNotice = ref<string | null>(null);
const reminderTarget = ref<{ title: string; startAt: number; endAt: number; key: string } | null>(null);

const reminderStartAt = computed(() => reminderTarget.value?.startAt ?? 0);

function reminderKeyOf(startAt: number, key: string | null | undefined = channelKey.value): string {
  return `${key ?? ''}:${startAt}`;
}

const activeReminder = computed<Reminder | null>(() => {
  const target = reminderTarget.value;
  if (!target) return null;
  return reminderMap.value.get(reminderKeyOf(target.startAt)) ?? null;
});

/**
 * REV-21：读取**全部**提醒（含 fired / missed），不再只取 scheduled，
 * 否则已提醒/已错过的节目在 UI 上会退化成「提醒」按钮。
 */
async function loadReminders(): Promise<void> {
  if (!channelKey.value) return;
  try {
    const { reminders } = await reminderService.list();
    const next = new Map<string, Reminder>();
    for (const item of reminders) {
      if (item.channelKey !== channelKey.value) continue;
      if (item.state === 'cancelled') continue;
      const key = reminderKeyOf(item.startAt, item.channelKey);
      const existing = next.get(key);
      // 同一节目可能残留多条（状态机并发）；保留状态更靠后的一条
      if (!existing || stateRank(item.state) >= stateRank(existing.state)) next.set(key, item);
    }
    reminderMap.value = next;
  } catch {
    // 提醒读取失败不影响节目单展示
    reminderMap.value = new Map();
  }
}

function stateRank(state: Reminder['state']): number {
  if (state === 'fired') return 4;
  if (state === 'missed') return 3;
  if (state === 'firing') return 2;
  return 1;
}

function reminderOf(prog: EpgProgramme): Reminder | null {
  return reminderMap.value.get(reminderKeyOf(startAtOf(prog))) ?? null;
}

/** 提醒按钮文案：scheduled/firing → 修改提醒；fired → 已提醒；missed → 已错过 */
function reminderLabel(prog: EpgProgramme): string {
  const reminder = reminderOf(prog);
  if (!reminder) return '提醒';
  if (reminder.state === 'fired') return '已提醒';
  if (reminder.state === 'missed') return '已错过';
  return '修改提醒';
}

/** 只有「未开播且未设提醒」或「待触发提醒」可继续操作 */
function canEditReminder(prog: EpgProgramme): boolean {
  const reminder = reminderOf(prog);
  if (reminder) return reminder.state === 'scheduled' || reminder.state === 'firing';
  return canRemind(prog);
}

/** 按钮是否需要渲染（已提醒/已错过的节目已开播，必须靠提醒记录驱动展示） */
function showsReminder(prog: EpgProgramme): boolean {
  return canRemind(prog) || reminderOf(prog) !== null;
}

function openReminder(prog: EpgProgramme): void {
  if (!canEditReminder(prog)) return;
  reminderNotice.value = null;
  reminderTarget.value = {
    title: prog.title,
    startAt: startAtOf(prog),
    endAt: endAtOf(prog),
    key: prog.key ?? `${startAtOf(prog)}:${prog.title}`,
  };
  reminderOpen.value = true;
}

async function confirmReminder(leadMinutes: ReminderLead): Promise<void> {
  const target = reminderTarget.value;
  if (!target || reminderSaving.value) return;
  const source = liveSourceId.value;
  if (!source) {
    reminderNotice.value = '未能定位该频道所属直播源，请从直播页进入节目单后再设置提醒';
    return;
  }
  reminderSaving.value = true;
  try {
    const saved = await reminderService.upsert({
      liveSourceId: source,
      epgSourceId: result.value?.matchedSource?.id ?? null,
      channelKey: channelKey.value,
      channelName: channelName.value,
      programmeKey: target.key,
      programmeTitle: target.title,
      startAt: target.startAt,
      endAt: target.endAt,
      leadMinutes,
    });
    await loadReminders();
    if (saved.native.permission === 'granted' && saved.native.scheduled) {
      reminderOpen.value = false;
      toast.success(`已设置提醒：开播前 ${leadMinutes} 分钟通知你`);
    } else {
      // AC-168 降级：无通知权限 / 排期失败时明确告知「仅 App 内提醒」
      reminderNotice.value = saved.lastError ?? '通知权限未授予，将只在 App 内提醒';
    }
  } catch (e) {
    reminderNotice.value = toErrorShape(e).message;
  } finally {
    reminderSaving.value = false;
  }
}

async function cancelReminder(): Promise<void> {
  const current = activeReminder.value;
  if (!current || reminderSaving.value) return;
  reminderSaving.value = true;
  try {
    await reminderService.cancel(current.id);
    await loadReminders();
    reminderOpen.value = false;
    toast.info('已取消提醒');
  } catch (e) {
    reminderNotice.value = toErrorShape(e).message;
  } finally {
    reminderSaving.value = false;
  }
}

/* ---------- EPG 源管理（FR-66） ---------- */

const sourceOpen = ref(false);

async function onSourcesChanged(): Promise<void> {
  await loadEnabledCount();
  await loadProgrammes();
}

async function loadEnabledCount(): Promise<void> {
  try {
    const sources = await epgSourceService.list();
    enabledSourceCount.value = sources.filter((source) => source.enabled).length;
  } catch {
    enabledSourceCount.value = 0;
  }
}

/* ---------- 数据加载 ---------- */

/** REV-26：节目单请求序列号（防旧响应覆盖新结果） */
let loadSeq = 0;

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
  // REV-26：请求序列号，晚到的旧响应不得覆盖新结果（快速切换日期/来源时）
  loadSeq += 1;
  const mySeq = loadSeq;
  loading.value = true;
  errorMessage.value = null;
  try {
    const next = await epgService.programmesFor(channelRef.value, currentDate.value);
    if (mySeq !== loadSeq) return;
    result.value = next;
  } catch (e) {
    if (mySeq !== loadSeq) return;
    errorMessage.value = toErrorShape(e).message;
    result.value = null;
  } finally {
    if (mySeq === loadSeq) loading.value = false;
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

watch([channelKey, liveSourceId, () => currentDate.value], () => {
  void loadProgrammes().then(() => {
    if (isToday.value) void scrollToNow();
  });
  void loadReminders();
  void loadReplayContext();
});

onMounted(async () => {
  clockTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
  await Promise.all([loadEnabledCount(), loadProgrammes(), loadReminders(), loadReplayContext()]);
  if (isToday.value) void scrollToNow();
});

onBeforeUnmount(() => {
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
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
    <AppHeader :title="channelName || '节目单'" :back="true" @back="goBack">
      <template #actions>
        <button class="epg-source-btn" type="button" @click="sourceOpen = true">EPG 源管理</button>
      </template>
    </AppHeader>

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
        <p v-if="enabledSourceCount === 0" class="epg-empty__hint">
          尚未启用任何 EPG 源，可在右上角「EPG 源管理」中添加
        </p>
        <p v-else class="epg-empty__hint">该频道可能不支持 EPG，或当前日期无节目安排</p>
        <button class="btn btn--secondary btn--sm" type="button" @click="sourceOpen = true">
          EPG 源管理
        </button>
      </div>

      <!-- 节目列表 -->
      <template v-else>
        <!-- 命中来源 / 缓存降级提示 -->
        <p class="epg-source-line">
          <span v-if="result?.matchedSource" class="epg-source-line__name">
            来源：{{ result.matchedSource.name }}（L{{ result.matchedSource.matchLevel }}）
          </span>
          <span v-else-if="result" class="epg-source-line__none">未匹配到节目单源</span>
          <span v-if="result?.stale" class="epg-source-line__stale">缓存数据</span>
          <span v-if="result && result.errors.length > 0" class="epg-source-line__failed">
            {{ result.errors.length }} 个源拉取失败
          </span>
        </p>
        <p v-if="replayBlockedReason" class="epg-replay-blocked" role="status">
          回看不可用：{{ replayBlockedReason }}
        </p>

        <ul class="epg-list">
          <li
            v-for="(prog, idx) in programmes"
            :id="`epg-item-${idx}`"
            :key="prog.key ?? `${prog.start}-${prog.title}`"
            class="epg-item"
            :class="{
              'epg-item--now': idx === nowPlayingIndex,
              'epg-item--past': isToday && prog.endSec <= nowSecOfDay,
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
            <button
              v-if="canReplay(prog)"
              class="epg-item__replay"
              :class="{ 'epg-item__replay--disabled': replayBlockedReason !== null }"
              type="button"
              :disabled="replayBlockedReason !== null || replayPendingKey !== null"
              :aria-label="`回看 ${prog.title}`"
              @click.stop="openReplay(prog)"
            >
              {{ replayPendingKey === replayKeyOf(prog) ? '探测中' : '回看' }}
            </button>
            <button
              v-if="showsReminder(prog)"
              class="epg-item__remind"
              :class="{
                'epg-item__remind--on':
                  reminderOf(prog) !== null &&
                  (reminderOf(prog)?.state === 'scheduled' || reminderOf(prog)?.state === 'firing'),
                'epg-item__remind--fired': reminderOf(prog)?.state === 'fired',
                'epg-item__remind--missed': reminderOf(prog)?.state === 'missed',
              }"
              type="button"
              :disabled="!canEditReminder(prog)"
              :aria-label="`${reminderLabel(prog)} ${prog.title}`"
              @click.stop="openReminder(prog)"
            >
              {{ reminderLabel(prog) }}
            </button>
          </li>
        </ul>
      </template>
    </div>

    <EpgSourceSheet v-model="sourceOpen" @changed="onSourcesChanged" />

    <ReminderSheet
      v-model="reminderOpen"
      :title="reminderTarget?.title ?? ''"
      :start-at="reminderStartAt"
      :reminder="activeReminder"
      :saving="reminderSaving"
      :notice="reminderNotice"
      @confirm="confirmReminder"
      @cancel-reminder="cancelReminder"
    />
  </SafeArea>
</template>

<style scoped>
.epg-source-btn {
  min-width: 44px;
  height: 44px;
  padding: 0 var(--space-2);
  font: var(--text-label);
  color: var(--color-brand-text);
}

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

/* ---------- 命中来源 ---------- */
.epg-source-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.epg-source-line__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.epg-source-line__stale {
  flex: 0 0 auto;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-warning);
}

.epg-source-line__failed {
  flex: 0 0 auto;
  color: var(--color-danger);
}

.epg-source-line__none {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
}

/* AC-162：探测判定不可用 → 入口置灰 + 原因 */
.epg-replay-blocked {
  margin: 0 0 var(--space-2);
  font: var(--text-caption);
  color: var(--color-warning);
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

/* EXT-06/FR-71：单条节目提醒入口 */
.epg-item__remind {
  flex: 0 0 auto;
  align-self: center;
  min-width: 44px;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-brand-text);
  font: var(--text-caption);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.epg-item__remind:active {
  background-color: var(--color-bg-pressed);
}

.epg-item__remind--on {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  color: var(--color-brand-strong);
}

/* REV-21：已提醒 / 已错过为终态，按钮置灰不可点 */
.epg-item__remind--fired {
  color: var(--color-text-tertiary);
}

.epg-item__remind--missed {
  color: var(--color-danger);
}

.epg-item__remind:disabled {
  cursor: default;
  opacity: 0.7;
}

/* EXT-06/FR-68：单条节目回看入口（仅在节目单页） */
.epg-item__replay {
  flex: 0 0 auto;
  align-self: center;
  min-width: 44px;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-brand-text);
  font: var(--text-caption);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.epg-item__replay:active:not(:disabled) {
  background-color: var(--color-bg-pressed);
}

.epg-item__replay:disabled,
.epg-item__replay--disabled {
  color: var(--color-text-disabled);
  border-color: transparent;
  background-color: var(--color-bg-surface);
  cursor: default;
}
</style>
