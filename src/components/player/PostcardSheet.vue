<script setup lang="ts">
/**
 * 「一帧明信片」（G-C04）
 *
 * 预览就是导出那一张：画布 → PNG Blob → objectURL，所见即所得，不用 HTML 模拟版式。
 * 三条口径与抽帧家族一致：画面只来自本机成品、台词只来自当前字幕行、
 * 产物交给系统分享面板（本机没有写媒体库的能力，所以不说"已存到相册"）。
 *
 * 打开的一瞬间拍照留存（`snap`）：播放还在走，`player.currentTime` 每帧都在变，
 * 直接绑上去会让预览一直重画，明信片也会随时间漂走。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import BottomSheet from '@/components/common/BottomSheet.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { paletteForPoster, type PaletteSeed } from '@/services/paletteService';
import {
  POSTCARD_FRAMES_NOTE,
  PostcardError,
  fetchPostcardFrames,
  renderPostcard,
  sharePostcard,
  type PostcardContent,
  type PostcardFramesReason,
  type PostcardImageSource,
  type PostcardLayout,
} from '@/services/postcardService';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    meta?: string | null;
    /** `第 3 集`；电影传 null */
    episodeLabel?: string | null;
    posterUrl?: string | null;
    positionSec: number;
    durationSec: number;
    /** 此刻屏上的字幕行，没有就留 null */
    line?: string | null;
    /** 本机成品相对路径；在线源为 null */
    localPath?: string | null;
  }>(),
  { meta: null, episodeLabel: null, posterUrl: null, line: null, localPath: null },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

/** 选项存下来：下次打开还是自己习惯的那一版（与选集胶片墙同一口径，只占一个键） */
const PREF_KEY = 'player.postcard';

interface Snapshot {
  title: string;
  meta: string | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  line: string | null;
  positionSec: number;
  durationSec: number;
  localPath: string | null;
}

const layout = ref<PostcardLayout>('ticket');
const image = ref<PostcardImageSource>('poster');
const showLine = ref(true);

const snap = ref<Snapshot | null>(null);
const frames = ref<string[]>([]);
const framesReason = ref<PostcardFramesReason>('no-file');
const accent = ref<PaletteSeed | null>(null);
const previewUrl = ref<string | null>(null);
const busy = ref(false);
const sharing = ref(false);
const note = ref<string | null>(null);

let blob: Blob | null = null;
/** 选项连点时只让最后一次的结果上屏 */
let renderSeq = 0;

function readPref(): void {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<{ layout: PostcardLayout; image: PostcardImageSource; line: boolean }>;
    if (saved.layout === 'ticket' || saved.layout === 'minimal' || saved.layout === 'film') layout.value = saved.layout;
    if (saved.line === true) showLine.value = true;
  } catch {
    // 偏好读不出来就用默认版式，不值得为此打断一次分享
  }
}

function writePref(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ layout: layout.value, line: showLine.value }));
  } catch {
    // 隐私模式写不进去就算了
  }
}

readPref();

const hasFrames = computed(() => frames.value.length > 0);
const canQuote = computed(() => !!snap.value?.line?.trim());

const LAYOUT_OPTIONS = [
  { value: 'ticket', label: '票根' },
  { value: 'minimal', label: '极简' },
  { value: 'film', label: '胶片' },
];

const IMAGE_OPTIONS = computed(() => [
  { value: 'poster', label: '人物海报', disabled: false },
  // 没有本机画面就不给这一档：切过去只会得到一张空白底，比不给选项更难解释
  { value: 'frame', label: '本机画面', disabled: !hasFrames.value },
]);

/** 图源说明：只在「画面」档不可用时出现，说清是哪一层挡住了 */
const imageNote = computed(() => {
  if (hasFrames.value) return '';
  return POSTCARD_FRAMES_NOTE[framesReason.value];
});

function release(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = null;
  blob = null;
}

function contentOf(): PostcardContent | null {
  const shot = snap.value;
  if (!shot) return null;
  return {
    title: shot.title,
    meta: shot.meta,
    episodeLabel: shot.episodeLabel,
    line: showLine.value && canQuote.value ? shot.line : null,
    positionSec: shot.positionSec,
    durationSec: shot.durationSec,
    posterUrl: shot.posterUrl,
    frames: frames.value,
    accent: accent.value,
  };
}

async function rerender(): Promise<void> {
  const content = contentOf();
  if (!props.modelValue || !content) return;
  const seq = renderSeq + 1;
  renderSeq = seq;
  busy.value = true;
  note.value = null;
  try {
    const next = await renderPostcard(layout.value, content, image.value);
    if (seq !== renderSeq) return;
    release();
    blob = next;
    previewUrl.value = URL.createObjectURL(next);
  } catch (e) {
    if (seq !== renderSeq) return;
    release();
    note.value =
      e instanceof PostcardError ? `没能画出明信片：${e.message}` : '这台机器没能画出明信片，换个版式再试试';
  } finally {
    if (seq === renderSeq) busy.value = false;
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      renderSeq += 1;
      release();
      return;
    }
    snap.value = {
      title: props.title,
      meta: props.meta,
      episodeLabel: props.episodeLabel,
      posterUrl: props.posterUrl,
      line: props.line,
      positionSec: Math.max(0, Math.floor(props.positionSec)),
      durationSec: Math.max(0, Math.floor(props.durationSec)),
      localPath: props.localPath,
    };
    // 没有台词就别留着开关：默认关掉，避免导出一张带空引子的明信片
    if (!snap.value.line?.trim()) showLine.value = false;
    if (image.value === 'frame' && !snap.value.localPath) image.value = 'poster';

    const shot = snap.value;
    void paletteForPoster(shot.posterUrl).then((seed) => {
      if (props.modelValue) {
        accent.value = seed;
        void rerender();
      }
    });
    const fetched = await fetchPostcardFrames(shot.localPath, shot.positionSec, shot.durationSec);
    if (!props.modelValue) return;
    frames.value = fetched.frames;
    framesReason.value = fetched.reason;
    if (!fetched.frames.length && image.value === 'frame') image.value = 'poster';
    await rerender();
  },
  // 面板已经打开着再挂载（热更新 / 外部直接置 true）也要拍到这一刻，不能只有翻转才生效
  { immediate: true },
);

watch([layout, image, showLine], () => {
  writePref();
  void rerender();
});

onBeforeUnmount(release);

async function onShare(): Promise<void> {
  if (!blob || !snap.value) return;
  sharing.value = true;
  note.value = null;
  const result = await sharePostcard(blob, snap.value.title || '明信片');
  sharing.value = false;
  if (result.ok) {
    emit('update:modelValue', false);
    return;
  }
  note.value = `分享没走通：${result.message ?? result.reason}`;
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="一帧明信片"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pc-preview">
      <img v-if="previewUrl" class="pc-preview__img" :src="previewUrl" alt="明信片预览" />
      <p v-else class="pc-preview__idle">{{ busy ? '正在画这张明信片…' : '还没能画出预览' }}</p>
    </div>

    <p class="sheet-section">版式</p>
    <SegmentedControl v-model="layout" :options="LAYOUT_OPTIONS" label="明信片版式" block />

    <p class="sheet-section">主图</p>
    <SegmentedControl v-model="image" :options="IMAGE_OPTIONS" label="明信片主图来源" block />
    <p v-if="imageNote" class="sheet-hint">{{ imageNote }}</p>

    <div class="pc-quote">
      <span class="pc-quote__label">
        带上台词
        <small v-if="!canQuote" class="sheet-hint pc-quote__hint">此刻屏上没有字幕行</small>
      </span>
      <ToggleSwitch v-model="showLine" :disabled="!canQuote" label="带上当前字幕台词" />
    </div>

    <p v-if="note" class="pc-note" role="status">{{ note }}</p>

    <template #footer>
      <button
        class="btn btn--primary btn--md pc-share"
        type="button"
        :disabled="busy || sharing || !previewUrl"
        @click="onShare"
      >
        {{ sharing ? '正在交给分享面板…' : '分享这张明信片' }}
      </button>
      <p class="sheet-hint pc-size">1080 × 1350 PNG · 交给系统分享面板，不落相册</p>
    </template>
  </BottomSheet>
</template>

<style scoped>
.pc-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  margin-bottom: var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-sunken);
  border: var(--border-default);
}

.pc-preview__img {
  display: block;
  max-height: 46vh;
  aspect-ratio: 4 / 5;
  border-radius: var(--radius-sm);
}

.pc-preview__idle {
  margin: 0;
  color: var(--color-text-tertiary);
  font: var(--text-caption);
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

.pc-quote {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: 0 var(--space-2);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
}

.pc-quote__label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pc-quote__hint {
  padding: 0;
}

.pc-note {
  margin: var(--space-3) 0 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-warning-soft);
  color: var(--color-text-primary);
  font: var(--text-caption);
}

.pc-share {
  width: 100%;
}

.pc-size {
  text-align: center;
}
</style>
