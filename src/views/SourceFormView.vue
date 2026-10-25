<script setup lang="ts">
/**
 * 新增 / 编辑源（页面蓝图 §12，SourceFormView 复用两条路由）
 *
 * 表单逻辑在 `SourceForm` 组件内；本视图负责：
 * - 编辑态加载已有源
 * - 「测试连接」→ `sourceStore.testConnection`（真实探测，不伪造"成功"）
 * - 保存 / 删除 → `sourceStore.create / update / remove`（v1.1 / CHG-01）
 * - 保存成功后 Toast + `router.replace('/settings/sources')`；未保存离开时二次确认
 */
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';

import type { Source, SourceInput } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import SourceForm from '@/components/source/SourceForm.vue';
import IconTrash from '@/components/icons/IconTrash.vue';
import { useSourceStore } from '@/stores/sourceStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

const route = useRoute();
const router = useRouter();
const sources = useSourceStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const sourceId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null));
const isEdit = computed(() => sourceId.value !== null);
const pageTitle = computed(() => (isEdit.value ? '编辑源' : '新增源'));

const source = ref<Source | null>(null);
const loading = ref(false);
const testing = ref(false);
const saving = ref(false);
const removing = ref(false);
const dirty = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

onMounted(async () => {
  if (!isEdit.value) return;
  loading.value = true;
  try {
    await sources.load();
    const found = sources.sources.find((s) => s.id === sourceId.value) ?? null;
    if (!found) {
      toast.error('源不存在或已被删除');
      void router.replace('/settings/sources');
      return;
    }
    if (found.builtin) {
      toast.info('内置源不可编辑');
      void router.replace('/settings/sources');
      return;
    }
    source.value = found;
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    loading.value = false;
  }
});

/**
 * 测试连接（v1.1 / CHG-01）。
 *
 * 直接转发 `sourceStore.testConnection` 的真实探测结果：Store 不抛错，
 * 失败通过 `ok:false + message` 表达；成功时展示延迟毫秒数。
 * 未保存的修改（含地址）也会用当前表单值探测，不会落库。
 */
async function onTest(input: SourceInput): Promise<void> {
  testResult.value = null;
  if (isOffline.value) {
    testResult.value = { ok: false, message: '网络不可用，请连接网络后重试' };
    return;
  }
  testing.value = true;
  try {
    const feedback = await sources.testConnection(input);
    const latency =
      feedback.ok && typeof feedback.latencyMs === 'number' ? `（${Math.round(feedback.latencyMs)} ms）` : '';
    testResult.value = {
      ok: feedback.ok,
      message: feedback.ok
        ? `${feedback.message}${latency}`
        : `${feedback.message}。可先保存配置，稍后在源列表中重试健康检查。`,
    };
    if (feedback.ok) toast.success(`连接成功${latency}`);
  } finally {
    testing.value = false;
  }
}

/**
 * 保存（v1.1 / CHG-01）。
 *
 * 新增 → `sourceStore.create`；编辑 → `sourceStore.update`。
 * 成功后 Toast + `router.replace('/settings/sources')`（replace 避免回退再次进入表单）。
 */
async function onSubmit(input: SourceInput): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    if (isEdit.value && sourceId.value) {
      const updated = await sources.update(sourceId.value, input);
      source.value = updated;
      dirty.value = false;
      toast.success(`已保存「${updated.name}」`);
    } else {
      const created = await sources.create(input);
      dirty.value = false;
      toast.success(`已添加「${created.name}」`);
    }
    await router.replace('/settings/sources');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    saving.value = false;
  }
}

async function removeSource(): Promise<void> {
  const target = source.value;
  if (!target || removing.value) return;
  if (target.builtin) {
    toast.info('内置源不可删除，只能禁用');
    return;
  }
  const ok = await ui.confirm({
    title: `删除「${target.name}」？`,
    message: '删除后将无法从该源浏览内容，收藏与历史会保留。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  removing.value = true;
  try {
    await sources.remove(target.id);
    dirty.value = false;
    toast.success(`已删除「${target.name}」`);
    await router.replace('/settings/sources');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    removing.value = false;
  }
}

function cancel(): void {
  if (dirty.value) {
    void ui
      .confirm({
        title: '放弃修改？',
        message: '你填写的内容尚未保存。',
        confirmText: '放弃',
        danger: true,
      })
      .then((ok) => {
        if (ok) void router.back();
      });
    return;
  }
  void router.back();
}

/* ---------- v1.7/FR-50：CMS 采集接口快捷入口（一等公民） ---------- */

const cmsUrl = ref('');
const cmsBusy = ref(false);
const cmsFeedback = ref<string | null>(null);

/** 粘贴 macCMS provide/vod 端点 → 探测确认 → 建 site 源（ext.cmsDirect） */
async function addCmsDirect(): Promise<void> {
  const trimmed = cmsUrl.value.trim();
  if (cmsBusy.value) return;
  if (!/^https?:\/\//i.test(trimmed)) {
    cmsFeedback.value = '请填写 http(s):// 开头的采集接口地址';
    return;
  }
  if (isOffline.value) {
    cmsFeedback.value = '网络不可用，请连接网络后重试';
    return;
  }
  cmsBusy.value = true;
  cmsFeedback.value = null;
  const host = (() => {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return '采集接口';
    }
  })();
  const input: SourceInput = {
    name: host,
    type: 'site',
    baseUrl: trimmed,
    ext: { cmsDirect: true, searchable: true },
  };
  try {
    const feedback = await sources.testConnection(input);
    if (!feedback.ok) {
      cmsFeedback.value = `探测失败：${feedback.message}`;
      return;
    }
    const created = await sources.create(input);
    dirty.value = false;
    toast.success(`已添加采集接口「${created.name}」`);
    await router.replace('/settings/sources');
  } catch (e) {
    cmsFeedback.value = toErrorShape(e).message;
  } finally {
    cmsBusy.value = false;
  }
}

onBeforeRouteLeave(async () => {
  if (!dirty.value) return true;
  return ui.confirm({
    title: '放弃修改？',
    message: '你填写的内容尚未保存。',
    confirmText: '放弃',
    danger: true,
  });
});
</script>

<template>
  <main class="source-form-page" data-route="source-form">
    <AppHeader :title="pageTitle" back @back="cancel" />

    <div class="source-form-page__body">
      <ComplianceNotice />
      <OfflineBanner v-if="isOffline" text="离线模式，测试连接不可用" />

      <div v-if="loading" class="form-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在读取源配置…</span>
      </div>

      <!-- v1.7/FR-50：CMS 采集接口一键添加（仅新增态展示） -->
      <section v-if="!isEdit && !loading" class="cms-quick">
        <h2 class="field__label">采集接口（CMS）一键添加</h2>
        <div class="cms-quick__row">
          <input
            v-model="cmsUrl"
            class="field__input"
            type="url"
            inputmode="url"
            placeholder="https://example.com/api.php/provide/vod/at/json"
            :disabled="cmsBusy || saving"
            @keydown.enter.prevent="addCmsDirect"
          />
          <button
            class="btn btn--secondary btn--md"
            type="button"
            :disabled="cmsBusy || saving || isOffline"
            @click="addCmsDirect"
          >
            <LoadingSpinner v-if="cmsBusy" :size="16" />
            {{ cmsBusy ? '探测中' : '探测并添加' }}
          </button>
        </div>
        <p v-if="cmsFeedback" class="cms-quick__feedback" role="alert">{{ cmsFeedback }}</p>
        <p class="field__hint">支持 macCMS 采集端点（provide/vod JSON）。添加后可直接搜索与播放。</p>
      </section>

      <SourceForm
        v-else
        :source="source"
        :testing="testing"
        :test-result="testResult"
        :saving="saving"
        @submit="onSubmit"
        @test="onTest"
        @cancel="cancel"
        @dirty-change="dirty = $event"
      />

      <button
        v-if="isEdit && source && !source.builtin"
        class="source-form-page__delete"
        type="button"
        :disabled="removing || saving"
        @click="removeSource"
      >
        <LoadingSpinner v-if="removing" :size="16" />
        <IconTrash v-else :size="18" />
        {{ removing ? '正在删除…' : '删除该源' }}
      </button>
    </div>
  </main>
</template>

<style scoped>
.source-form-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.source-form-page__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.form-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

/* v1.7/FR-50：采集接口快捷入口 */
.cms-quick {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cms-quick__row {
  display: flex;
  gap: var(--space-2);
}

.cms-quick__row .field__input {
  flex: 1 1 auto;
  min-width: 0;
}

.cms-quick__feedback {
  font: var(--text-caption);
  color: var(--color-danger);
}

.source-form-page__delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 44px;
  margin-top: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 90, 95, 0.4);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-button-sm);
}
</style>
