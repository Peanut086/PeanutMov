/**
 * 弹幕服务门面（v1.7 / CHG-22）
 *
 * `danmakuService.match(title, year, episode, localXml)`：
 *   缓存命中 → 直接返回（离线可用）
 *   未命中   → aggregate（无凭据主力）→ dandanplay（凭据就绪后自动生效）→ local-xml
 *
 * 结果（含偏移）写 `danmakuCache`；总开关关闭时调用方不得调用本服务（零第三方请求，AC-126）。
 */
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { aggregateProvider, dandanplayProvider, localXmlProvider, type DanmakuQuery } from '@/services/danmaku/provider';
import { normalizeTitleForMatch, stripTitleNoise } from '@/sources/douban/playMatch';
import { logger } from '@/shared/logger';
import type { DanmakuComment, DanmakuMatch } from '@/types';

/** 匹配阈值：归一化片名相等才采用（宁缺毋滥，串片比没弹幕更糟） */
function isTitleMatched(queryTitle: string, matchedTitle: string | null): boolean {
  if (matchedTitle === null) return true; // Provider 未回传匹配题名时不做二次校验
  const a = stripTitleNoise(queryTitle);
  const b = stripTitleNoise(matchedTitle);
  if (a.length === 0 || b.length === 0) return normalizeTitleForMatch(queryTitle) === normalizeTitleForMatch(matchedTitle);
  return a === b;
}

export const danmakuService = {
  /**
   * 匹配一集的弹幕。三级回退；全部失败或都不匹配返回 null。
   * `localXml` 传入本地 xml 内容读取函数（有值时优先级最低，兜底离线）。
   */
  async match(title: string, year: number | null, episode: number, localXml: (() => string | null) | null = null): Promise<DanmakuMatch | null> {
    const query: DanmakuQuery = { title, year, episode };

    // ① 缓存
    const cacheKey = `${normalizeTitleForMatch(title)}:${year ?? 'na'}:${episode}`;
    const cached = await cacheRepo.getDanmaku(cacheKey);
    if (cached) return cached;

    // ② 网络源按序回退（远端题名与查询片名归一化相等才采用，防串片）
    const providers = [aggregateProvider, dandanplayProvider];
    for (const provider of providers) {
      if (!provider.available()) continue;
      try {
        const result = await provider.match(query);
        if (result !== null && isTitleMatched(title, result.matchedTitle)) {
          const match: DanmakuMatch = {
            provider: provider.id,
            matchedTitle: result.matchedTitle,
            offsetSec: 0,
            comments: result.comments,
          };
          await cacheRepo.putDanmaku(cacheKey, match);
          return match;
        }
      } catch (e) {
        logger.debug(`弹幕源 ${provider.id} 匹配失败，回退下一级`, e);
      }
    }

    // ③ 本地 xml 兜底
    const xml = localXml?.() ?? null;
    if (xml) {
      const comments = localXmlProvider.parse(xml);
      if (comments !== null) {
        const match: DanmakuMatch = { provider: 'local-xml', matchedTitle: title, offsetSec: 0, comments };
        await cacheRepo.putDanmaku(cacheKey, match);
        return match;
      }
    }
    return null;
  },

  /** 弹幕去重（设置 merge 开启时由渲染层调用）：同文本且与上一条保留项相差 ≤1s 时合并 */
  dedupe(comments: DanmakuComment[]): DanmakuComment[] {
    const sorted = [...comments].sort((a, b) => a.time - b.time);
    const kept: DanmakuComment[] = [];
    const lastByText = new Map<string, DanmakuComment>();
    for (const comment of sorted) {
      const last = lastByText.get(comment.text);
      if (last !== undefined && comment.time - last.time <= 1) continue;
      kept.push(comment);
      lastByText.set(comment.text, comment);
    }
    return kept;
  },

  /**
   * 功能扩展-3：预取弹幕（下载完成时调用，确保离线可用）
   *
   * 与 match 相同逻辑，但静默失败（不影响下载流程）。
   * 成功时弹幕已写入 cacheRepo，离线播放可直接命中。
   */
  async prefetch(title: string, year: number | null, episode: number): Promise<void> {
    try {
      await this.match(title, year, episode);
    } catch (e) {
      logger.debug('弹幕预取失败（静默）', { title, year, episode }, e);
    }
  },
};
