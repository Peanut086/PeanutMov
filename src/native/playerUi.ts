/**
 * 播放器窗口 UI 插件代理（沉浸式全屏 + 系统亮度/音量原始读写）
 *
 * 横屏全屏时 Android 会为刘海/挖孔预留安全边（华为真机左侧 104px），
 * WebView 被内缩后露出的窗口背景就是那条白色竖条。进入全屏时切 edge-to-edge
 * 让内容铺满整块屏幕，退出时恢复系统栏与 Capacitor 的边距处理。
 *
 * 亮度/音量方法只搬运原生单位（背光 0~1、音量档位百分比），不做用户语义换算，
 * 也不决定失败后怎么降级——那部分在 `deviceService`（API-12）。
 */
import { registerPlugin } from '@capacitor/core';

import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';

export interface SystemLevelsRaw {
  /** 系统当前背光 0~1；-1 = 读不到 */
  brightnessRatio: number;
  /** 系统媒体音量 0~100；-1 = 读不到 */
  volumePercent: number;
}

interface PlayerUiPlugin {
  setImmersive(options: { immersive: boolean }): Promise<void>;
  getSystemLevels(): Promise<SystemLevelsRaw>;
  getSystemVolume(): Promise<{ volumePercent: number }>;
  setWindowBrightness(options: { ratio: number }): Promise<void>;
  clearWindowBrightness(): Promise<void>;
  setSystemVolume(options: { percent: number }): Promise<{ volumePercent: number }>;
}

const PlayerUi = registerPlugin<PlayerUiPlugin>('PlayerUi');

export async function setPlayerImmersive(immersive: boolean): Promise<void> {
  if (!isNative()) return;
  await PlayerUi.setImmersive({ immersive });
}

/** 进入播放页时一次性取系统亮度和音量；Web / 插件缺失返回 null */
export async function readRawSystemLevels(): Promise<SystemLevelsRaw | null> {
  if (!isNative()) return null;
  try {
    return await PlayerUi.getSystemLevels();
  } catch (e) {
    logger.debug('读取系统亮度/音量失败（降级为遮罩 + 播放器倍率）', e);
    return null;
  }
}

/** 只读系统媒体音量，用于手势按下前校准基准 */
export async function readRawSystemVolume(): Promise<number | null> {
  if (!isNative()) return null;
  try {
    const { volumePercent } = await PlayerUi.getSystemVolume();
    return Number.isFinite(volumePercent) && volumePercent >= 0 ? volumePercent : null;
  } catch (e) {
    logger.debug('读取系统音量失败', e);
    return null;
  }
}

/** 写本窗口背光（0~1）；返回是否真的写进去了 */
export async function writeWindowBrightness(ratio: number): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await PlayerUi.setWindowBrightness({ ratio });
    return true;
  } catch (e) {
    logger.debug('设置窗口亮度失败', e);
    return false;
  }
}

/** 交还系统背光（非原生时天然 no-op） */
export async function clearWindowBrightness(): Promise<void> {
  if (!isNative()) return;
  try {
    await PlayerUi.clearWindowBrightness();
  } catch (e) {
    logger.debug('交还系统亮度失败（忽略）', e);
  }
}

/** 写系统媒体音量，返回实际生效的百分比；null = 不可用 */
export async function writeSystemVolume(percent: number): Promise<number | null> {
  if (!isNative()) return null;
  try {
    const { volumePercent } = await PlayerUi.setSystemVolume({ percent });
    return Number.isFinite(volumePercent) && volumePercent >= 0 ? volumePercent : null;
  } catch (e) {
    logger.debug('设置系统音量失败', e);
    return null;
  }
}
