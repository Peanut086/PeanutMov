<script setup lang="ts">
/**
 * 音轨菜单（EXT-07）
 *
 * 列出码流内嵌音轨：名称 / 语言 / 声道数，当前项打勾。音轨不能「关闭」，
 * 因此不提供空选行；无轨道时明确提示「无可用轨道」。
 *
 * 状态齐备：加载中 / 无可用轨道 / 读取失败（可重试）/ 正常列表。
 */
import type { EmbeddedAudioTrack } from '@/player/PlayerController';

import BottomSheet from '@/components/common/BottomSheet.vue';

withDefaults(
  defineProps<{
    modelValue: boolean;
    tracks: EmbeddedAudioTrack[];
    /** 当前音轨 id；null = 未知（播放器自选） */
    activeId: number | null;
    loading?: boolean;
    error?: string | null;
  }>(),
  { loading: false, error: null },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', id: number): void;
  (e: 'retry'): void;
}>();

function choose(id: number): void {
  emit('select', id);
  emit('update:modelValue', false);
}

/** 声道数 → 可读标签（1/2/6/8 常见档位，其余显示「N 声道」） */
function channelLabel(channels: number | null): string {
  if (channels === null || channels <= 0) return '';
  if (channels === 1) return '单声道';
  if (channels === 2) return '立体声';
  if (channels === 6) return '5.1 声道';
  if (channels === 8) return '7.1 声道';
  return `${channels} 声道`;
}

function metaOf(track: EmbeddedAudioTrack): string {
  const parts: string[] = [];
  if (track.language) parts.push(track.language.toUpperCase());
  const ch = channelLabel(track.channels);
  if (ch) parts.push(ch);
  return parts.join(' · ');
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="音轨"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="loading" class="track-state" role="status">正在读取音轨…</p>

    <div v-else-if="error" class="track-state" role="alert">
      <p class="track-state__text">{{ error }}</p>
      <button class="btn btn--secondary btn--sm" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else>
      <ul class="track-list">
        <li v-for="track in tracks" :key="track.id">
          <button
            class="track-item"
            :class="{ 'track-item--active': activeId === track.id }"
            type="button"
            @click="choose(track.id)"
          >
            <span class="track-item__label">{{ track.label }}</span>
            <span v-if="metaOf(track)" class="track-item__meta">{{ metaOf(track) }}</span>
            <span v-if="activeId === track.id" class="track-item__check">当前</span>
          </button>
        </li>
      </ul>

      <p v-if="tracks.length === 0" class="track-state__empty" data-test="audio-no-track">
        无可用轨道。该片源只有一条默认音轨，或轨道信息尚未解析完成。
      </p>
    </template>
  </BottomSheet>
</template>

<style scoped>
.track-list {
  display: flex;
  flex-direction: column;
}

.track-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.track-item--active {
  color: var(--color-brand-text);
}

.track-item__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-item__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.track-item__check {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.track-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-2);
  font: var(--text-label);
  color: var(--color-text-secondary);
  text-align: center;
}

.track-state__text {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.track-state__empty {
  padding: var(--space-3) var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: center;
}
</style>
