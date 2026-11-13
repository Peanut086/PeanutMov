<script setup lang="ts">
/**
 * 跳过源披露（SO-02 / F5）
 *
 * 全局截止时间只拦「新源启动」，所以在途慢源跑完后仍有一批源根本没被搜过。
 * 四档真机实测候选 133 个、实际发起的爬虫搜索只有 18~31 个，这个差值此前只在
 * 「空结果」分支渲染（有结果时永远看不到），用户无从判断结果是不是全量。
 * 现在空态与结果态都渲染，并把「继续搜索剩余源」的入口交给调用方。
 */
defineProps<{
  candidates: number;
  skippedCount: number;
  busy?: boolean;
  retrying?: boolean;
}>();

defineEmits<{ continue: [] }>();
</script>

<template>
  <div v-if="skippedCount > 0" class="search-skipped-disclosure">
    <svg class="search-skipped-disclosure__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 8v5M12 16.2v.2" />
    </svg>
    <p class="search-skipped-disclosure__text">
      仅搜索了 {{ candidates - skippedCount }} / {{ candidates }} 个源，剩余 {{ skippedCount }} 个因超时未搜索
    </p>
    <button
      class="btn btn--secondary btn--sm"
      type="button"
      :disabled="retrying || busy"
      @click="$emit('continue')"
    >
      继续搜索剩余 {{ skippedCount }} 个源
    </button>
  </div>
</template>

<style scoped>
.search-skipped-disclosure {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid rgba(251, 191, 36, 0.22);
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
  font: var(--text-caption);
}

/* 文案是主体，占满剩余宽度；按钮固定不随文字长度被挤压 */
.search-skipped-disclosure__text {
  flex: 1 1 auto;
  margin: 0;
}

.search-skipped-disclosure__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.search-skipped-disclosure .btn {
  flex: 0 0 auto;
}
</style>
