/**
 * 播放器窗口 UI 插件代理（沉浸式全屏）
 *
 * 横屏全屏时 Android 会为刘海/挖孔预留安全边（华为真机左侧 104px），
 * WebView 被内缩后露出的窗口背景就是那条白色竖条。进入全屏时切 edge-to-edge
 * 让内容铺满整块屏幕，退出时恢复系统栏与 Capacitor 的边距处理。
 */
import { registerPlugin } from '@capacitor/core';

import { isNative } from '@/shared/platform';

interface PlayerUiPlugin {
  setImmersive(options: { immersive: boolean }): Promise<void>;
}

const PlayerUi = registerPlugin<PlayerUiPlugin>('PlayerUi');

export async function setPlayerImmersive(immersive: boolean): Promise<void> {
  if (!isNative()) return;
  await PlayerUi.setImmersive({ immersive });
}
