<script setup lang="ts">
/**
 * 源表单（页面蓝图 §12）
 *
 * - 类型切换动态字段：AList/WebDAV（账号密码）、Jellyfin（API Key + userId）、站点（请求头）
 * - 校验：名称 1–30、地址 `isValidHttpUrl`、子路径可选；保存前 `normalizeBaseUrl`
 * - 测试连接：地址非法不发请求；合法则回调父级（真实调用由数据包提供）
 * - 错误就地展示（12px danger），保存按钮禁用直到合法（AC-04）
 *
 * 本组件**只做表单与本地校验**，不直接调用 Service；提交/测试连接通过事件抛给视图。
 */
import { computed, reactive, ref, watch } from 'vue';

import type { AuthMode, Source, SourceInput, SourceType } from '@/types';
import { normalizeBaseUrl, isValidHttpUrl } from '@/shared/url';
import { SOURCE_NAME_MAX_LENGTH } from '@/shared/constants';

import SegmentedControl from '@/components/common/SegmentedControl.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

interface Props {
  /** 编辑态传入；新增为空 */
  source?: Source | null;
  /** 测试连接结果 */
  testing?: boolean;
  testResult?: { ok: boolean; message: string } | null;
  /** 保存中 */
  saving?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  source: null,
  testing: false,
  testResult: null,
  saving: false,
});

const emit = defineEmits<{
  (e: 'submit', input: SourceInput): void;
  (e: 'test', input: SourceInput): void;
  (e: 'cancel'): void;
  (e: 'dirty-change', dirty: boolean): void;
}>();

interface FormState {
  type: SourceType;
  name: string;
  baseUrl: string;
  pathPrefix: string;
  authMode: AuthMode;
  username: string;
  password: string;
  token: string;
  userId: string;
  headersText: string;
}

const TYPE_CARDS: Array<{ value: SourceType; label: string; hint: string }> = [
  { value: 'alist', label: 'AList', hint: '局域网/网盘目录' },
  { value: 'webdav', label: 'WebDAV', hint: 'NAS 文件目录' },
  { value: 'jellyfin', label: 'Jellyfin', hint: '自建媒体服务' },
  { value: 'site', label: '站点', hint: 'TVBox 兼容接口' },
];

function fromSource(source: Source | null): FormState {
  if (!source) {
    return {
      type: 'alist',
      name: '',
      baseUrl: '',
      pathPrefix: '',
      authMode: 'none',
      username: '',
      password: '',
      token: '',
      userId: '',
      headersText: '',
    };
  }
  return {
    type: source.type === 'demo' ? 'alist' : source.type,
    name: source.name,
    baseUrl: source.baseUrl,
    pathPrefix: source.pathPrefix ?? '',
    authMode: source.auth.mode,
    username: source.auth.username ?? '',
    password: source.auth.password ?? '',
    token: source.auth.token ?? '',
    userId: typeof source.ext?.userId === 'string' ? source.ext.userId : '',
    headersText: Object.entries(source.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  };
}

const form = reactive<FormState>(fromSource(props.source));

watch(
  () => props.source,
  (next) => Object.assign(form, fromSource(next)),
);

/* ---------- 脏检查 ---------- */
const initialSnapshot = ref(JSON.stringify(form));
const isDirty = computed(() => JSON.stringify(form) !== initialSnapshot.value);
watch(isDirty, (dirty) => emit('dirty-change', dirty));

/* ---------- 校验 ---------- */
const touched = reactive({ name: false, baseUrl: false });

const nameError = computed(() => {
  const value = form.name.trim();
  if (value.length === 0) return '名称不能为空';
  if (value.length > SOURCE_NAME_MAX_LENGTH) return `名称最多 ${SOURCE_NAME_MAX_LENGTH} 个字符`;
  return '';
});

const baseUrlError = computed(() => {
  if (form.baseUrl.trim().length === 0) return '服务器地址不能为空';
  if (!isValidHttpUrl(form.baseUrl)) return '需以 http:// 或 https:// 开头，且为合法地址';
  return '';
});

const headersError = computed(() => {
  if (form.type !== 'site' || form.headersText.trim().length === 0) return '';
  const lines = form.headersText.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.includes(':')) return `请求头格式应为「名称: 值」，无法解析：${line.trim()}`;
  }
  return '';
});

const tokenError = computed(() => {
  if (form.type === 'jellyfin' && form.token.trim().length === 0) return 'API Key 不能为空';
  return '';
});

const isValid = computed(
  () => !nameError.value && !baseUrlError.value && !headersError.value && !tokenError.value,
);

const showNameError = computed(() => touched.name && nameError.value.length > 0);
const showUrlError = computed(() => touched.baseUrl && baseUrlError.value.length > 0);

/* ---------- 动态字段可见性 ---------- */
const showAuth = computed(() => form.type === 'alist' || form.type === 'webdav');
const showJellyfin = computed(() => form.type === 'jellyfin');
const showHeaders = computed(() => form.type === 'site');

const authOptions = computed(() => {
  const options = [
    { value: 'none', label: '无认证' },
    { value: 'basic', label: 'Basic' },
    { value: 'token', label: 'Token' },
  ];
  return options;
});

function setAuthMode(value: string): void {
  if (value === 'none' || value === 'basic' || value === 'token') form.authMode = value;
}

/* ---------- 提交 ---------- */
function buildInput(): SourceInput {
  const headers: Record<string, string> = {};
  for (const line of form.headersText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    name: form.name.trim(),
    type: form.type,
    baseUrl: normalizeBaseUrl(form.baseUrl),
    pathPrefix: form.pathPrefix.trim().length > 0 ? form.pathPrefix.trim() : null,
    auth: {
      mode: form.authMode,
      username: form.authMode === 'basic' ? form.username.trim() : null,
      password: form.authMode === 'basic' ? form.password : null,
      token: form.authMode === 'token' || form.type === 'jellyfin' ? form.token.trim() : null,
    },
    headers,
    ext: form.type === 'jellyfin' && form.userId.trim().length > 0 ? { userId: form.userId.trim() } : null,
  };
}

function onSubmit(): void {
  touched.name = true;
  touched.baseUrl = true;
  if (!isValid.value || props.saving) return;
  emit('submit', buildInput());
}

function onTest(): void {
  touched.name = true;
  touched.baseUrl = true;
  if (baseUrlError.value) return;
  emit('test', buildInput());
}
</script>

<template>
  <form class="source-form" novalidate @submit.prevent="onSubmit">
    <section class="source-form__section">
      <h2 class="source-form__section-title">源类型</h2>
      <div class="type-grid" role="radiogroup" aria-label="源类型">
        <button
          v-for="opt in TYPE_CARDS"
          :key="opt.value"
          class="type-card"
          :class="{ 'type-card--active': form.type === opt.value }"
          type="button"
          role="radio"
          :aria-checked="form.type === opt.value"
          @click="form.type = opt.value"
        >
          <span class="type-card__label">{{ opt.label }}</span>
          <span class="type-card__hint">{{ opt.hint }}</span>
        </button>
      </div>
    </section>

    <section class="source-form__section">
      <div class="field">
        <label class="field__label field__label--required" for="source-name">名称</label>
        <input
          id="source-name"
          v-model="form.name"
          class="field__input field__input--lg"
          :class="{ 'field__input--error': showNameError }"
          type="text"
          :maxlength="SOURCE_NAME_MAX_LENGTH"
          autocomplete="off"
          placeholder="如：家里 NAS"
          @blur="touched.name = true"
        />
        <p v-if="showNameError" class="field__error">{{ nameError }}</p>
        <p v-else class="field__hint">最多 {{ SOURCE_NAME_MAX_LENGTH }} 个字符</p>
      </div>

      <div class="field">
        <label class="field__label field__label--required" for="source-url">服务器地址</label>
        <input
          id="source-url"
          v-model="form.baseUrl"
          class="field__input field__input--lg"
          :class="{ 'field__input--error': showUrlError }"
          type="url"
          inputmode="url"
          autocomplete="off"
          :placeholder="form.type === 'site' ? 'https://example.com/api.php/provide/vod' : 'https://alist.example.com'"
          @blur="touched.baseUrl = true"
        />
        <p v-if="showUrlError" class="field__error">{{ baseUrlError }}</p>
        <p v-else class="field__hint">
          支持局域网 http 地址；保存时会自动归一化末尾斜杠（AC-05）。
        </p>
      </div>

      <div class="field">
        <label class="field__label" for="source-path">子路径（可选）</label>
        <input
          id="source-path"
          v-model="form.pathPrefix"
          class="field__input"
          type="text"
          autocomplete="off"
          placeholder="/movies"
        />
      </div>
    </section>

    <section v-if="showAuth" class="source-form__section">
      <h2 class="source-form__section-title">认证方式</h2>
      <SegmentedControl
        :model-value="form.authMode"
        :options="authOptions"
        label="认证方式"
        @update:model-value="setAuthMode"
      />
      <div v-if="form.authMode === 'basic'" class="source-form__row">
        <div class="field">
          <label class="field__label" for="source-user">用户名</label>
          <input
            id="source-user"
            v-model="form.username"
            class="field__input"
            type="text"
            autocomplete="username"
          />
        </div>
        <div class="field">
          <label class="field__label" for="source-pass">密码</label>
          <input
            id="source-pass"
            v-model="form.password"
            class="field__input"
            type="password"
            autocomplete="current-password"
          />
        </div>
      </div>
      <div v-if="form.authMode === 'token'" class="field">
        <label class="field__label" for="source-token">Token</label>
        <input id="source-token" v-model="form.token" class="field__input" type="password" autocomplete="off" />
      </div>
    </section>

    <section v-if="showJellyfin" class="source-form__section">
      <h2 class="source-form__section-title">Jellyfin</h2>
      <div class="field">
        <label class="field__label field__label--required" for="source-api-key">API Key</label>
        <input id="source-api-key" v-model="form.token" class="field__input" type="password" autocomplete="off" />
        <p v-if="tokenError" class="field__error">{{ tokenError }}</p>
      </div>
      <div class="field">
        <label class="field__label" for="source-user-id">用户 ID（可选）</label>
        <input id="source-user-id" v-model="form.userId" class="field__input" type="text" autocomplete="off" />
      </div>
    </section>

    <section v-if="showHeaders" class="source-form__section">
      <h2 class="source-form__section-title">请求头</h2>
      <div class="field">
        <label class="field__label" for="source-headers">自定义请求头（每行一条，格式「名称: 值」）</label>
        <textarea
          id="source-headers"
          v-model="form.headersText"
          class="field__input source-form__textarea"
          rows="3"
          placeholder="Referer: https://example.com&#10;User-Agent: Mozilla/5.0"
        />
        <p v-if="headersError" class="field__error">{{ headersError }}</p>
      </div>
    </section>

    <section class="source-form__section">
      <button
        class="btn btn--secondary btn--lg"
        type="button"
        :disabled="testing || !isValid"
        @click="onTest"
      >
        <LoadingSpinner v-if="testing" :size="16" />
        {{ testing ? '正在连接…' : '测试连接' }}
      </button>

      <p
        v-if="testResult"
        class="source-form__test-result"
        :class="testResult.ok ? 'source-form__test-result--ok' : 'source-form__test-result--fail'"
        role="status"
      >
        {{ testResult.message }}
      </p>
    </section>

    <div class="source-form__footer">
      <button class="btn btn--primary btn--lg" type="submit" :disabled="!isValid || saving">
        <LoadingSpinner v-if="saving" :size="16" />
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button class="btn btn--ghost btn--md" type="button" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>

<style scoped>
.source-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding-bottom: var(--space-8);
}

.source-form__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.source-form__section-title {
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
}

.source-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.source-form__textarea {
  min-height: 88px;
  resize: vertical;
  font-family: var(--font-family-number);
  font-size: var(--font-size-14);
  line-height: var(--line-height-14);
}

.type-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.type-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  min-height: 64px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: 1px solid var(--color-border);
  text-align: left;
  transition: var(--transition-color);
}

.type-card--active {
  background-color: var(--color-brand-soft);
  border-color: var(--color-brand);
}

.type-card__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.type-card--active .type-card__label {
  color: var(--color-brand-text);
}

.type-card__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.3;
}

.source-form__test-result {
  font: var(--text-label);
}

.source-form__test-result--ok {
  color: var(--color-success);
}

.source-form__test-result--fail {
  color: var(--color-danger);
}

.source-form__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) 0 calc(var(--space-3) + var(--safe-bottom));
  background-color: var(--color-bg-base);
}

@media (max-width: 360px) {
  .type-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
