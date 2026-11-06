<script setup lang="ts">
/**
 * 内嵌字幕轨菜单（EXT-07）
 *
 * 与「字幕」面板（SubtitleSheet，外挂 SRT/VTT + 样式）分工：
 * - 本菜单只切**码流内嵌**字幕轨（ExoPlayer TrackGroup），支持「关闭字幕」
 * - 外挂字幕的样式/偏移仍走 SubtitleSheet，通过底部按钮跳转
 *
 * 状态齐备：加载中 / 无可用轨道 / 读取失败（可重试）/ 正常列表。
 */
import type { EmbeddedTextTrack } from '@/player/PlayerController';

import BottomSheet from '@/components/common/BottomSheet.vue';

withDefaults(
  defineProps<{
    modelValue: boolean;
    tracks: EmbeddedTextTrack[];
    /** 当前字幕轨 id；null = 字幕关闭 */
    activeId: number | null;
    /** 轨道仍在探测（Java 侧尚未回报） */
    loading?: boolean;
    /** 读取失败的原因；非空时展示错误态 + 重试 */
    error?: string | null;
  }>(),
  { loading: false, error: null },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', id: number | null): void;
  (e: 'open-external'): void;
  (e: 'retry'): void;
}>();

function choose(id: number | null): void {
  emit('select', id);
  emit('update:modelValue', false);
}

function openExternal(): void {
  emit('open-external');
  emit('update:modelValue', false);
}

function metaOf(track: EmbeddedTextTrack): string {
  if (track.mimeType) {
    const parts = track.mimeType.split('/');
    const tail = parts[parts.length - 1] ?? '';
    if (tail.length > 0) return tail.toUpperCase();
  }
  return track.language ? track.language.toUpperCase() : '';
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="字幕轨"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="loading" class="track-state" role="status">正在读取字幕轨…</p>

    <div v-else-if="error" class="track-state" role="alert">
      <p class="track-state__text">{{ error }}</p>
      <button class="btn btn--secondary btn--sm" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else>
      <ul class="track-list">
        <li>
          <button
            class="track-item"
            :class="{ 'track-item--active': activeId === null }"
            type="button"
            @click="choose(null)"
          >
            <span class="track-item__label">关闭字幕</span>
            <span v-if="activeId === null" class="track-item__check">当前</span>
          </button>
        </li>
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

      <p v-if="tracks.length === 0" class="track-state__empty" data-test="subtitle-no-track">
        无可用轨道。该片源没有内嵌字幕轨，可用下方外挂字幕文件替代。
      </p>

      <button
        class="btn btn--secondary btn--md track-footer"
        type="button"
        data-test="subtitle-open-external"
        @click="openExternal"
      >
        外挂字幕与样式
      </button>
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

.track-footer {
  width: 100%;
  margin-top: var(--space-3);
}
</style>
