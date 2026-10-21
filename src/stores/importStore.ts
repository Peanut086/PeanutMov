/**
 * 订阅导入 Store（API-14，v1.1 / CHG-02 新增）
 *
 * 责任：承载「解析预览 → 勾选提交」的跨组件会话态，内部只调 `importService`；
 * UI 不直接触达 `@/services/importService`，`ImportRecord` 类型也从本文件再导出。
 *
 * 错误语义：
 * - `previewFrom*` / `loadRecords`：失败写 `error`、`preview` 置 null、**不抛出**（保留用户输入）；
 * - `commit`：失败写 `error` 并 **re-throw**（UI 需区分事务失败与「成功但有跳过」）。
 * - 提交成功后不写 `sourceStore`，靠 `importService` 发出的 `sources:changed` 联动刷新。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { importService, listImportRecords } from '@/services/importService';
import type { ImportRecord } from '@/services/importService';
import { AppError, toAppError, toErrorShape } from '@/shared/errors';
import type { AppErrorShape, ImportCommitOptions, ImportPreview, ImportResult } from '@/types';

export type { ImportRecord };

export const useImportStore = defineStore('import', () => {
  const preview = ref<ImportPreview | null>(null);
  const parsing = ref(false);
  const committing = ref(false);
  const error = ref<AppErrorShape | null>(null);
  const records = ref<ImportRecord[]>([]);

  /** 预览请求序号：并发/连续解析时只接受最后一次的结果 */
  let parseSeq = 0;

  async function runPreview(task: (seq: number) => Promise<ImportPreview>): Promise<void> {
    parseSeq += 1;
    const seq = parseSeq;
    parsing.value = true;
    error.value = null;
    preview.value = null;
    try {
      const result = await task(seq);
      if (seq !== parseSeq) return; // 已有更新的解析请求，丢弃本次结果
      preview.value = result;
    } catch (e) {
      if (seq !== parseSeq) return;
      error.value = toErrorShape(e, 'E_PARSE');
      preview.value = null;
    } finally {
      if (seq === parseSeq) parsing.value = false;
    }
  }

  async function previewFromUrl(url: string): Promise<void> {
    await runPreview(() => importService.previewFromUrl(url));
  }

  async function previewFromFile(file: File): Promise<void> {
    await runPreview(() => importService.previewFromFile(file));
  }

  async function previewFromText(text: string, fileName: string): Promise<void> {
    await runPreview(() => importService.previewFromText(text, fileName));
  }

  /** 只消费 `state.preview`，保证「预览 → 提交」是同一份快照 */
  async function commit(options: ImportCommitOptions): Promise<ImportResult> {
    const current = preview.value;
    if (current === null) {
      const invalid = new AppError('E_INVALID_STATE', '请先解析订阅');
      error.value = invalid.toShape();
      throw invalid;
    }

    committing.value = true;
    error.value = null;
    try {
      const result = await importService.commit(current, options);
      // 源列表刷新由 importService 的 `sources:changed` 驱动，此处不双写
      return result;
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    } finally {
      committing.value = false;
    }
  }

  /** 清空预览与错误，保留历史记录 */
  function reset(): void {
    parseSeq += 1; // 使进行中的解析结果失效
    preview.value = null;
    error.value = null;
    parsing.value = false;
    committing.value = false;
  }

  async function loadRecords(): Promise<void> {
    try {
      records.value = await listImportRecords();
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
    }
  }

  return {
    preview,
    parsing,
    committing,
    error,
    records,
    previewFromUrl,
    previewFromFile,
    previewFromText,
    commit,
    reset,
    loadRecords,
  };
});

export type ImportStore = ReturnType<typeof useImportStore>;
