import { describe, expect, it } from 'vitest';

import type { AppErrorShape } from '@/types';
import {
  classifySourceFailure,
  guidanceOf,
  isMagnetUrl,
  isRuleScriptMessage,
  magnetUrlOf,
  RULE_SCRIPT_MESSAGE,
  sanitizeSourceMessage,
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
