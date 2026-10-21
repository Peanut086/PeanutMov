<script setup lang="ts">
/**
 * 字幕面板（AC-44 / AC-45）
 *
 * - 轨道列表（关闭 / 远程 / 本地），当前项打勾
 * - 加载失败的轨道标「不可用」（disabled 文字色 + 14px，点击给出说明）（AC-46）
 * - 本地字幕文件选择（Android 走系统选择器）
 * - 字幕样式：字号（小/中/大）、颜色（白/黄）、背景（半透明黑/无）
 * - 时间偏移 −5s ~ +5s，步进 0.5s
 */
import { computed, ref } from 'vue';

import type { SubtitleSettings, SubtitleTrack } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    tracks: SubtitleTrack[];
    activeId: string | null;
    settings: SubtitleSettings;
    /** 加载失败的轨道 id（AC-46，由 SubtitleManager.failedTrackIds 经 Store 传入） */
    failedIds?: string[];
  }>(),
  { failedIds: () => [] },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', id: string | null): void;
  (e: 'retry', id: string): void;
  (e: 'local-file', file: File): void;
  (e: 'update-settings', patch: Partial<SubtitleSettings>): void;
}>();

const fileInputRef = ref<HTMLInputElement | null>(null);

const hasTracks = computed(() => props.tracks.length > 0);

const offsetLabel = computed(() => {
  const v = props.settings.offsetSec;
  if (v === 0) return '0.0s';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}s`;
});

function isUnavailable(id: string): boolean {
  return props.failedIds.includes(id);
}

/** 打开字幕时优先选第一条可用轨道（全部失败则退回首条，触发重试） */
function firstAvailableId(): string | null {
  const ok = props.tracks.find((t) => !isUnavailable(t.id));
  return (ok ?? props.tracks[0])?.id ?? null;
}

/** 可用轨道直接切换；失败轨道不切换，改为重试一次并给出说明（AC-46） */
function choose(id: string | null): void {
  if (id !== null && isUnavailable(id)) {
    emit('retry', id);
    return;
  }
  emit('select', id);
}

function openFile(): void {
  fileInputRef.value?.click();
}

function onFileChange(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('local-file', file);
  input.value = '';
}

function setOffset(next: number): void {
  const clamped = Math.min(5, Math.max(-5, Math.round(next * 10) / 10));
  emit('update-settings', { offsetSec: clamped });
}

function setSize(size: SubtitleSettings['size']): void {
  emit('update-settings', { size });
}

function setColor(color: SubtitleSettings['color']): void {
  emit('update-settings', { color });
}

function setBackground(background: SubtitleSettings['background']): void {
  emit('update-settings', { background });
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="字幕"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="subtitle-block">
      <div class="subtitle-row">
        <span class="subtitle-row__label">显示字幕</span>
        <ToggleSwitch
          :model-value="activeId !== null"
          label="显示字幕"
          @update:model-value="choose($event ? firstAvailableId() : null)"
        />
      </div>
    </div>

    <div class="subtitle-block">
      <h3 class="subtitle-block__title">字幕轨道</h3>
      <ul class="subtitle-list">
        <li>
          <button
            class="subtitle-item"
            :class="{ 'subtitle-item--active': activeId === null }"
            type="button"
            @click="choose(null)"
          >
            <span>关闭字幕</span>
            <span v-if="activeId === null" class="subtitle-item__check">当前</span>
          </button>
        </li>
        <li v-for="track in tracks" :key="track.id">
          <button
            class="subtitle-item"
            :class="{
              'subtitle-item--active': activeId === track.id,
              'subtitle-item--unavailable': isUnavailable(track.id),
            }"
            type="button"
            :aria-disabled="isUnavailable(track.id) ? 'true' : undefined"
            :aria-label="
              isUnavailable(track.id) ? `${track.label}（不可用，点击重试）` : undefined
            "
            @click="choose(track.id)"
          >
            <span class="subtitle-item__label">{{ track.label }}</span>
            <span
              v-if="isUnavailable(track.id)"
              class="subtitle-item__unavailable"
              data-test="subtitle-unavailable"
            >
              不可用
            </span>
            <span v-else class="subtitle-item__meta">
              {{ track.source === 'local' ? '本地' : track.format.toUpperCase() }}
            </span>
            <span v-if="activeId === track.id" class="subtitle-item__check">当前</span>
          </button>
        </li>
      </ul>

      <p v-if="!hasTracks" class="subtitle-block__empty">
        该片源没有提供字幕。可选择本地 SRT / VTT 文件外挂。
      </p>
      <p v-else-if="failedIds.length > 0" class="subtitle-block__empty">
        标记「不可用」的字幕加载失败，点击可重试；播放不受影响。
      </p>

      <button class="btn btn--secondary btn--md subtitle-block__file" type="button" @click="openFile">
        选择本地字幕文件
      </button>
      <input
        ref="fileInputRef"
        class="subtitle-block__input"
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        @change="onFileChange"
      />
    </div>

    <div class="subtitle-block">
      <h3 class="subtitle-block__title">样式</h3>

      <div class="subtitle-field">
        <span class="subtitle-field__label">字号</span>
        <div class="subtitle-chips">
          <button
            v-for="opt in [{ v: 'small', l: '小' }, { v: 'medium', l: '中' }, { v: 'large', l: '大' }] as const"
            :key="opt.v"
            class="subtitle-chip"
            :class="{ 'subtitle-chip--active': settings.size === opt.v }"
            type="button"
            @click="setSize(opt.v)"
          >
            {{ opt.l }}
          </button>
        </div>
      </div>

      <div class="subtitle-field">
        <span class="subtitle-field__label">颜色</span>
        <div class="subtitle-chips">
          <button
            class="subtitle-chip"
            :class="{ 'subtitle-chip--active': settings.color === 'white' }"
            type="button"
            @click="setColor('white')"
          >
            白色
          </button>
          <button
            class="subtitle-chip subtitle-chip--yellow"
            :class="{ 'subtitle-chip--active': settings.color === 'yellow' }"
            type="button"
            @click="setColor('yellow')"
          >
            黄色
          </button>
        </div>
      </div>

      <div class="subtitle-field">
        <span class="subtitle-field__label">背景</span>
        <div class="subtitle-chips">
          <button
            class="subtitle-chip"
            :class="{ 'subtitle-chip--active': settings.background === 'black' }"
            type="button"
            @click="setBackground('black')"
          >
            半透明黑
          </button>
          <button
            class="subtitle-chip"
            :class="{ 'subtitle-chip--active': settings.background === 'none' }"
            type="button"
            @click="setBackground('none')"
          >
            无背景
          </button>
        </div>
      </div>
    </div>

    <div class="subtitle-block">
      <div class="subtitle-offset">
        <span class="subtitle-field__label">时间偏移</span>
        <span class="subtitle-offset__value">{{ offsetLabel }}</span>
      </div>
      <input
        class="subtitle-offset__range"
        type="range"
        min="-5"
        max="5"
        step="0.5"
        :value="settings.offsetSec"
        aria-label="字幕时间偏移（秒）"
        @input="setOffset(Number(($event.target as HTMLInputElement).value))"
      />
      <div class="subtitle-offset__hints">
        <span>-5s</span>
        <span>0</span>
        <span>+5s</span>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.subtitle-block + .subtitle-block {
  margin-top: var(--space-5);
}

.subtitle-block__title {
  margin-bottom: var(--space-2);
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
}

.subtitle-block__empty {
  margin: var(--space-3) 0;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.subtitle-block__file {
  width: 100%;
  margin-top: var(--space-3);
}

.subtitle-block__input {
  display: none;
}

.subtitle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
}

.subtitle-row__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.subtitle-list {
  display: flex;
  flex-direction: column;
}

.subtitle-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 48px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-label-strong);
  text-align: left;
}

.subtitle-item--active {
  color: var(--color-brand-text);
}

.subtitle-item__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle-item__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.subtitle-item--unavailable {
  color: var(--color-text-disabled);
}

.subtitle-item--unavailable .subtitle-item__label {
  color: var(--color-text-disabled);
}

/* 设计规范 §12.2：不可用标记用 disabled 文字色 + 14px */
.subtitle-item__unavailable {
  font-size: var(--font-size-14);
  line-height: var(--line-height-14);
  color: var(--color-text-disabled);
}

.subtitle-item__check {
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.subtitle-field {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
}

.subtitle-field__label {
  flex: 0 0 64px;
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.subtitle-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.subtitle-chip {
  min-height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: 1px solid transparent;
  color: var(--color-text-secondary);
  font: var(--text-label);
}

.subtitle-chip--active {
  background-color: var(--color-brand-soft);
  border-color: var(--color-brand);
  color: var(--color-brand-text);
}

.subtitle-chip--yellow.subtitle-chip--active {
  color: var(--color-brand-strong);
}

.subtitle-offset {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}

.subtitle-offset__value {
  font: var(--text-label-strong);
  font-family: var(--font-family-number);
  color: var(--color-text-primary);
}

.subtitle-offset__range {
  width: 100%;
  accent-color: var(--color-brand);
  min-height: 44px;
}

.subtitle-offset__hints {
  display: flex;
  justify-content: space-between;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
