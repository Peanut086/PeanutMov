import { describe, expect, it } from 'vitest';

import type { AppErrorShape } from '@/types';
import {
  classifySourceFailure,
  guidanceOf,
  isJarLinkageMessage,
  isMagnetUrl,
  isQuotaExhaustedMessage,
  isRateLimitedMessage,
  isRuleScriptMessage,
  isSourceBusyMessage,
  isTransientFailure,
  JAR_CONFLICT_MESSAGE,
  magnetUrlOf,
  RULE_SCRIPT_MESSAGE,
  sanitizeSourceMessage,
  SOURCE_BUSY_MESSAGE,
  SOURCE_INTERNAL_MESSAGE,
} from '@/shared/sourceFailure';

/** 构造最小 AppErrorShape（分类只看 code / message / detail） */
function shape(code: AppErrorShape['code'], message: string, detail: string | null = null): AppErrorShape {
  return { code, message, detail, retryable: true, httpStatus: null };
}

describe('isRuleScriptMessage / sanitizeSourceMessage（P1-5）', () => {
  it('识别真机出现过的脚本内部异常形态', () => {
    expect(isRuleScriptMessage("expecting ';'")).toBe(true);
    expect(isRuleScriptMessage("'data' is not defined")).toBe(true);
    expect(isRuleScriptMessage("cannot read property '1' of null")).toBe(true);
    expect(isRuleScriptMessage('TypeError: undefined is not a function')).toBe(true);
    expect(isRuleScriptMessage('at rule_fetch_params.js:12')).toBe(true);
  });

  it('人话不误伤', () => {
    expect(isRuleScriptMessage('该源暂不可用，可切换其他源')).toBe(false);
    expect(isRuleScriptMessage('爬虫类缺失，源配置与 jar 不匹配')).toBe(false);
    expect(isRuleScriptMessage('')).toBe(false);
    expect(isRuleScriptMessage(null)).toBe(false);
  });

  it('脚本异常收敛成统一文案，其它原样返回', () => {
    expect(sanitizeSourceMessage("规则调用失败: 搜索执行失败: expecting ';'")).toBe(RULE_SCRIPT_MESSAGE);
    expect(sanitizeSourceMessage('源地址拒绝访问（HTTP 401/403），源可能已失效')).toBe(
      '源地址拒绝访问（HTTP 401/403），源可能已失效',
    );
    expect(sanitizeSourceMessage(null)).toBe('');
  });

  it('爬虫/插件 Java 异常同样收敛（真机 detail 明细实测形态）', () => {
    expect(
      sanitizeSourceMessage(
        "爬虫调用失败: NullPointerException: Attempt to invoke virtual method 'java.lang.String com.github.catvod.crawler.Spider.detailContent(java.util.List)' on a null object reference",
      ),
    ).toBe(SOURCE_INTERNAL_MESSAGE);
    expect(
      sanitizeSourceMessage(
        '爬虫调用失败: JsonSyntaxException: java.lang.IllegalStateException: Expected BEGIN_OBJECT but was STRING at line 1 column 1 path $',
      ),
    ).toBe(SOURCE_INTERNAL_MESSAGE);
    expect(sanitizeSourceMessage('爬虫调用失败: ArrayIndexOutOfBoundsException: length=1; index=1')).toBe(
      SOURCE_INTERNAL_MESSAGE,
    );
    // 真机导出日志 26962 行里 38 次的 jar 宿主库噪音：jar 按 TVBox 约定去开宿主的
    // databases/tv，本 App 不建这个库。收敛成人话，并且只算瞬时故障，不据此判源死。
    expect(
      sanitizeSourceMessage(
        "爬虫调用失败: SQLiteCantOpenDatabaseException: Cannot open database '/data/user/0/com.qoder.cinema/databases/tv' with flags 0x1: File /data/user/0/com.qoder.cinema/databases/tv doesn't exist",
      ),
    ).toBe(SOURCE_INTERNAL_MESSAGE);
    expect(
      classifySourceFailure(
        shape('E_UNKNOWN', "SQLiteCantOpenDatabaseException: Cannot open database '.../databases/tv' doesn't exist"),
      ),
    ).toBe('source_internal');
    expect(isTransientFailure('source_internal')).toBe(true);
    // 人话文案不误伤
    expect(sanitizeSourceMessage('源可加载但没有内容（源站可能已失效）')).toBe(
      '源可加载但没有内容（源站可能已失效）',
    );
  });
});

describe('classifySourceFailure（P0-1）', () => {
  it('四类可行动原因', () => {
    expect(classifySourceFailure(shape('E_TIMEOUT', '请求超时，请稍后重试'))).toBe('timeout');
    expect(classifySourceFailure(shape('E_SOURCE_UNAVAILABLE', '源站已下线'))).toBe('source_dead');
    expect(classifySourceFailure(shape('E_UNSUPPORTED_FORMAT', '暂不支持该格式'))).toBe('protocol_unsupported');
    expect(classifySourceFailure(shape('E_SOURCE_UNAVAILABLE', "expecting ';'"))).toBe('rule_script');
  });

  it('鉴权类单列（要去源管理改凭据，不是换源）', () => {
    expect(classifySourceFailure(shape('E_HTTP_401', '认证失败'))).toBe('auth');
    expect(classifySourceFailure(shape('E_AUTH', '认证失败'))).toBe('auth');
  });

  it('磁力优先归为协议不支持（即使 code 是别的）', () => {
    expect(classifySourceFailure(shape('E_PARSE', '解析失败', 'magnet:?xt=urn:btih:abc'))).toBe(
      'protocol_unsupported',
    );
  });

  it('空错误 → unknown', () => {
    expect(classifySourceFailure(null)).toBe('unknown');
  });

  it('爬虫 Java 异常归为「源侧执行异常」', () => {
    expect(
      classifySourceFailure(
        shape('E_SOURCE_UNAVAILABLE', '爬虫调用失败: NullPointerException: Attempt to invoke virtual method'),
      ),
    ).toBe('source_internal');
  });
});

describe('jar 依赖冲突（F9）', () => {
  /** 真机光影源原文：进程内每次调用必现，此前被归成 unknown 反复重试 */
  const LINKAGE =
    '爬虫加载失败: java.lang.IncompatibleClassChangeError: org.slf4j.impl.AndroidLoggerFactory does not implement com.github.catvod.spider.merge.Pu';

  it('依赖冲突原文收敛成人话', () => {
    expect(sanitizeSourceMessage(LINKAGE)).toBe(JAR_CONFLICT_MESSAGE);
  });

  it('归为 jar_conflict，且收敛后的文案同样能归类', () => {
    expect(classifySourceFailure(shape('E_SOURCE_UNAVAILABLE', LINKAGE))).toBe('jar_conflict');
    expect(classifySourceFailure(shape('E_UNKNOWN', JAR_CONFLICT_MESSAGE))).toBe('jar_conflict');
  });

  it('确定性故障不进自动重试，瞬态类仍然重试', () => {
    expect(isTransientFailure('jar_conflict')).toBe(false);
    expect(isTransientFailure('source_internal')).toBe(true);
  });

  it('脚本异常、Java 空指针与瞬时初始化异常都不误判为依赖冲突', () => {
    expect(isJarLinkageMessage("expecting ';'")).toBe(false);
    expect(isJarLinkageMessage('NullPointerException: Attempt to invoke virtual method')).toBe(false);
    expect(isJarLinkageMessage('ExceptionInInitializerError')).toBe(false);
    expect(isJarLinkageMessage('NoClassDefFoundError: Could not initialize class com.github.catvod.spider.Init')).toBe(
      true,
    );
  });
});

describe('源正忙独立成档（P1-3）', () => {
  /** 原生 F1 串行闸门那句拒绝（SpiderPlugin.java）：真机每次撞闸门都是这段原文 */
  const NATIVE_LOCK = '源正忙（上一次调用仍在原生线程执行），请稍后重试';

  it('结构化错误码优先归类', () => {
    expect(classifySourceFailure(shape('E_SOURCE_BUSY', SOURCE_BUSY_MESSAGE))).toBe('source_busy');
    expect(classifySourceFailure(shape('E_SOURCE_BUSY', '自定义文案', '绝命毒师'))).toBe('source_busy');
  });

  it('只有原生原文时同样归到 source_busy，而不是被 source_internal 接走', () => {
    // 这段判定必须排在 jar_conflict / rule_script / source_internal 之前，
    // 否则 IllegalStateException 形态的原文会落进「可重试」档，忙的时候再投一次
    expect(classifySourceFailure(shape('E_SOURCE_UNAVAILABLE', NATIVE_LOCK))).toBe('source_busy');
    expect(classifySourceFailure(shape('E_UNKNOWN', '', NATIVE_LOCK))).toBe('source_busy');
    expect(classifySourceFailure(shape('E_UNKNOWN', '爬虫调用失败', NATIVE_LOCK))).toBe('source_busy');
  });

  it('不再被当成死源：下游据此不即时重投、不换同源线路、不记线路连败', () => {
    expect(classifySourceFailure(shape('E_SOURCE_UNAVAILABLE', NATIVE_LOCK))).not.toBe('source_dead');
    expect(isTransientFailure('source_busy')).toBe(false);
    expect(isTransientFailure('timeout')).toBe(true);
  });

  it('适配器自己的排队文案（带真实剩余秒数）也归同一档', () => {
    expect(classifySourceFailure(shape('E_SOURCE_BUSY', '该源正忙（上一次调用约 14 秒后结束），请稍后重试'))).toBe(
      'source_busy',
    );
  });

  it('口径收紧：jar 侧「请继续使用」的宽泛措辞不认，限流文案也不被抢走', () => {
    // 「当前源是繁忙状态，请继续使用，或手动解除」是 jar 内部提示，语义模糊（可能是它自己的
    // 计数没落），不据此改判；这类文案维持原有档位。
    expect(isSourceBusyMessage('当前源是繁忙状态，请继续使用，或手动解除')).toBe(false);
    expect(isSourceBusyMessage('请求超时，请稍后重试')).toBe(false);
    expect(isSourceBusyMessage('服务器繁忙 Retry-After: 30')).toBe(false);
    expect(classifySourceFailure(shape('E_UNKNOWN', '服务器繁忙 Retry-After: 30'))).toBe('rate_limited');
  });

  it('指导文案说清"同一个爬虫实例"，动作给出换源与稍后重试', () => {
    const guidance = guidanceOf(shape('E_SOURCE_BUSY', SOURCE_BUSY_MESSAGE));
    expect(guidance.kind).toBe('source_busy');
    expect(guidance.title).toBe(SOURCE_BUSY_MESSAGE);
    expect(guidance.hint).toContain('同一个爬虫进程');
    expect(guidance.hint).toContain('线路共用同一个爬虫实例');
    expect(guidance.actions).toEqual(['switch-source', 'retry']);
  });
});

describe('guidanceOf', () => {
  it('每类都给文案与动作，磁力给「外部打开」', () => {
    const magnet = guidanceOf(shape('E_UNSUPPORTED_FORMAT', '暂不支持该格式', 'magnet:?xt=urn:btih:abc'));
    expect(magnet.kind).toBe('protocol_unsupported');
    expect(magnet.actions).toContain('external');
    expect(magnet.title).toContain('磁力');

    const timeout = guidanceOf(shape('E_TIMEOUT', '超时'));
    expect(timeout.actions[0]).toBe('retry');

    const dead = guidanceOf(shape('E_SOURCE_UNAVAILABLE', '源站已下线'));
    expect(dead.actions).toContain('switch-source');
  });
});

describe('isMagnetUrl / magnetUrlOf（P1-4）', () => {
  it('只认 magnet: 前缀', () => {
    expect(isMagnetUrl('magnet:?xt=urn:btih:abc')).toBe(true);
    expect(isMagnetUrl(' MAGNET:?xt=1')).toBe(true);
    expect(isMagnetUrl('https://a.com/magnet:1')).toBe(false);
    expect(isMagnetUrl(null)).toBe(false);
  });

  it('优先从 detail 取原始地址', () => {
    const err = shape('E_UNSUPPORTED_FORMAT', '磁力链接需用外部下载器/播放器打开', 'magnet:?xt=urn:btih:abc');
    expect(magnetUrlOf(err)).toBe('magnet:?xt=urn:btih:abc');
    expect(magnetUrlOf(shape('E_UNSUPPORTED_FORMAT', '暂不支持该格式'))).toBeNull();
    expect(magnetUrlOf(null)).toBeNull();
  });
});

describe('限流 / 额度 / 无播放地址分档（P1-2）', () => {
  it('429 与 Retry-After 独立成档，且不进自动重试', () => {
    expect(classifySourceFailure(shape('E_HTTP_429', '请求过于频繁，请稍后再试'))).toBe('rate_limited');
    expect(classifySourceFailure(shape('E_UNKNOWN', '服务器繁忙 Retry-After: 30'))).toBe('rate_limited');
    // HTTP 状态比错误码硬：同一个 E_SOURCE_UNAVAILABLE，429 不再算源失效
    const withStatus = { ...shape('E_SOURCE_UNAVAILABLE', '上游拒绝'), httpStatus: 429 };
    expect(classifySourceFailure(withStatus)).toBe('rate_limited');
    expect(isTransientFailure('rate_limited')).toBe(false);
  });

  it('401/403 仍归鉴权档（要改凭据，不是换源）', () => {
    expect(classifySourceFailure(shape('E_HTTP_403', '无权限访问(403)'))).toBe('auth');
    const withStatus = { ...shape('E_SOURCE_UNAVAILABLE', '源地址拒绝访问'), httpStatus: 403 };
    expect(classifySourceFailure(withStatus)).toBe('auth');
  });

  it('额度类文案没有独立错误码也分得出来', () => {
    expect(classifySourceFailure(shape('E_NO_PLAY_URL', '本接口免费使用次数已达上限'))).toBe('quota_exhausted');
    expect(classifySourceFailure(shape('E_PARSE', '{"code":42900,"msg":"超出当日限额"}'))).toBe('quota_exhausted');
    expect(isTransientFailure('quota_exhausted')).toBe(false);
  });

  it('订阅名里的「免费」不误判成额度耗尽', () => {
    expect(isQuotaExhaustedMessage('XX免费资源 最新采集')).toBe(false);
    expect(classifySourceFailure(shape('E_SOURCE_UNAVAILABLE', '源「XX免费资源」无响应'))).toBe('source_dead');
  });

  it('限流判定只认频率语义，不误伤「解析超时」与磁力', () => {
    expect(isRateLimitedMessage('请求超时，请稍后重试')).toBe(false);
    expect(classifySourceFailure(shape('E_TIMEOUT', '请求超时，请稍后重试'))).toBe('timeout');
  });

  it('无播放地址独立成档，但保留原有的一次重试语义', () => {
    expect(classifySourceFailure(shape('E_NO_PLAY_URL', '该集暂无可播放地址'))).toBe('no_play_url');
    expect(isTransientFailure('no_play_url')).toBe(true);
  });

  it('网盘登录档独立成档（真机原文实测：夸克未登录）', () => {
    // 真机日志里这条原文出现过 3 次，此前落 unknown ⇒ 播放页只给一句通用提示
    const real = shape('E_NETDISK_LOGIN_REQUIRED', '还未登录夸克账号,请前往【配置中心】登录');
    expect(classifySourceFailure(real)).toBe('netdisk_login');
    const guidance = guidanceOf(real);
    expect(guidance.title).toContain('网盘未登录');
    // 上游说的「配置中心」是 TVBox 生态的说法，本 App 的入口必须给对
    expect(guidance.hint).toContain('设置 → 网盘登录');
    // 登录之前重试和换源都没用，不进自动重试
    expect(isTransientFailure('netdisk_login')).toBe(false);
  });

  it('网盘登录文案没有独立错误码时不误伤分享类文案', () => {
    // 死链/封禁文案不含「登录」，仍按原档位走（detectNetdiskError 不会给出登录码）
    expect(classifySourceFailure(shape('E_NO_PLAY_URL', '分享者账号已被封禁'))).toBe('no_play_url');
  });
});
