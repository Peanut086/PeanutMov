<script setup lang="ts">
/**
 * 播放面板抽屉（设计稿 ⑤'）：选集 / 线路 / 音画 / 更多收进同一个面板。
 *
 * - 横屏·桌面＝右侧非模态栏：画面让位，可边看边选，遮罩不生效；
 * - 竖屏＝底部弹层：遮罩生效并可点关闭。两种形态由容器查询选，组件不接方向标志。
 * - 四个页签的内容由父级用具名插槽传入：这里只管容器、页签与关闭路径。
 */
import { nextTick, ref, watch } from "vue";
import IconClose from "@/components/icons/IconClose.vue";
import type { DrawerTab } from "@/player/types";

const props = defineProps<{ open: boolean; tab: DrawerTab }>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:tab": [value: DrawerTab];
}>();

const TABS: readonly { key: DrawerTab; label: string }[] = [
  { key: "ep", label: "选集" },
  { key: "line", label: "线路" },
  { key: "av", label: "音画" },
  { key: "more", label: "更多" },
];

const closeBtn = ref<HTMLElement | null>(null);
/** 打开前的焦点：关闭后交还给触发者，键盘用户不必从头 Tab */
let returnFocus: HTMLElement | null = null;

watch(
  () => props.open,
  (open) => {
    if (open) {
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement ? active : null;
      void nextTick(() => closeBtn.value?.focus({ preventScroll: true }));
    } else {
      returnFocus?.focus({ preventScroll: true });
      returnFocus = null;
    }
  },
);
</script>

<template>
  <!-- 遮罩：竖屏（弹层形态）才吃点击，横屏非模态时放行画面手势 -->
  <div class="pl-scrim" @click="emit('update:open', false)"></div>

  <aside
    class="pl-drawer"
    role="dialog"
    aria-modal="false"
    aria-label="播放面板"
    :data-tab="tab"
    :inert="open ? undefined : true"
  >
    <header class="pl-drawer__head">
      <div class="pl-tabs" role="tablist" aria-label="面板页签">
        <button
          v-for="item in TABS"
          :id="`pl-tab-${item.key}`"
          :key="item.key"
          class="pl-tab"
          type="button"
          role="tab"
          :aria-selected="tab === item.key"
          :aria-controls="`pl-pane-${item.key}`"
          @click="emit('update:tab', item.key)"
        >
          {{ item.label }}
        </button>
      </div>
      <button
        ref="closeBtn"
        class="pl-ico"
        type="button"
        aria-label="关闭面板"
        @click="emit('update:open', false)"
      >
        <IconClose :size="22" />
      </button>
    </header>

    <div class="pl-drawer__body">
      <section
        id="pl-pane-ep"
        class="pl-pane"
        data-pane="ep"
        role="tabpanel"
        aria-labelledby="pl-tab-ep"
      >
        <slot name="ep" />
      </section>
      <section
        id="pl-pane-line"
        class="pl-pane"
        data-pane="line"
        role="tabpanel"
        aria-labelledby="pl-tab-line"
      >
        <slot name="line" />
      </section>
      <section
        id="pl-pane-av"
        class="pl-pane"
        data-pane="av"
        role="tabpanel"
        aria-labelledby="pl-tab-av"
      >
        <slot name="av" />
      </section>
      <section
        id="pl-pane-more"
        class="pl-pane"
        data-pane="more"
        role="tabpanel"
        aria-labelledby="pl-tab-more"
      >
        <slot name="more" />
      </section>
    </div>
  </aside>
</template>
