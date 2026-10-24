<script setup lang="ts">
/**
 * 批量订阅评测（CHG-12）
 *
 * 粘贴一批订阅 URL（导航页清单直接全选复制即可）→ 并行「拉取 + 解析 + 抽样探测」
 * → 按「活条目估计」降序排行，供挑选真正要导入的订阅。行内「导入」跳导入页并预填地址。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { SubscriptionEvalResult } from '@/services/subscriptionEvalService';
import { subscriptionEvalService, extractUrls } from '@/services/subscriptionEvalService';

import AppHeader from '@/components/layout/AppHeader.vue';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const { isOffline } = useOnlineStatus();

const rawText = ref('');
const running = ref(false);
const progress = ref<{ done: number; total: number } | null>(null);
const results = ref<SubscriptionEvalResult[]>([]);
const error = ref<string | null>(null);

const controller = ref<AbortController | null>(null);

const urls = computed(() => extractUrls(rawText.value));

function aliveText(result: SubscriptionEvalResult): string {
  const parts: string[] = [];
  if (result.isMultiRepo) {
    parts.push(`多仓索引（${result.repoCount} 个仓库，需展开后评测）`);
    return parts.join(' · ');
  }
  if (result.total !== null) parts.push(`共 ${result.total} 条`);
  if (result.siteCount > 0) {
    parts.push(
      result.siteAlive !== null
        ? `站点 ${result.siteAlive}/${result.siteChecked} 活（全源 ${result.siteCount}）`
        : `站点 ${result.siteCount}`,
    );
  }
  if (result.spiderCount > 0) {
    parts.push(
      result.jarDead !== null
        ? `爬虫 jar ${result.spiderCount - result.jarDead}/${result.jarTotal} 活`
        : `爬虫 ${result.spiderCount}`,
    );
  }
  if (result.jsCount > 0) parts.push(`JS 爬虫 ${result.jsCount}（不执行）`);
  if (result.doubanCount > 0) parts.push(`豆瓣 ${result.doubanCount}`);
  if (result.error) parts.push(`失败：${result.error.message}`);
  return parts.join(' · ') || '空订阅';
}

async function start(): Promise<void> {
  if (running.value || urls.value.length === 0) return;
  if (isOffline.value) {
    error.value = '网络不可用，评测需要联网';
    return;
  }
  running.value = true;
  error.value = null;
  results.value = [];
  progress.value = { done: 0, total: urls.value.length };
  const abort = new AbortController();
  controller.value = abort;
  try {
    results.value = await subscriptionEvalService.evaluate(
      urls.value,
      abort.signal,
      (done, total) => {
        progress.value = { done, total };
      },
    );
  } catch (e) {
    error.value = toErrorShape(e).message;
  } finally {
    running.value = false;
    progress.value = null;
    controller.value = null;
  }
}

function cancel(): void {
  controller.value?.abort();
}

function goImport(url: string): void {
  void router.push({ path: '/settings/sources/import', query: { url } });
}

onBeforeUnmount(() => {
  controller.value?.abort();
});
</script>

<template>
  <main class="eval-page" data-route="subscription-eval">
    <AppHeader title="批量订阅评测" back />

    <div class="eval-body">
      <ComplianceNotice />

      <p class="eval-hint">
        粘贴一批订阅地址（每行一条，可含编号等杂文字），逐条拉取解析并抽样探测，
        按「活条目估计」排行。评测只读，不会导入任何源。
      </p>

      <textarea
        v-model="rawText"
        class="eval-input"
        rows="8"
        placeholder="1	订阅名	http://example.com/tv.json&#10;2	另一个	https://…"
        spellcheck="false"
      />

      <div class="eval-actions">
        <button
          class="btn btn--primary btn--md eval-actions__btn"
          type="button"
          :disabled="running || urls.length === 0"
          @click="start"
        >
          评测 {{ urls.length > 0 ? `（${urls.length} 条）` : '' }}
        </button>
        <button
          v-if="running"
          class="btn btn--secondary btn--md"
          type="button"
          @click="cancel"
        >
          取消
        </button>
      </div>

      <p v-if="running && progress" class="eval-progress" role="status">
        <LoadingSpinner :size="14" />
        评测中 {{ progress.done }}/{{ progress.total }}
      </p>
      <p v-if="error" class="eval-error">{{ error }}</p>

      <ul v-if="results.length > 0" class="eval-results">
        <li v-for="(result, index) in results" :key="result.url" class="eval-row">
          <div class="eval-row__rank" :class="{ 'eval-row__rank--top': index < 3 && result.status === 'ok' }">
            {{ index + 1 }}
          </div>
          <div class="eval-row__main">
            <p class="eval-row__name truncate-1">
              {{ result.name ?? result.url }}
              <span v-if="result.error" class="eval-row__fail">失败</span>
            </p>
            <p class="eval-row__detail">{{ aliveText(result) }}</p>
            <p class="eval-row__url truncate-1">{{ result.url }} · {{ result.latencyMs }}ms</p>
          </div>
          <button
            v-if="!result.isMultiRepo && result.status === 'ok'"
            class="btn btn--secondary btn--sm"
            type="button"
            @click="goImport(result.url)"
          >
            导入
          </button>
        </li>
      </ul>
    </div>
  </main>
</template>

<style scoped>
.eval-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-base);
}

.eval-body {
  flex: 1 1 auto;
  padding: 0 var(--space-4) calc(var(--space-6) + var(--safe-bottom));
}

.eval-hint {
  margin-top: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.eval-input {
  width: 100%;
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-caption);
  font-family: var(--font-family-number);
  resize: vertical;
}

.eval-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.eval-actions__btn {
  flex: 1 1 auto;
}

.eval-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.eval-error {
  margin-top: var(--space-3);
  font: var(--text-caption);
  color: var(--color-danger);
}

.eval-results {
  margin-top: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.eval-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.eval-row__rank {
  flex: 0 0 24px;
  text-align: center;
  font: var(--text-body-strong);
  font-family: var(--font-family-number);
  color: var(--color-text-tertiary);
}

.eval-row__rank--top {
  color: var(--color-brand);
}

.eval-row__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.eval-row__name {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.eval-row__fail {
  margin-left: var(--space-1);
  font: var(--text-caption);
  color: var(--color-danger);
}

.eval-row__detail {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.eval-row__url {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
