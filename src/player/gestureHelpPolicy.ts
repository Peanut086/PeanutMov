/**
 * 手势帮助浮层的自动出现策略（长按触发专用，OPT-10 的补丁）
 *
 * 规则：同一会话内自动弹出最多 1 次，随后进入冷却期；冷却期外的新会话可再看 1 次。
 * 设置页「手势说明」与播放页「更多 → 手势说明」是用户主动行为，不受这里约束。
 *
 * localStorage 不可用（隐私模式 / 配额满）时退化为"仅会话内去重"：
 * 宁可多弹一次，也不让策略读失败把帮助彻底关掉。
 */

const STORAGE_KEY = 'player-gesture-help-at';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

let shownThisSession = false;

function readLastShownAt(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 现在是否允许因「长按」自动弹出帮助浮层。 */
export function canShowGestureHelp(now = Date.now()): boolean {
  if (shownThisSession) return false;
  const last = readLastShownAt();
  return last === null || now - last >= COOLDOWN_MS;
}

/** 记一次自动弹出：立即置会话标记，避免同一次会话里反复触发。 */
export function markGestureHelpShown(now = Date.now()): void {
  shownThisSession = true;
  try {
    localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    // 写不进去只剩会话内去重，不影响功能
  }
}

/** 测试辅助：复位会话内标记（不动持久化值）。 */
export function resetGestureHelpSession(): void {
  shownThisSession = false;
}
