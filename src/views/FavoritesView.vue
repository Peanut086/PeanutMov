<script setup lang="ts">
/**
 * 收藏夹（页面蓝图 §9）
 *
 * 2 列网格；源已移除卡片带 danger 标签，点击 Toast 提示（AC-35）；
 * 长按打开 Sheet（取消收藏 / 查看详情）；排序：最近收藏 / 标题（AC-65）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { FavoriteRecord, LoadState } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import StateView from '@/components/common/StateView.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import FavoriteCard from '@/components/media/FavoriteCard.vue';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { favoriteService } from '@/services/favoriteService';
import { useToast } from '@/composables/useToast';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const favorites = useFavoriteStore();
const toast = useToast();

const sortOpen = ref(false);
const menuOpen = ref(false);
const active = ref<FavoriteRecord | null>(null);

const loading = computed(() => favorites.state === 'idle' || favorites.state === 'loading');
const isEmpty = computed(() => favorites.state === 'empty' || favorites.items.length === 0);

/** 交给 StateView 的四态；优先级与原 v-if/v-else-if 链逐条一致（加载 > 错误 > 空 > 内容） */
const viewState = computed<LoadState>(() => {
  if (loading.value) return 'loading';
  if (favorites.state === 'error') return 'error';
  if (isEmpty.value) return 'empty';
  return 'success';
});

const sorted = computed(() => {
  const list = [...favorites.items];
  if (favorites.order === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return list.sort((a, b) => b.createdAt - a.createdAt);
});

const orderLabel = computed(() => (favorites.order === 'title' ? '标题' : '最近收藏'));

onMounted(async () => {
  await favorites.load();
});

function open(item: FavoriteRecord): void {
  if (item.sourceRemoved) {
    toast.error('无法播放，源已移除');
    return;
  }
  void router.push({ name: 'detail', params: { mediaId: item.mediaId }, query: { sourceId: item.sourceId } });
}

function onLongPress(item: FavoriteRecord): void {
  active.value = item;
  menuOpen.value = true;
}

async function unfavorite(): Promise<void> {
  const item = active.value;
  if (!item) return;
  menuOpen.value = false;
  try {
    await favorites.remove(item.id);
    toast.action('已取消收藏', { label: '撤销', onClick: () => void restoreFavorite(item) }, 'success');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

/** 撤销：整条记录原样写回（收藏时间与排序位不变），列表靠 `favorites:changed` 事件刷新 */
async function restoreFavorite(item: FavoriteRecord): Promise<void> {
  try {
    await favoriteService.restore(item);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function viewDetail(): void {
  const item = active.value;
  menuOpen.value = false;
  if (item) open(item);
}

async function setOrder(order: 'created' | 'title'): Promise<void> {
  sortOpen.value = false;
  await favorites.load(order);
}


function goLibrary(): void {
  void router.push('/library');
}
</script>

<template>
  <main class="favorites-page" data-route="favorites">
    <AppHeader title="收藏" back>
      <template #actions>
        <button class="favorites-sort" type="button" @click="sortOpen = true">
          排序
        </button>
      </template>
    </AppHeader>

    <div class="favorites-body" data-scroll="page">
      <StateView :state="viewState">
        <template #loading>
          <div class="favorites-loading" role="status">
            <LoadingSpinner :size="24" />
            <span>正在读取收藏…</span>
          </div>
        </template>

        <template #error>
          <ErrorState
            :error="{ code: 'E_DB', message: '收藏读取失败', detail: null, retryable: true, httpStatus: null }"
            @retry="favorites.load()"
          />
        </template>

        <template #empty>
          <EmptyState
            variant="favorite"
            title="还没有收藏"
            description="在详情页点 ♥ 收藏想看的内容"
            action-text="去媒体库看看"
            @action="goLibrary"
          />
        </template>

        <p class="favorites-count">共 {{ sorted.length }} 个 · 按{{ orderLabel }}排序</p>
        <div class="favorites-grid">
          <FavoriteCard
            v-for="item in sorted"
            :key="item.id"
            :item="item"
            @select="open"
            @longpress="onLongPress"
          />
        </div>
      </StateView>
    </div>

    <BottomSheet v-model="sortOpen" title="排序方式">
      <ul class="sheet-list">
        <li>
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': favorites.order === 'created' }"
            type="button"
            @click="setOrder('created')"
          >
            最近收藏
          </button>
        </li>
        <li>
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': favorites.order === 'title' }"
            type="button"
            @click="setOrder('title')"
          >
            标题
          </button>
        </li>
      </ul>
    </BottomSheet>

    <BottomSheet v-model="menuOpen" :title="active?.title ?? '操作'">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="viewDetail">查看详情</button></li>
        <li>
          <button class="sheet-list__item sheet-list__item--danger" type="button" @click="unfavorite">
            取消收藏
          </button>
        </li>
      </ul>
    </BottomSheet>
  </main>
</template>

<style scoped>
.favorites-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.favorites-sort {
  min-width: 44px;
  height: 44px;
  padding: 0 var(--space-2);
  font: var(--text-label);
  color: var(--color-brand-text);
}

.favorites-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.favorites-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.favorites-count {
  padding: var(--space-2) 0 var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.favorites-grid {
  display: grid;
  grid-template-columns: repeat(var(--layout-grid-columns), minmax(0, 1fr));
  column-gap: var(--layout-grid-gap);
  row-gap: var(--space-4);
}

.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.sheet-list__item--active {
  color: var(--color-brand-text);
}

.sheet-list__item--danger {
  color: var(--color-danger);
}
</style>
