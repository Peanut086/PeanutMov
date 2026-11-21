<script setup lang="ts">
/**
 * 观影口令「票根卡」（G-C10）
 *
 * 打开的一瞬间拍下坐标：播放还在走，`player.currentTime` 每帧都在变，
 * 直接绑上去会让口令跟着漂——分享出去的必须是按下那一刻的位置。
 *
 * 预览就是导出那一张（与「一帧明信片」同一口径）：画布 → PNG Blob → objectURL，
 * 所见即所得，不用 HTML 模拟票根版式。
 *
 * 「复制口令」的文本仍由 PlayerView 用 `buildShareText` 组装并写进剪贴板：
 * 协议、文案、toast 提示都没为这张卡改动过，卡片只是口令的可视化。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import BottomSheet from '@/components/common/BottomSheet.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import { paletteForPoster, type PaletteSeed } from '@/services/paletteService';
import { encodeShareCode, type ShareCodePayload } from '@/services/shareCodeService';
import {
  TICKET_BARCODE_NOTE,
  renderTicketCard,
  shareTicketCard,
  type TicketContent,
  type TicketViewer,
} from '@/services/ticketCardService';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 口令载荷；null 表示这一刻还拼不出一条口令（详情没到位） */
    payload: ShareCodePayload | null;
    /** `1998 · 美国 · 动作`，缺项自动跳过 */
    meta?: string | null;
    /** `第 3 集`；电影传 null */
    episodeLabel?: string | null;
    posterUrl?: string | null;
    durationSec?: number;
  }>(),
  { meta: null, episodeLabel: null, posterUrl: null, durationSec: 0 },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 交给 PlayerView 写剪贴板：它才有 toast 通路，也才能顺手收起弹层 */
  (e: 'copy'): void;
}>();

interface TicketSnapshot {
  title: string;
  meta: string | null;
  episodeLabel: string | null;
  code: string;
  positionSec: number;
  durationSec: number;
  posterUrl: string | null;
}

const viewer = ref<TicketViewer>('owner');
const snap = ref<TicketSnapshot | null>(null);
const accent = ref<PaletteSeed | null>(null);
const previewUrl = ref<string | null>(null);
const busy = ref(false);
const sharing = ref(false);
const note = ref<string | null>(null);

let blob: Blob | null = null;
/** 视角连点时只让最后一次的结果上屏 */
let renderSeq = 0;

const VIEWER_OPTIONS = [
  { value: 'owner', label: '我的视角' },
  { value: 'receiver', label: '对方视角' },
];

const viewerHint = computed(() =>
  viewer.value === 'owner'
    ? '票根上那句说明写的是你此刻在看哪儿'
    : '同一张票根，说明换成对方拿到后该怎么用',
);

const canCopy = computed(() => snap.value !== null);

function release(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = null;
  blob = null;
}

function contentOf(): TicketContent | null {
  const shot = snap.value;
  if (!shot) return null;
  return { ...shot, accent: accent.value, viewer: viewer.value };
}

async function rerender(): Promise<void> {
  const content = contentOf();
  if (!props.modelValue || !content) return;
  const seq = renderSeq + 1;
  renderSeq = seq;
  busy.value = true;
  note.value = null;
  try {
    const next = await renderTicketCard(content);
    if (seq !== renderSeq) return;
    release();
    blob = next;
    previewUrl.value = URL.createObjectURL(next);
  } catch (e) {
    if (seq !== renderSeq) return;
    release();
    note.value = e instanceof Error ? `没能画出票根：${e.message}` : '这台机器没能画出票根';
  } finally {
    if (seq === renderSeq) busy.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      renderSeq += 1;
      release();
      return;
    }
    const payload = props.payload;
    if (!payload) {
      snap.value = null;
      return;
    }
    snap.value = {
      title: payload.title,
      meta: props.meta,
      episodeLabel: props.episodeLabel,
      // 卡上印的就是这一串：与复制出去的文本同源，不做第二套编码
      code: encodeShareCode(payload),
      positionSec: Math.max(0, Math.floor(payload.positionSec ?? 0)),
      durationSec: Math.max(0, Math.floor(props.durationSec)),
      posterUrl: props.posterUrl,
    };
    void paletteForPoster(props.posterUrl).then((seed) => {
      if (props.modelValue) {
        accent.value = seed;
        void rerender();
      }
    });
  },
  // 面板已经打开着再挂载（热更新 / 外部直接置 true）也要拍到这一刻，不能只有翻转才生效
  { immediate: true },
);

watch(viewer, () => void rerender());

onBeforeUnmount(release);

async function onSave(): Promise<void> {
  if (!blob || !snap.value) return;
  sharing.value = true;
  note.value = null;
  const result = await shareTicketCard(blob, snap.value.title || '观影口令');
  sharing.value = false;
  if (result.ok) {
    note.value = '票根已交给系统分享面板，不落相册';
    return;
  }
  note.value = `分享没走通：${result.message ?? result.reason}`;
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="观影口令"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="tc-preview">
      <img v-if="previewUrl" class="tc-preview__img" :src="previewUrl" alt="票根预览" />
      <p v-else class="tc-preview__idle">{{ busy ? '正在画这张票根…' : '还没有可画的票根' }}</p>
    </div>

    <p class="sheet-hint tc-note-line">{{ TICKET_BARCODE_NOTE }} —— 条码只是票根版式，扫不出来</p>

    <p class="sheet-section">口令正文</p>
    <code v-if="snap" class="tc-code">{{ snap.code }}</code>

    <p class="sheet-section">视角</p>
    <SegmentedControl v-model="viewer" :options="VIEWER_OPTIONS" label="票根视角" block />
    <p class="sheet-hint">{{ viewerHint }}</p>

    <p v-if="note" class="tc-note" role="status">{{ note }}</p>

    <template #footer>
      <div class="tc-actions">
        <button class="btn btn--primary btn--md tc-copy" type="button" :disabled="!canCopy" @click="emit('copy')">
          复制口令
        </button>
        <button
          class="btn btn--secondary btn--md tc-save"
          type="button"
          :disabled="busy || sharing || !previewUrl"
          @click="onSave"
        >
          {{ sharing ? '正在交给分享面板…' : '保存票根' }}
        </button>
      </div>
      <p class="sheet-hint tc-size">1080 × 540 PNG · 口令过长时票根上只画得下前段，复制的那份始终完整</p>
    </template>
  </BottomSheet>
</template>

<style scoped>
.tc-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 170px;
  padding: var(--space-2);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-sunken);
  border: var(--border-default);
}

.tc-preview__img {
  display: block;
  width: min(340px, 100%);
  aspect-ratio: 2 / 1;
  border-radius: var(--radius-sm);
}

.tc-preview__idle {
  margin: 0;
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.tc-note-line {
  margin-top: var(--space-2);
}

.sheet-section {
  margin: var(--space-3) 0 var(--space-1);
  padding: 0 var(--space-2);
  color: var(--color-text-tertiary);
  font: var(--text-label-strong);
}

.sheet-hint {
  margin: var(--space-1) 0 0;
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.tc-code {
  display: block;
  margin: 0 var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: text;
}

.tc-actions {
  display: flex;
  gap: var(--space-2);
}

.tc-copy,
.tc-save {
  flex: 1;
}

.tc-note {
  margin: var(--space-3) 0 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-warning-soft);
  color: var(--color-text-primary);
  font: var(--text-caption);
}

.tc-size {
  text-align: center;
}
</style>
