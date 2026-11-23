/**
 * 弹幕服务门面（v1.7 / CHG-22）
 *
 * `danmakuService.match(title, year, episode, localXml, scene)` 交回 `DanmakuMatchResult`
 * （命中内容 + 命中路径 + 未命中主因 + 逐源结局），而不是一路折叠到 `null`：
 *   缓存命中 → 直接返回（离线可用）
 *   未命中   → 实时播放时先并行发起覆盖面最广的四个内置直连源（整组 12 秒预算），
 *              先给出可用结果的胜出；其余源按「版权覆盖 + 接口稳定性」原序串行兜底
 *              （见 `./danmaku/provider` 文件头）；预取保持串行，最后落到两个需配置的聚合源
 *              （danmu-api 需基址 / dandanplay 需凭据）与 local-xml
 *   `scene`：`playback`（默认，实时播放）/ `prefetch`（下载完成时的离线预取，补量扇出关闭）
 *
 * 每个分支都留一行生产可见日志（命中 info、未命中 warn、缓存命中 info）。
 * 结果（含偏移）写 `danmakuCache`；总开关关闭时调用方不得调用本服务（零第三方请求，AC-126）。
 */
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { bilibiliProvider } from '@/services/danmaku/bilibili';
import { tencentProvider } from '@/services/danmaku/tencent';
import { mgtvProvider } from '@/services/danmaku/mgtv';
import { iqiyiProvider } from '@/services/danmaku/iqiyi';
import { youkuProvider } from '@/services/danmaku/youku';
import { leshiProvider } from '@/services/danmaku/leshi';
import { danmuApiProvider, dandanplayProvider, localXmlProvider, type DanmakuProvider, type DanmakuQuery, type DanmakuQueryScene } from '@/services/danmaku/provider';
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

/**
 * 单个源的结局。
 *
 * OPT-26（P0-①-1）：`match` 以前只交回 `DanmakuMatch | null`，于是"弹幕没出来"这件事
 * 有六种截然不同的原因（源都没配 / 源说没有 / 串片被拦 / 条数太少 / 请求失败 / 本地文件无效）
 * 却被折叠成同一个 null——界面无法提示，日志里也只有一行"题名不符"（且默认级别看不见）。
 * 这套结局词同时供日志、界面提示和「诊断链导出」使用，不许再出现第二套措辞。
 */
export type DanmakuAttemptOutcome =
  | 'hit'
  | 'no_result'
  | 'title_mismatch'
  | 'below_threshold'
  | 'failed'
  | 'timeout'
  | 'unavailable';

export interface DanmakuAttempt {
  provider: string;
  outcome: DanmakuAttemptOutcome;
  /** 源回传的题名：串片要能指名道姓 */
  matchedTitle?: string | null;
  /** 源给出的条数（有结果才有） */
  count?: number;
  /** 失败原因（`outcome === 'failed'`） */
  error?: string;
}

/**
 * 未命中的主因。多个结局并存时按「用户下一步最不同」取主因：
 * `title_mismatch`（拦下了疑似串片）> `below_threshold`（有但太少）>
 * `no_result`（源正常应答但没有这条剧）> `timeout`（有源在预算内没答完）>
 * `failed`（一个源都没答上来）> `all_unavailable`（本机没有任何弹幕源可用：未配置或被设置关掉）。
 * 全部细节留在 `attempts` 里，主因只决定提示语。
 */
export type DanmakuMissReason =
  | 'title_mismatch'
  | 'below_threshold'
  | 'no_result'
  | 'timeout'
  | 'failed'
  | 'all_unavailable';

export interface DanmakuMatchResult {
  /** 命中的弹幕；未命中为 null */
  match: DanmakuMatch | null;
  /** 命中路径；未命中为 null */
  via: 'cache' | 'provider' | 'local-xml' | null;
  /** 未命中主因；命中为 null */
  missReason: DanmakuMissReason | null;
  /** 逐源结局（含被跳过的源），供日志与诊断导出 */
  attempts: DanmakuAttempt[];
}

/** 失败原因收敛成一句话（进 `attempts` 和未命中日志；堆栈只在 debug 里，不进提示语） */
function failureText(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

/**
 * 主因 → 界面提示。提示语和主因词表放在一起（`openSettings` = 这一步用户能在弹幕设置里做点什么），
 * 播放页只负责念，不再自己拼第二套。
 */
export const DANMAKU_MISS_GUIDANCE: Record<DanmakuMissReason, { text: string; openSettings: boolean }> = {
  all_unavailable: { text: '本机还没有可用的弹幕源', openSettings: true },
  failed: { text: '弹幕源都没有响应，稍后可以重试', openSettings: true },
  title_mismatch: { text: '疑似串片（同名剧/别的季），已拦下', openSettings: true },
  below_threshold: {
    text: `这条剧的弹幕不足 ${DANMAKU_MIN_COMMENTS} 条，已按门槛拦下`,
    openSettings: false,
  },
  no_result: { text: '各弹幕源都没有这部剧的弹幕', openSettings: true },
  timeout: { text: '弹幕源响应超时（网络慢或被源侧限流），稍后可以重试', openSettings: true },
};

/** 主因 → 顶栏弹幕那一格的短读数（提示语是整句，读数只放两三个字；口径与上表同源） */
export const DANMAKU_CHIP_MISS: Record<DanmakuMissReason, string> = {
  title_mismatch: '串片',
  below_threshold: '太少',
  no_result: '未找到',
  timeout: '超时',
  failed: '无响应',
  all_unavailable: '没源',
};

/** 由逐源结局取主因（口径见 `DanmakuMissReason`） */
function missReasonOf(attempts: DanmakuAttempt[]): DanmakuMissReason {
  const outcomes = new Set(attempts.map((attempt) => attempt.outcome));
  if (outcomes.has('title_mismatch')) return 'title_mismatch';
  if (outcomes.has('below_threshold')) return 'below_threshold';
  if (outcomes.has('no_result')) return 'no_result';
  if (outcomes.has('timeout')) return 'timeout';
  if (outcomes.has('failed')) return 'failed';
  return 'all_unavailable';
}

/** 未命中必须留一行 warn：一行里要有主因和每一跳的结局，事后不必重跑才知道卡在哪 */
function logDanmakuMiss(
  query: DanmakuQuery,
  attempts: DanmakuAttempt[],
  localXmlTried: boolean,
): void {
  const reason = missReasonOf(attempts);
  logger.warn('弹幕未命中', {
    title: query.title,
    year: query.year,
    episode: query.episode,
    scene: query.scene,
    reason,
    localXmlTried,
    attempts: attempts.map((a) => `${a.provider}:${a.outcome}`).join(' '),
    detail: attempts
      .filter((a) => a.error || a.matchedTitle || a.count !== undefined)
      .map((a) => `${a.provider}${a.error ? ` = ${a.error}` : ''}${a.matchedTitle ? ` 「${a.matchedTitle}」` : ''}${a.count !== undefined ? ` ${a.count} 条` : ''}`)
      .join(' | '),
  });
}

/**
 * 内置直连源里覆盖面最广的四个，实时播放时并行发起（P1-①-4）。
 *
 * 串行时一个源要跑完它自己的全部跳数（腾讯搜索→分集→索引→分片，B 站触顶还要分片补量），
 * 排在它后面的源只能干等；「腾讯单源超时」会把整条链变成几十秒的静默。
 */
const PARALLEL_PROVIDERS = [bilibiliProvider, tencentProvider, mgtvProvider, iqiyiProvider];
/** 并行组之后的串行兜底（原序不变） */
const SERIAL_PROVIDERS = [youkuProvider, leshiProvider, danmuApiProvider, dandanplayProvider];
/**
 * 并行组整体预算，而不是单源预算：多跳源（腾讯四跳）和分片补量（B 站最多 10 片）的合法耗时
 * 本来就有十几秒，给单源设 4 秒闸门会把「慢但正常」的源念成超时。预算到期只影响等待，
 * 不影响正确性——落选/迟到的结果都不写缓存。
 */
const PARALLEL_GROUP_BUDGET_MS = 12_000;

/** 单个源跑完判定后的结局；`match` 非 null 即可采用（缓存由胜出者写，所以这里不落缓存） */
interface ProviderOutcome {
  attempt: DanmakuAttempt;
  match: DanmakuMatch | null;
}

/**
 * 对一个源执行「匹配 → 题名校验 → 门槛」三级判定，把结局收敛成 `ProviderOutcome`。
 *
 * 抛错记 `failed`、超时预算记 `timeout`（由 `raceProviders` 补记），两种都不该被念成「源说没有」——
 * 「源没答」「源说没有」「源答得不像」是三件事，混成 null 就再也分不开（OPT-26 的原始病灶）。
 */
async function evaluateProvider(provider: DanmakuProvider, query: DanmakuQuery): Promise<ProviderOutcome> {
  try {
    const result = await provider.match(query);
    if (result === null) return { attempt: { provider: provider.id, outcome: 'no_result' }, match: null };
    if (!isTitleMatched(query.title, result.matchedTitle)) {
      // 源自己按片名搜到了东西，但题名过不了校验：这类命中正是串片的形态，必须留下痕迹
      logger.info(`弹幕源 ${provider.id} 题名不符（命中「${result.matchedTitle}」），回退下一级`);
      return {
        attempt: {
          provider: provider.id,
          outcome: 'title_mismatch',
          matchedTitle: result.matchedTitle,
          count: result.comments.length,
        },
        match: null,
      };
    }
    if (result.comments.length < DANMAKU_MIN_COMMENTS) {
      // 整集只有零星几条通常是废弃条目/花絮残留，当作未命中继续回退。
      // 用 info 不用 debug：release 级别看不见 debug，「有弹幕但被门槛丢掉」就成了一种无痕迹的失败。
      logger.info('弹幕源条数低于命中门槛，回退下一级', {
        provider: provider.id,
        count: result.comments.length,
        min: DANMAKU_MIN_COMMENTS,
        episode: query.episode,
      });
      return {
        attempt: {
          provider: provider.id,
          outcome: 'below_threshold',
          matchedTitle: result.matchedTitle,
          count: result.comments.length,
        },
        match: null,
      };
    }
    const match: DanmakuMatch = {
      provider: provider.id,
      matchedTitle: result.matchedTitle,
      // 偏移随源保存，渲染时再叠加（缓存里存原始时间，换源/重进不必回写缓存）
      offsetSec: result.offsetSec ?? 0,
      comments: thinComments(result.comments),
    };
    return { attempt: { provider: provider.id, outcome: 'hit', count: match.comments.length }, match };
  } catch (e) {
    logger.debug(`弹幕源 ${provider.id} 匹配失败，回退下一级`, e);
    return { attempt: { provider: provider.id, outcome: 'failed', error: failureText(e) }, match: null };
  }
}

/** 采用一个源的结果：写缓存 + 留一行命中日志（缓存只由胜出者写，落选与迟到的结果不会走到这里） */
async function commitHit(cacheKey: string, match: DanmakuMatch, episode: number): Promise<void> {
  await cacheRepo.putDanmaku(cacheKey, match);
  // 命中留痕：事后只能从画面内容反推「弹幕对不上」，有源 + 题名 + 偏移 + 条数才查得动
  logger.info('弹幕命中', {
    provider: match.provider,
    matchedTitle: match.matchedTitle,
    episode,
    count: match.comments.length,
    offsetSec: match.offsetSec,
  });
}

/** `raceProviders` 的三种结束方式：达标 / 全部落定但都不达标 / 整组预算到期 */
type ParallelRace = { hit: ProviderOutcome | null; outcomes: ProviderOutcome[]; timedOut: boolean };

/**
 * 并行发起一组源，返回第一个「题名匹配且达到门槛」的结果。
 *
 * 谁先给出可用结果就采用谁（到达顺序，不再是源顺序）；整组到期后还在途的源记 `timeout`
 * 并放弃，其迟到结果不再计入结局——否则会覆盖已经生效的判定口径。
 */
function raceProviders(providers: DanmakuProvider[], query: DanmakuQuery): Promise<ParallelRace> {
  return new Promise((resolve) => {
    const outcomes: ProviderOutcome[] = [];
    const settled = new Set<string>();
    let done = false;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      if (timedOut) {
        for (const provider of providers) {
          if (settled.has(provider.id)) continue;
          outcomes.push({ attempt: { provider: provider.id, outcome: 'timeout' }, match: null });
        }
      }
      clearTimeout(timer);
      const hit = outcomes.find((outcome) => outcome.match !== null) ?? null;
      resolve({ hit, outcomes, timedOut });
    };

    const timer = setTimeout(() => finish(true), PARALLEL_GROUP_BUDGET_MS);
    for (const provider of providers) {
      void evaluateProvider(provider, query).then((outcome) => {
        if (done) return; // 已胜出或已到期：迟到结果不改变本轮判定
        outcomes.push(outcome);
        settled.add(provider.id);
        if (outcome.match !== null) finish(false);
        else if (settled.size === providers.length) finish(false);
      });
    }
  });
}

export const danmakuService = {
  /**
   * 匹配一集的弹幕。缓存 → 网络源三级回退 → 本地 xml；结局与主因见 `DanmakuMatchResult`。
   * `localXml` 传入本地 xml 内容读取函数（有值时优先级最低，兜底离线）。
   * `scene` 缺省 `playback`；预取路径必须显式传 `prefetch`，见 `DanmakuQuery.scene`。
   */
  async match(
    title: string,
    year: number | null,
    episode: number,
    localXml: (() => string | null) | null = null,
    scene: DanmakuQueryScene = 'playback',
  ): Promise<DanmakuMatchResult> {
    const query: DanmakuQuery = { title, year, episode, scene };
    const attempts: DanmakuAttempt[] = [];

    // ① 缓存
    const cacheKey = danmakuCacheKey(title, year, episode);
    const cached = await cacheRepo.getDanmaku(cacheKey);
    if (cached) {
      // 离线弹幕是否生效、命中过的是哪一条，全靠这一行（缓存命中是「没发请求」的唯一证据）
      logger.info('弹幕缓存命中', {
        provider: cached.provider,
        matchedTitle: cached.matchedTitle,
        episode,
        scene,
        count: cached.comments.length,
        offsetSec: cached.offsetSec,
      });
      return { match: cached, via: 'cache', missReason: null, attempts };
    }

    // ② 网络源（远端题名与查询片名归一化相等才采用，防串片）
    //
    // 实时播放：覆盖面最广的四个内置直连源并行发起，先给出可用结果的胜出；剩下的按原序串行兜底。
    // 预取：保持串行——下载完成的整季批量 × 4 并发会打进场源风控区（见 `DanmakuQuery.scene`）。
    if (scene === 'playback') {
      const group: DanmakuProvider[] = [];
      for (const provider of PARALLEL_PROVIDERS) {
        if (provider.available()) group.push(provider);
        else attempts.push({ provider: provider.id, outcome: 'unavailable' });
      }
      if (group.length > 0) {
        const race = await raceProviders(group, query);
        for (const outcome of race.outcomes) attempts.push(outcome.attempt);
        const hit = race.hit?.match;
        if (hit !== null && hit !== undefined) {
          await commitHit(cacheKey, hit, episode);
          return { match: hit, via: 'provider', missReason: null, attempts };
        }
      }
    }

    const providers = scene === 'playback' ? SERIAL_PROVIDERS : [...PARALLEL_PROVIDERS, ...SERIAL_PROVIDERS];
    for (const provider of providers) {
      if (!provider.available()) {
        // 未配置基址/凭据、或在设置里被关掉：不写这条，主因会被念成「源都没答上来」而不是「没配源」
        attempts.push({ provider: provider.id, outcome: 'unavailable' });
        continue;
      }
      const outcome = await evaluateProvider(provider, query);
      attempts.push(outcome.attempt);
      if (outcome.match === null) continue;
      await commitHit(cacheKey, outcome.match, episode);
      return { match: outcome.match, via: 'provider', missReason: null, attempts };
    }

    // ③ 本地 xml 兜底
    const xml = localXml?.() ?? null;
    if (xml) {
      const comments = localXmlProvider.parse(xml);
      if (comments !== null) {
        const match: DanmakuMatch = { provider: 'local-xml', matchedTitle: title, offsetSec: 0, comments };
        await cacheRepo.putDanmaku(cacheKey, match);
        logger.info('本地弹幕 XML 命中', { episode, count: comments.length });
        return { match, via: 'local-xml', missReason: null, attempts };
      }
      // 用户给了文件却一条没解析出来，和「没给文件」是两件事，必须分开留痕
      logger.warn('本地弹幕 XML 解析不出条目', { title, episode, bytes: xml.length });
      attempts.push({ provider: 'local-xml', outcome: 'failed', error: '解析不出 <d> 条目' });
    }

    logDanmakuMiss(query, attempts, xml !== null);
    return { match: null, via: null, missReason: missReasonOf(attempts), attempts };
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
    if (comments === null) {
      // 0 条同时是「文件不是弹幕格式」和「编码嗅探全失败」的结局，界面只会念「没有解析出弹幕」
      logger.warn('导入的本地弹幕 XML 解析不出条目', { title, episode });
      return 0;
    }
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
   * 重新匹配本集：先作废这一集的缓存，再按实时播放口径跑一遍。
   *
   * 手动重试必须清缓存——未命中本来就不写缓存，但「命中了串片/命中了旧规则」这两种情况下，
   * 不清就直接把同一条坏结果再端回来，界面看起来像「重试没用」。
   */
  async rematch(title: string, year: number | null, episode: number): Promise<DanmakuMatchResult> {
    await cacheRepo.deleteDanmaku(danmakuCacheKey(title, year, episode));
    logger.info('弹幕重新匹配：已作废本集缓存', { title, episode });
    return this.match(title, year, episode, null, 'playback');
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
