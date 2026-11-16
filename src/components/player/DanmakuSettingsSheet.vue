<script setup lang="ts">
/**
 * 弹幕设置面板（v1.7 / CHG-22）
 *
 * 设置项：开关 / 字号 / 透明度 / 速度 / 显示区域 / 合并程度 / 底部安全区，
 * 外加自建聚合服务基址、弹弹play凭据配置与（播放页调用时）本地弹幕 XML 导入。
 * 写回 `settingsStore.update({ danmaku })`；关闭开关后渲染层即时清空。
 */
import { computed, ref, watch } from 'vue';

import BottomSheet from '@/components/common/BottomSheet.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import {
  getDandanplayCredentials,
  getDanmuApiBaseUrl,
  normalizeDanmuApiBaseUrl,
  setDandanplayCredentials,
  setDanmuApiBaseUrl,
} from '@/services/danmaku/provider';
import { useSettingsStore } from '@/stores/settingsStore';
import type { DanmakuSettings } from '@/types';

/** `importXml` 由播放页传入（有当前这一集才有意义）；设置页里不传即不渲染导入入口 */
const props = defineProps<{ open: boolean; importXml?: ((file: File) => void | Promise<void>) | null }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const settings = useSettingsStore();

const danmaku = computed<DanmakuSettings>(
  () =>
    settings.settings?.danmaku ?? {
      enabled: false,
      fontSize: 16,
      opacity: 0.8,
      speed: 1,
      areaPercent: 50,
      merge: true,
      safeBottomPercent: 15,
      bold: false,
      strokeStyle: 'shadow',
      density: 'normal',
      filterTop: false,
      filterBottom: false,
      interactive: true,
    },
);

function patch(part: Partial<DanmakuSettings>): void {
  settings.updateNonBlocking({ danmaku: { ...danmaku.value, ...part } });
}

/* ---------- 弹弹play开放弹幕网络凭据（localStorage，不进备份） ---------- */

const ddp = ref(getDandanplayCredentials() ?? { appId: '', secret: '' });
const ddpSaved = ref(false);

function saveDandanplay(): void {
  setDandanplayCredentials(ddp.value.appId, ddp.value.secret);
  // 任一项留空会被清掉，回显跟真实状态对齐，免得显示成「已配置」
  ddp.value = getDandanplayCredentials() ?? { appId: '', secret: '' };
  ddpSaved.value = true;
}

/* ---------- danmu_api 自建聚合服务基址（localStorage，不进备份） ---------- */

const danmuApiBase = ref(getDanmuApiBaseUrl() ?? '');
const danmuApiSaved = ref(false);
const danmuApiInvalid = ref(false);

// 改过内容就收起红描边：无效提示只对「上一次保存尝试」有意义，否则改对了边框还挂着
watch(danmuApiBase, () => {
  danmuApiInvalid.value = false;
});

function saveDanmuApiBase(): void {
  // 先校验再落库：填错只提示，不能让一次手滑把原本可用的源清掉
  if (normalizeDanmuApiBaseUrl(danmuApiBase.value) === null && danmuApiBase.value.trim().length > 0) {
    danmuApiInvalid.value = true;
    danmuApiSaved.value = false;
    return;
  }
  danmuApiInvalid.value = false;
  // 回显归一化结果：末尾斜杠与 `/api/v2` 尾巴会被摘掉，显示成用户填的样子反而误导
  danmuApiBase.value = setDanmuApiBaseUrl(danmuApiBase.value) ?? '';
  danmuApiSaved.value = true;
}

/* ---------- 本地弹幕 XML（B 站格式，只作用于当前这一集） ---------- */

const xmlInput = ref<HTMLInputElement | null>(null);

/** 与外挂字幕同一套交互：按钮唤起隐藏的 file input，读取与解析交回播放页 */
function openXmlPicker(): void {
  xmlInput.value?.click();
}

function onPickXml(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  // 清空 value：第二次导入同一个文件也要触发 change
  input.value = '';
  if (file !== null) void props.importXml?.(file);
}
</script>

<template>
  <BottomSheet :model-value="props.open" title="弹幕设置" @update:model-value="emit('update:open', $event)">
    <div class="danmaku-sheet">
      <div class="danmaku-sheet__row">
        <span>开启弹幕（只读展示，不发送）</span>
        <ToggleSwitch :model-value="danmaku.enabled" @update:model-value="patch({ enabled: $event })" />
      </div>

      <label class="danmaku-sheet__field">
        <span>字号 {{ danmaku.fontSize }}px</span>
        <input
          type="range"
          min="10"
          max="36"
          step="1"
          :value="danmaku.fontSize"
          @change="patch({ fontSize: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>不透明度 {{ Math.round(danmaku.opacity * 100) }}%</span>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.1"
          :value="danmaku.opacity"
          @change="patch({ opacity: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>速度 {{ danmaku.speed.toFixed(1) }}x（越大越慢）</span>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.5"
          :value="danmaku.speed"
          @change="patch({ speed: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>显示区域 {{ danmaku.areaPercent }}%</span>
        <input
          type="range"
          min="10"
          max="100"
          step="5"
          :value="danmaku.areaPercent"
          @change="patch({ areaPercent: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>底部安全区 {{ danmaku.safeBottomPercent }}%（避让字幕）</span>
        <input
          type="range"
          min="0"
          max="50"
          step="5"
          :value="danmaku.safeBottomPercent"
          @change="patch({ safeBottomPercent: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <div class="danmaku-sheet__row">
        <span>合并重复弹幕</span>
        <ToggleSwitch :model-value="danmaku.merge" @update:model-value="patch({ merge: $event })" />
      </div>

      <div v-if="props.importXml" class="danmaku-sheet__field">
        <button type="button" class="btn btn--secondary btn--sm" @click="openXmlPicker()">
          导入本地弹幕 XML（当前这一集）
        </button>
        <input
          ref="xmlInput"
          class="danmaku-sheet__file"
          type="file"
          accept=".xml,text/xml,application/xml"
          @change="onPickXml"
        />
      </div>

      <div class="danmaku-sheet__field">
        <label class="field__label" for="danmaku-danmuapi-base">自建弹幕聚合服务地址（可选，danmu_api / LogVar 弹幕 API）</label>
        <input
          id="danmaku-danmuapi-base"
          v-model="danmuApiBase"
          class="field__input"
          :class="{ 'field__input--error': danmuApiInvalid }"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="http://192.168.1.7:9321 或 https://你的域名/你的TOKEN"
          @keyup.enter="saveDanmuApiBase"
        />
        <button type="button" class="btn btn--secondary btn--sm" @click="saveDanmuApiBase">保存地址</button>
        <p v-if="danmuApiInvalid" class="field__error" role="alert">
          地址无效：需以 http:// 或 https:// 开头，且不含账号密码。未保存，原地址仍可用。
        </p>
        <p v-else-if="danmuApiSaved" class="field__hint">已保存；清空后不再向该服务请求弹幕。</p>
      </div>

      <div class="danmaku-sheet__field">
        <label class="field__label" for="danmaku-ddp-appid">弹弹play AppId（可选，配置后启用该弹幕源）</label>
        <input
          id="danmaku-ddp-appid"
          v-model="ddp.appId"
          class="field__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="在 dev.dandanplay.com 申请"
        />
        <label class="field__label" for="danmaku-ddp-secret">弹弹play AppSecret</label>
        <input
          id="danmaku-ddp-secret"
          v-model="ddp.secret"
          class="field__input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="两项都填写才会生效"
        />
        <button type="button" class="btn btn--secondary btn--sm" @click="saveDandanplay">保存凭据</button>
        <p v-if="ddpSaved" class="field__hint">已保存；清空任一项即停用该源。</p>
      </div>

      <p class="field__hint">
        弹幕由第三方弹幕库按「片名 + 年份 + 集号」自动匹配；关闭开关后不会发起任何弹幕请求。
        部分弹幕数据来自「弹弹play开放弹幕网络」（www.dandanplay.com）；填写上方地址后，还会向你自己部署的
        LogVar 弹幕 API（danmu_api）请求聚合弹幕——该请求只带片名、年份与集号。
      </p>
    </div>
  </BottomSheet>
</template>

<style scoped>
.danmaku-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
}

.danmaku-sheet__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  font: var(--text-body);
  color: var(--color-text-primary);
}

.danmaku-sheet__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

/* 隐藏的 input 仍能被按钮 click() 唤起系统选择器，不必为了可见性牺牲面板布局 */
.danmaku-sheet__file {
  display: none;
}
</style>
