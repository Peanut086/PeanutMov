/**
 * 弹幕服务门面（v1.7 / CHG-22）
 *
 * `danmakuService.match(title, year, episode, localXml, scene)`：
 *   缓存命中 → 直接返回（离线可用）
 *   未命中   → 按「版权覆盖 + 接口稳定性」串行回退（见 `./danmaku/provider` 文件头），
 *              最后落到两个需配置的聚合源（danmu-api 需基址 / dandanplay 需凭据）与 local-xml
 *   `scene`：`playback`（默认，实时播放）/ `prefetch`（下载完成时的离线预取，补量扇出关闭）
 *
 * 结果（含偏移）写 `danmakuCache`；总开关关闭时调用方不得调用本服务（零第三方请求，AC-126）。
 */
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { bilibiliProvider } from '@/services/danmaku/bilibili';
import { tencentProvider } from '@/services/danmaku/tencent';
import { mgtvProvider } from '@/services/danmaku/mgtv';
import { iqiyiProvider } from '@/services/danmaku/iqiyi';
import { youkuProvider } from '@/services/danmaku/youku';
import { leshiProvider } from '@/services/danmaku/leshi';
import { danmuApiProvider, dandanplayProvider, localXmlProvider, type DanmakuQuery, type DanmakuQueryScene } from '@/services/danmaku/provider';
import { normalizeTitleForMatch, seasonOfTitle, stripTitleNoise } from '@/sources/douban/playMatch';
import { decodeSubtitle } from '@/player/SrtConverter';
import { logger } from '@/shared/logger';
import { DANMAKU_MAX_PER_EPISODE, DANMAKU_MIN_COMMENTS } from '@/shared/constants';
import type { DanmakuComment, DanmakuMatch } from '@/types';

/**
 * 匹配阈值：归一化片名相等才采用（宁缺毋滥，串片比没弹幕更糟）。
 *
 * 除片名主体外还要校验季号——`stripTitleNoise` 会把「第N季/第N部」整段剥掉，
 * 光靠它分不开「士兵突击」与「士兵突击 第2季」（后者是 2013 年的同名纪实节目，
 * 与 2006 年的电视剧毫无关系）。查询片名不带季号、命中片名却带了第 2 季及以上，判为不匹配；
 * 「第1季」是平台给单季剧的常见写法，与不带季号同义，不拦。
 */
function isTitleMatched(queryTitle: string, matchedTitle: string | null): boolean {
  if (matchedTitle === null) return true; // Provider 未回传匹配题名时不做二次校验
  const a = stripTitleNoise(queryTitle);
  const b = stripTitleNoise(matchedTitle);
  const sameTitle =
    a.length === 0 || b.length === 0
      ? normalizeTitleForMatch(queryTitle) === normalizeTitleForMatch(matchedTitle)
      : a === b;
  if (!sameTitle) return false;
  if (seasonOfTitle(queryTitle) !== null) return true; // 查询自带季号，一致性已由查询侧表达
  const matchedSeason = seasonOfTitle(matchedTitle);
  return matchedSeason === null || matchedSeason <= 1;
}

/**
 * 单集超过上限时按时间均匀抽稀：保留整集密度分布，避免缓存/预取膨胀。
 * 腾讯源一集可达 5 万条，而同屏上限只有几十条，抽稀对观感几乎无影响。
 */
export function thinComments(comments: DanmakuComment[]): DanmakuComment[] {
  if (comments.length <= DANMAKU_MAX_PER_EPISODE) return comments;
  const sorted = [...comments].sort((a, b) => a.time - b.time);
  const step = sorted.length / DANMAKU_MAX_PER_EPISODE;
  const out: DanmakuComment[] = [];
  for (let i = 0; i < DANMAKU_MAX_PER_EPISODE; i += 1) {
    const picked = sorted[Math.floor(i * step)];
    if (picked !== undefined) out.push(picked);
  }
  return out;
}

/** 一集弹幕的缓存主键：归一化片名 + 年份 + 集号 */
function danmakuCacheKey(title: string, year: number | null, episode: number): string {
  return `${normalizeTitleForMatch(title)}:${year ?? 'na'}:${episode}`;
}

export const danmakuService = {
  /**
   * 匹配一集的弹幕。三级回退；全部失败或都不匹配返回 null。
   * `localXml` 传入本地 xml 内容读取函数（有值时优先级最低，兜底离线）。
   * `scene` 缺省 `playback`；预取路径必须显式传 `prefetch`，见 `DanmakuQuery.scene`。
   */
  async match(
    title: string,
    year: number | null,
    episode: number,
    localXml: (() => string | null) | null = null,
    scene: DanmakuQueryScene = 'playback',
  ): Promise<DanmakuMatch | null> {
    const query: DanmakuQuery = { title, year, episode, scene };

    // ① 缓存
    const cacheKey = danmakuCacheKey(title, year, episode);
    const cached = await cacheRepo.getDanmaku(cacheKey);
    if (cached) return cached;

    // ② 网络源按序回退（远端题名与查询片名归一化相等才采用，防串片）
    const providers = [
      bilibiliProvider,
      tencentProvider,
      mgtvProvider,
      iqiyiProvider,
      youkuProvider,
      leshiProvider,
      danmuApiProvider,
      dandanplayProvider,
    ];
    for (const provider of providers) {
      if (!provider.available()) continue;
      try {
        const result = await provider.match(query);
        if (result === null) continue;
        if (!isTitleMatched(title, result.matchedTitle)) {
          // 源自己按片名搜到了东西，但题名过不了校验：这类命中正是串片的形态，必须留下痕迹
          logger.info(`弹幕源 ${provider.id} 题名不符（命中「${result.matchedTitle}」），回退下一级`);
          continue;
        }
        if (result.comments.length < DANMAKU_MIN_COMMENTS) {
          // 整集只有零星几条通常是废弃条目/花絮残留，当作未命中继续回退
          logger.debug(`弹幕源 ${provider.id} 仅 ${result.comments.length} 条，低于命中门槛，回退下一级`);
          continue;
        }
        const match: DanmakuMatch = {
          provider: provider.id,
          matchedTitle: result.matchedTitle,
          // 偏移随源保存，渲染时再叠加（缓存里存原始时间，换源/重进不必回写缓存）
          offsetSec: result.offsetSec ?? 0,
          comments: thinComments(result.comments),
        };
        await cacheRepo.putDanmaku(cacheKey, match);
        // 命中留痕：事后只能从画面内容反推「弹幕对不上」，有源 + 题名 + 偏移 + 条数才查得动
        logger.info('弹幕命中', {
          provider: provider.id,
          matchedTitle: match.matchedTitle,
          episode,
          count: match.comments.length,
          offsetSec: match.offsetSec,
        });
        return match;
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
   * 导入本地 xml 并写进本集缓存（播放页「弹幕设置 → 导入本地弹幕 XML」）。
   *
   * 是写缓存而不是把内容交给 `match` 的兜底分支：网络源命中时 `match` 根本走不到 ③，
   * 手动导入必须能盖过它，否则这个入口点了没反应。返回解析出的条数（0 = 文件无效）。
   */
  async importLocalXml(title: string, year: number | null, episode: number, file: File): Promise<number> {
    // 社区弹幕文件 UTF-8 与 GBK 都有，复用字幕那条编码嗅探链（严格 UTF-8 → GBK → 宽容兜底）
    const comments = localXmlProvider.parse(decodeSubtitle(await file.arrayBuffer()));
    if (comments === null) return 0;
    const thinned = thinComments(comments);
    await cacheRepo.putDanmaku(danmakuCacheKey(title, year, episode), {
      provider: 'local-xml',
      matchedTitle: title,
      offsetSec: 0,
      comments: thinned,
    });
    return thinned.length;
  },

  /**
   * 功能扩展-3：预取弹幕（下载完成时调用，确保离线可用）
   *
   * 与 match 相同逻辑，但静默失败（不影响下载流程），并以 `prefetch` 场景调用：
   * 补量型扇出（B 站分片）在此关闭，预取只要「离线有弹幕」，不承担批量请求的风控代价。
   * 成功时弹幕已写入 cacheRepo，离线播放可直接命中。
   */
  async prefetch(title: string, year: number | null, episode: number): Promise<void> {
    try {
      await this.match(title, year, episode, null, 'prefetch');
    } catch (e) {
      logger.debug('弹幕预取失败（静默）', { title, year, episode }, e);
    }
  },
};
