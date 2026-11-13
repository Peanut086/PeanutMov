/**
 * 网盘配置传递工具（P4-3）
 *
 * 两条下发通道，都不保证被消费：
 * 1. `netdisk_config.json`（写进 /sdcard/TVBox，沿用 TVBox 共享目录约定）——
 *    只有主动去读该文件的爬虫才会用到；本工程自身不读。
 * 2. 合并进爬虫源 ext 的 JSON（`quality` / `thread`）——由爬虫自行决定是否采纳。
 *
 * App 不代解网盘直链（网盘平台能力分级 Q-03：夸克 full-api 仅用于账号/会员校验），
 * 因此这两项本质是「尽力而为的配置提示」，设置页已按此口径说明。
 */
import { useSettingsStore } from '@/stores/settingsStore';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { requiresNetdiskCookie } from '@/services/netdiskPlatforms';
import { writeCookieFile, readCookieFile } from '@/native/netdiskPlugin';
import { logger } from '@/shared/logger';

export interface NetdiskConfig {
  quality: 'auto' | '4K' | '1080P' | '720P' | '480P';
  threadCount: number;
}

const CONFIG_PLATFORM = '__netdisk_config__';

/**
 * 获取当前网盘配置
 */
export function getNetdiskConfig(): NetdiskConfig {
  const settings = useSettingsStore();
  return settings.netdisk;
}

/**
 * 将网盘配置写入配置文件
 * 爬虫源启动时读取此文件获取画质/线程设置
 */
export async function writeNetdiskConfig(): Promise<boolean> {
  try {
    const config = getNetdiskConfig();
    const content = JSON.stringify(config, null, 2);
    await writeCookieFile(CONFIG_PLATFORM, content);
    logger.debug('网盘配置已写入', config);
    return true;
  } catch (e) {
    logger.error('写入网盘配置失败', e);
    return false;
  }
}

/**
 * 读取网盘配置文件
 */
export async function readNetdiskConfig(): Promise<NetdiskConfig | null> {
  try {
    const result = await readCookieFile(CONFIG_PLATFORM);
    if (!result.exists || !result.content) {
      return null;
    }
    const config = JSON.parse(result.content) as NetdiskConfig;
    return config;
  } catch (e) {
    logger.error('读取网盘配置失败', e);
    return null;
  }
}

/**
 * 格式化配置为爬虫源可消费的字符串
 * 用于传递给 Spider.init(context, ext) 的 ext 参数
 */
export function formatConfigForSpider(config: NetdiskConfig): string {
  return JSON.stringify({
    quality: config.quality,
    thread: config.threadCount,
  });
}

/**
 * F8：是否已启用「需要网盘 Cookie」的爬虫源。
 *
 * 这是唯一不依赖存储权限的判据：`MANAGE_EXTERNAL_STORAGE` 未授予时 cookie 文件根本读不到，
 * 以「读到 cookie」为前提的提醒在最需要它的场景里必然沉默。查库不涉及外部存储，因此永远可用。
 * 读取失败按 false 处理——宁可不提醒，也不要在启动期弹无关 Toast。
 */
export async function hasEnabledNetdiskSource(): Promise<boolean> {
  try {
    const sources = await sourceRepo.listEnabled();
    return sources.some((source) => source.type === 'spider' && requiresNetdiskCookie(source));
  } catch {
    return false;
  }
}
