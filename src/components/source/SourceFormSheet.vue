<script setup lang="ts">
/**
 * 源表单弹层（OPT-09）
 *
 * 将 SourceForm 包裹在 BottomSheet 中，用于在设置页内就地新增/编辑源。
 * 提交与测试连接回调由父级通过事件处理。
 */
import { computed, ref, watch } from 'vue';

import type { Source, SourceInput } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import SourceForm from '@/components/source/SourceForm.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

interface Props {
  open: boolean;
  source?: Source | null;
  saving?: boolean;
  testing?: boolean;
  testResult?: { ok: boolean; message: string } | null;
}

const props = withDefaults(defineProps<Props>(), {
  source: null,
  saving: false,
  testing: false,
  testResult: null,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'submit', input: SourceInput): void;
  (e: 'test', input: SourceInput): void;
  (e: 'cancel'): void;
}>();

const isOpen = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
});

const formDirty = ref(false);
const formRef = ref<InstanceType<typeof SourceForm> | null>(null);

const title = computed(() => (props.source ? `编辑「${props.source.name}」` : '新增源'));

watch(
  () => props.open,
  (v) => {
    if (v) formDirty.value = false;
  },
);

function onSubmit(input: SourceInput): void {
  emit('submit', input);
}

function onTest(input: SourceInput): void {
  emit('test', input);
}

function onCancel(): void {
  emit('cancel');
  isOpen.value = false;
}

function onDirtyChange(dirty: boolean): void {
  formDirty.value = dirty;
}

/** BottomSheet 关闭前确认（有未保存改动时提示） */
function onSheetClose(): void {
  isOpen.value = false;
}
</script>

<template>
  <BottomSheet
    :model-value="isOpen"
    :title="title"
    @update:model-value="isOpen = $event"
    @close="onSheetClose"
  >
    <SourceForm
      ref="formRef"
      :source="source"
      :saving="saving"
      :testing="testing"
      :test-result="testResult"
      @submit="onSubmit"
      @test="onTest"
      @cancel="onCancel"
      @dirty-change="onDirtyChange"
    />

    <template v-if="saving" #footer>
      <div class="source-form-sheet__saving">
        <LoadingSpinner :size="16" />
        <span>保存中…</span>
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.source-form-sheet__saving {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}
</style>
