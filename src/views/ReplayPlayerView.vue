<script setup lang="ts">
/**
 * 回看播放页（EXT-06 / FR-68，D-13）
 *
 * 路由：`/replay/:channelId/:programId`
 * - `channelId`：直播源 id（LiveView 导航时传 `record.id`）
 * - `programId`：节目唯一键（`${startAt}:${title}`，与提醒 / EPG 同口径）
 * - 频道与节目元信息优先按参数 + 查询串还原，再用 `epgService.programmesFor` 补全标题与时间
 * - 播放地址由 `replayService.resolve` 按声明式模板渲染（窗口校验失败会被拦在页内）
 * - 播放能力交给 `ReplayPlayer`（HlsEngine / VideoEngine + SeekBar）
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { LiveChannelExtrasMap, LiveRecord } from '@/types';
import type { EpgChannelRef } from '@/types';
import type { LiveChannel } from '@/sources/live/liveParsers';

import AppHeader from '@/components/layout/AppHeader.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ReplayPlayer from '@/components/live/ReplayPlayer.vue';
import { epgService } from '@/services/epgService';
import { liveService } from '@/services/liveService';
import { replayService } from '@/services/replayService';
import { channelKeyOf } from '@/shared/channelKey';
import { AppError, toErrorShape } from '@/shared/errors';

defineOptions({ name: 'ReplayPlayerView' });

const route = useRoute();
const router = useRouter();

const loading = ref(true);
const errorMessage = ref<string | null>(null);
const url = ref<string | null>(null);

const channelName = ref('');
const programmeTitle = ref('');
const sourceName = ref('');
const startAt = ref(0);
const endAt = ref(0);
/** 回看窗口（天），用于页脚说明 */
const windowDays = ref(1);

const channelId = computed(() => String(route.params.channelId ?? ''));
const programId = computed(() => String(route.params.programId ?? ''));

const timeLabel = computed(() => {
  if (!startAt.value) return '';
  const start = new Date(startAt.value);
  const startText = `${start.getMonth() + 1}月${start.getDate()}日 ${pad(start.getHours())}:${pad(start.getMinutes())}`;
  if (!endAt.value) return startText;
  const end = new Date(endAt.value);
  return `${startText} – ${pad(end.getHours())}:${pad(end.getMinutes())}`;
});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function queryText(key: string): string {
  const raw = route.query[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function queryNumber(key: string): number {
  const raw = Number(queryText(key));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function keyOf(channel: { name: string }): string {
  return channelKeyOf({ name: channel.name });
}

interface ResolvedTarget {
  record: LiveRecord;
  channel: LiveChannel;
  extras: LiveChannelExtrasMap;
  startAt: number;
  endAt: number;
  title: string;
}

/** 还原「直播源 + 频道 + 节目」三元组；缺信息抛错由调用方统一展示 */
async function resolveTarget(): Promise<ResolvedTarget> {
  const records = await liveService.list();
  if (records.length === 0) throw new Error('还没有直播源，无法回看');

  const nameHint = queryText('ch');
  let record = records.find((item) => item.id === channelId.value) ?? null;

  // 拿不到源时按频道名反查（5min 内存缓存未命中则退回全量匹配）
  if (!record && nameHint) {
    const byName = liveService.findSourceIdByChannelName(nameHint);
    record = records.find((item) => item.id === byName) ?? null;
  }
  // REV-09：不跨源回退——回看能力属于该直播源，静默换源会拼出别的源的地址
  // 用 AppError 承载文案：`toErrorShape` 对原生 Error 只保留 E_UNKNOWN 的通用文案，
  // 直接 throw Error 会让用户看不到「请从直播页重新进入回看」这句关键指引。
  if (!record) {
    throw new AppError('E_NOT_FOUND', '未找到该频道所属的直播源，请从直播页重新进入回看');
  }

  const data = await liveService.channelsWithExtrasOf(record);
  const wanted = nameHint || (channelId.value !== record.id ? channelId.value : '');
  const channel =
    data.channels.find((item) => item.name === wanted) ??
    data.channels.find((item) => keyOf(item) === wanted) ??
    null;
  if (!channel) {
    throw new AppError('E_NOT_FOUND', '未找到该频道，请从直播页重新进入回看');
  }

  // programId 形如 `${startAt}:${title}`，缺查询串时用它反推节目时间
  const keyStart = Number(programId.value.split(':')[0]);
  const startFromKey = Number.isFinite(keyStart) && keyStart > 0 ? keyStart : 0;

  return {
    record,
    channel,
    extras: data.extras,
    startAt: queryNumber('start') || startFromKey,
    endAt: queryNumber('end'),
    title: queryText('title'),
  };
}

/** 用 programsFor 补全节目标题 / 时间（失败不阻塞：退回查询串） */
async function hydrateFromEpg(
  target: ResolvedTarget,
): Promise<{ startAt: number; endAt: number; title: string }> {
  let fallback = { startAt: target.startAt, endAt: target.endAt, title: target.title };
  try {
    const extra = target.extras[target.channel.url] ?? null;
    const channelRef: EpgChannelRef = {
      name: target.channel.name,
      tvgId: extra?.tvgId ?? null,
      tvgName: extra?.tvgName ?? null,
      url: target.channel.url,
    };
    const date = target.startAt > 0 ? new Date(target.startAt) : new Date();
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const merged = await epgService.programmesFor(channelRef, date);
    const match = merged.programmes.find((programme) => {
      const programmeStart =
        typeof programme.startAt === 'number' && programme.startAt > 0
          ? programme.startAt
          : dayStart + programme.startSec * 1000;
      const key = programme.key ?? `${programmeStart}:${programme.title}`;
      return key === programId.value || (target.startAt > 0 && programmeStart === target.startAt);
    });
    if (!match) return fallback;
    const matchStart =
      typeof match.startAt === 'number' && match.startAt > 0
        ? match.startAt
        : dayStart + match.startSec * 1000;
    const matchEnd =
      typeof match.endAt === 'number' && match.endAt > 0
        ? match.endAt
        : matchStart + Math.max(60, match.endSec - match.startSec) * 1000;
    fallback = { startAt: matchStart, endAt: matchEnd, title: match.title };
    return fallback;
  } catch {
    return fallback;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  url.value = null;
  try {
    const target = await resolveTarget();
    sourceName.value = target.record.name;
    channelName.value = target.channel.name;

    const meta = await hydrateFromEpg(target);
    startAt.value = meta.startAt;
    endAt.value = meta.endAt;
    programmeTitle.value = meta.title;

    if (!startAt.value || !endAt.value) {
      errorMessage.value = '缺少节目时间信息，无法生成回看地址';
      return;
    }

    const extra = target.extras[target.channel.url] ?? null;
    const plan = await replayService.plan({
      liveSourceId: target.record.id,
      channel: {
        name: target.channel.name,
        tvgId: extra?.tvgId ?? null,
        url: target.channel.url,
      },
      extrasTemplate: extra?.catchupTemplate ?? null,
      extrasDays: extra?.catchupDays ?? null,
    });
    windowDays.value = plan.days;
    if (!plan.supported) {
      errorMessage.value = '该直播源未配置回看模板，无法回看（可在直播源设置中补充模板）';
      return;
    }

    const resolved = await replayService.resolve({
      liveSourceId: target.record.id,
      channel: {
        name: target.channel.name,
        tvgId: extra?.tvgId ?? null,
        url: target.channel.url,
      },
      programme: { startAt: startAt.value, endAt: endAt.value },
      overrideTemplate: extra?.catchupTemplate ?? null,
      overrideDays: extra?.catchupDays ?? null,
    });
    url.value = resolved.url;
  } catch (e) {
    errorMessage.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}

function goBack(): void {
  if (window.history.length > 1) {
    router.back();
  } else {
    void router.push('/live');
  }
}

function openEpg(): void {
  if (!channelName.value) return;
  const query: Record<string, string> = { ch: channelName.value };
  if (queryText('tvgId')) query.tvgId = queryText('tvgId');
  void router.push({ name: 'epg', query });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <main class="replay-page" data-route="replay">
    <AppHeader :title="programmeTitle || channelName || '回看'" :back="true" @back="goBack" />

    <div class="replay-body">
      <div v-if="loading" class="replay-loading" role="status">
        <LoadingSpinner :size="20" />
        <span>正在准备回看…</span>
      </div>

      <template v-else>
        <div v-if="errorMessage" class="replay-notice replay-notice--error" role="alert">
          <span>{{ errorMessage }}</span>
          <div class="replay-notice__actions">
            <button class="btn btn--secondary btn--sm" type="button" @click="load">重试</button>
            <button class="btn btn--ghost btn--sm" type="button" @click="goBack">返回</button>
          </div>
        </div>

        <ReplayPlayer
          :url="url"
          :channel-name="channelName"
          :programme-title="programmeTitle"
          :time-label="timeLabel"
          :start-at="startAt"
          @retry="load"
          @back="goBack"
        />

        <section class="replay-meta">
          <p class="replay-meta__channel">{{ channelName || '未知频道' }}</p>
          <p class="replay-meta__title">{{ programmeTitle || '回看节目' }}</p>
          <p v-if="timeLabel" class="replay-meta__time">{{ timeLabel }}</p>
          <p class="replay-meta__hint">
            回看窗口 {{ windowDays }} 天{{ sourceName ? ` · 来源：${sourceName}` : '' }}
          </p>
          <div class="replay-meta__actions">
            <button class="btn btn--secondary btn--sm" type="button" @click="openEpg">完整节目单</button>
          </div>
        </section>
      </template>
    </div>
  </main>
</template>

<style scoped>
.replay-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-base);
}

.replay-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--layout-page-padding-x) var(--space-6);
}

.replay-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) 0;
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.replay-notice {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font: var(--text-label);
}

.replay-notice--error {
  background-color: var(--color-danger-soft);
  border: 1px solid rgba(255, 90, 95, 0.3);
  color: var(--color-text-primary);
}

.replay-notice__actions {
  display: flex;
  gap: var(--space-2);
}

.replay-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.replay-meta__channel {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.replay-meta__title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.replay-meta__time {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.replay-meta__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.replay-meta__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-1);
}
</style>
