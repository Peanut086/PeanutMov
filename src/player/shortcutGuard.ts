/**
 * 播放页键盘快捷键的目标过滤（REV-18）
 *
 * 独立成模块而非写在 `PlayerView` 里，一是可被单测直接覆盖，
 * 二是把"哪些区域该让出键盘"这条规则与 Vue 组件生命周期解耦。
 */

/** 播放快捷键应当忽略的目标选择器：弹层、文本输入、可编辑区 */
const SHORTCUT_IGNORED_SELECTOR = '[role="dialog"], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** 模态弹层选择器：打开时无论焦点在哪都让出键盘（REV-18 残项） */
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

/**
 * 焦点落在输入区或弹层内时应让出键盘控制。
 *
 * 典型冲突：抽屉（`BottomSheet` → `role="dialog"`）打开时焦点在其内部按钮上，
 * 若仍按空格，会同时触发"播放/暂停"与"激活按钮"两个动作。
 * 残项修复：焦点仍在 body（弹层未捕获焦点）时，靠"页面里存在打开的模态弹层"兜底——
 * 项目内的模态弹层（BottomSheet/ConfirmDialog 等）都是 v-if 渲染，不在 DOM 即已关闭。
 *
 * @returns `true` = 本次按键不应被播放快捷键消费
 */
export function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(SHORTCUT_IGNORED_SELECTOR) !== null) return true;
  if (target instanceof Node && !target.isConnected) return false;
  return document.querySelector(MODAL_DIALOG_SELECTOR) !== null;
}
