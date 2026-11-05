<script setup lang="ts">
/**
 * 豆瓣榜单页（功能扩展-1）
 *
 * 展示豆瓣公开榜单：正在热映、Top250、热门电视剧、即将上映。
 * 每行横向滚动，点击条目跳转搜索（以片名在已配置源中查找资源）。
 * 数据由 doubanService 提供，30 分钟内存缓存。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { DoubanCategory, DoubanItem } from '@/services/doubanService';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import PosterImage from '@/components/common/PosterImage.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import IconStar from '@/components/icons/IconStar.vue';
import { getAllCategories, clearDoubanCache } from '@/services/doubanService';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { toErrorShape } from '@/shared/errors';

defineOptions({ name: 'DoubanView' });

const router = useRouter();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const loading = ref(true);
const categories = ref<DoubanCategory[]>([]);
const loadError = ref<string | null>(null);

const isEmpty = computed(() => !loading.value && !loadError.value && categories.value.length === 0);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    categories.value = await getAllCategories();
  } catch (e) {
    loadError.value = toErrorShape(e).message;
  } finally {
    loading.value = false;
  }
}

async function retry(): Promise<void> {
  clearDoubanCache();
  await load();
  if (!loadError.value) toast.success('已刷新');
}

function searchItem(item: DoubanItem): void {
  void router.push({ name: 'search', query: { q: item.title } });
}

function goBack(): void {
  if (window.history.length > 1) {
    router.back();
  } else {
    void router.push('/');
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <SafeArea data-route="douban">
    <AppHeader title="豆瓣榜单" :back="true" @back="goBack" />

    <div class="douban-body">
      <OfflineBanner v-if="isOffline" />

      <!-- 错误态 -->
      <div v-if="loadError" class="douban-error" role="alert">
        <span class="douban-error__text">{{ loadError }}</span>
        <button class="btn btn--secondary btn--sm" type="button" @click="retry">重试</button>
      </div>

      <!-- 加载骨架 -->
      <template v-if="loading">
        <div v-for="n in 3" :key="`sk-${n}`" class="douban-section">
          <div class="douban-section__head">
            <div class="skeleton skeleton--title" style="width: 100px; height: 18px;" />
          </div>
          <div class="douban-rail">
            <div v-for="i in 4" :key="`sk-card-${n}-${i}`" class="douban-card douban-card--skeleton">
              <div class="skeleton" style="width: 100%; aspect-ratio: 2/3; border-radius: var(--radius-card);" />
              <div class="skeleton" style="width: 70%; height: 14px; margin-top: 8px;" />
              <div class="skeleton" style="width: 40%; height: 12px; margin-top: 4px;" />
            </div>
          </div>
        </div>
      </template>

      <!-- 空态 -->
      <div v-else-if="isEmpty" class="douban-empty">
        <p class="douban-empty__text">暂无榜单数据</p>
        <button class="btn btn--primary btn--md" type="button" @click="retry">刷新</button>
      </div>

      <!-- 榜单内容 -->
      <template v-else>
        <section
          v-for="cat in categories"
          :key="cat.name"
          class="douban-section"
          :aria-labelledby="`douban-${cat.name}`"
        >
          <div class="douban-section__head">
            <h2 :id="`douban-${cat.name}`" class="section-title">{{ cat.name }}</h2>
            <span class="douban-section__count">{{ cat.items.length }} 部</span>
          </div>
          <div class="douban-rail">
            <button
              v-for="item in cat.items"
              :key="item.id"
              class="douban-card"
              type="button"
              :aria-label="`${item.title}${item.rating ? `，评分 ${item.rating}` : ''}`"
              @click="searchItem(item)"
            >
              <div class="douban-card__frame">
                <PosterImage :src="item.posterUrl" :alt="item.title" />
                <span v-if="item.rating" class="douban-card__rating" aria-hidden="true">
                  <IconStar :size="10" />
                  {{ item.rating.toFixed(1) }}
                </span>
              </div>
              <span class="douban-card__title clamp-2">{{ item.title }}</span>
              <span v-if="item.year || item.subtitle" class="douban-card__meta">
                {{ item.subtitle || item.year }}
              </span>
            </button>
          </div>
        </section>

        <!-- 底部刷新 -->
        <div class="douban-footer">
          <button class="btn btn--secondary btn--sm" type="button" :disabled="loading" @click="retry">
            <LoadingSpinner v-if="loading" :size="14" />
            刷新数据
          </button>
        </div>
      </template>
    </div>
  </SafeArea>
</template>

<style scoped>
.douban-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) var(--space-6);
}

.douban-error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 48px;
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  border: 1px solid rgba(255, 90, 95, 0.3);
}

.douban-error__text {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-label);
  color: var(--color-text-primary);
}

.douban-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.douban-section + .douban-section {
  margin-top: var(--space-6);
}

.douban-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.douban-section__count {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.douban-rail {
  display: flex;
  gap: var(--space-3);
  overflow-x: auto;
  scrollbar-width: none;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
  margin: 0 calc(var(--layout-page-padding-x) * -1);
  padding: 0 var(--layout-page-padding-x);
}

.douban-rail::-webkit-scrollbar {
  display: none;
}

.douban-card {
  flex: 0 0 auto;
  width: 110px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-align: left;
  scroll-snap-align: start;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.douban-card:active {
  transform: scale(0.97);
}

.douban-card--skeleton {
  pointer-events: none;
}

.douban-card__frame {
  position: relative;
  width: 100%;
  border-radius: var(--radius-card);
  overflow: hidden;
  background-color: var(--color-bg-surface);
}

.douban-card__rating {
  position: absolute;
  bottom: var(--space-1);
  right: var(--space-1);
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: 4px;
  background-color: rgba(0, 0, 0, 0.68);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #ffc83d;
  font: var(--font-weight-semibold) 10px / 1 var(--font-family-number);
}

.douban-card__title {
  font: var(--font-weight-semibold) 12.5px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.douban-card__meta {
  font: var(--font-weight-regular) 10.5px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.douban-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  margin: auto;
  padding: var(--space-8) var(--space-4);
}

.douban-empty__text {
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.douban-footer {
  display: flex;
  justify-content: center;
  margin-top: var(--space-6);
}

.skeleton {
  background: linear-gradient(90deg, var(--color-bg-skeleton) 25%, var(--color-bg-skeleton-highlight) 50%, var(--color-bg-skeleton) 75%);
  background-size: 200% 100%;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
  border-radius: var(--radius-sm);
}

.skeleton--title {
  border-radius: var(--radius-sm);
}

@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
