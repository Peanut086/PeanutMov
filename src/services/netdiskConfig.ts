/**
 * 网盘配置传递工具（P4-3）
 *
 * 将 App 的网盘画质/线程配置传递给爬虫源。
 * 配置写入 /sdcard/TVBox/netdisk_config.json，爬虫源启动时读取。
 */
import { useSettingsStore } from '@/stores/settingsStore';
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
