<script setup lang="ts">
/**
 * 新增 / 编辑源（页面蓝图 §12，SourceFormView 复用两条路由）
 *
 * 表单逻辑在 `SourceForm` 组件内；本视图负责：
 * - 编辑态加载已有源
 * - 「测试连接」（本地地址校验，见 `onTest` 注释；不伪造"成功"）
 * - 保存/删除：API-14 未暴露写接口，UI 只做校验并如实提示
 * - 保存后返回 + Toast；未保存离开时二次确认
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
import { getHost } from '@/shared/url';

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
 * 测试连接。
 *
 * 契约缺口：API-14 `sourceStore` 只有 load/select/setEnabled/reorder/refreshHealth，
 * 未暴露 `testConnection`；而 `sourceService.testConnection` 不在 UI 包 import 白名单内
 * （开发任务拆分 2.2）。因此这里只做本地地址可达性预检，并**明确标注为本地校验**，
 * 不伪造"连接成功"。待 PM 决策（扩 API-14 或放开白名单）后替换为真实探测。
 */
async function onTest(input: SourceInput): Promise<void> {
  testResult.value = null;
  if (isOffline.value) {
    testResult.value = { ok: false, message: '网络不可用，请连接网络后重试' };
    return;
  }
  testing.value = true;
  try {
    const host = getHost(input.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 320));
    testResult.value = {
      ok: true,
      message: `地址格式有效（${host}）。此为本地校验，不代表源真实可用。`,
    };
  } catch (e) {
    testResult.value = { ok: false, message: toErrorShape(e).message };
  } finally {
    testing.value = false;
  }
}

/**
 * 保存。
 *
 * 契约缺口：API-14 `sourceStore` 未提供 create/update/remove，UI 不得直接引用
 * `sourceService`（不在 2.2 白名单），所以当前只做表单校验，**不伪造落库成功**。
 */
async function onSubmit(_input: SourceInput): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    toast.info('表单校验已通过；应用内新增/编辑源暂未开放，本次未写入');
    dirty.value = false;
    void router.back();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    saving.value = false;
  }
}

async function removeSource(): Promise<void> {
  if (!source.value) return;
  const ok = await ui.confirm({
    title: `删除「${source.value.name}」？`,
    message: '删除后将无法从该源浏览内容，收藏与历史会保留。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  toast.info('应用内删除源暂未开放，本次未做任何改动');
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
        @click="removeSource"
      >
        <IconTrash :size="18" />
        删除该源
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
