import { describe, expect, it, vi } from 'vitest';

import {
  NOTICE_ORIGIN_LABELS,
  newNoticeRequestId,
  recordUpstreamNotice,
  redactNoticeText,
  retryAfterSecOf,
} from '@/shared/noticeOrigin';

describe('redactNoticeText（P1-2 展示脱敏）', () => {
  it('cookie 值区逐对打码：属性名与后续响应头仍可读，会话值不可恢复', () => {
    const out = redactNoticeText(
      'Cookie: __pus=1a2b3c4d5e6f7g8h; __puus=abcdef9876543210; path=/, Accept=text/html',
    );
    expect(out).toContain('__pus=***');
    expect(out).toContain('__puus=***');
    expect(out).toContain('path=/');
    expect(out).toContain('Accept=text/html');
    expect(out).not.toContain('1a2b3c4d5e6f7g8h');
    expect(out).not.toContain('abcdef9876543210');
  });

  it('没有 名=值 结构的裸 cookie 串整段打掉', () => {
    const out = redactNoticeText('Cookie: AxVRT0aaaaRRRR8888bbbbCCCC');
    expect(out).toBe('Cookie: ***');
  });

  it('Authorization 留方案名、打真令牌', () => {
    const out = redactNoticeText('请求头 Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('Bearer ***');
    expect(out).not.toContain('eyJhbGci');
  });

  it('上游 msg 里拼的签名直链盖掉值区', () => {
    const out = redactNoticeText('播放失败 https://pan.example.com/d/l.php?sign=WRONGTOK123&uk=1234567890');
    expect(out).toContain('sign=***');
    expect(out).not.toContain('WRONGTOK123');
  });

  it('人话文案一字不改（否则界面提示会被打码打坏）', () => {
    const text = '该线路没有返回播放地址，请换线路';
    expect(redactNoticeText(text)).toBe(text);
    expect(redactNoticeText('')).toBe('');
    expect(redactNoticeText(null)).toBe('');
  });
});

describe('retryAfterSecOf', () => {
  it('只认纯秒数，HTTP-date 形态不猜', () => {
    expect(retryAfterSecOf('Retry-After: 45')).toBe(45);
    expect(retryAfterSecOf('{"retry_after":120}')).toBe(120);
    expect(retryAfterSecOf('Retry-After: Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
    expect(retryAfterSecOf('')).toBeNull();
  });
});

describe('newNoticeRequestId', () => {
  it('可 grep、不含用户数据、每次不同', () => {
    const a = newNoticeRequestId('spider_msg|本接口免费使用');
    const b = newNoticeRequestId('spider_msg|本接口免费使用');
    expect(a).toMatch(/^n-[0-9a-z]+-[0-9a-z]+$/);
    expect(a).not.toContain('本接口');
    expect(a).not.toBe(b);
  });
});

describe('recordUpstreamNotice（提示来源登记）', () => {
  it('爬虫 msg 里的额度提示：来源、分档、业务码三项一起落，展示文字是分档话术', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const notice = recordUpstreamNotice('本接口免费使用次数已达上限，请稍后或换接口', {
      origin: 'spider_msg',
      operation: 'playerContent',
      sourceId: 'src-1',
      businessCode: '42900',
      errorCode: 'E_NO_PLAY_URL',
    });
    expect(notice.noticeOrigin).toBe('spider_msg');
    expect(notice.kind).toBe('quota_exhausted');
    expect(notice.text).toBe('接口额度已用完');
    expect(notice.businessCode).toBe('42900');
    const logged = info.mock.calls.find((call) => call[1] === '上游提示登记');
    expect(logged?.[2]).toMatchObject({ noticeOrigin: 'spider_msg', kind: 'quota_exhausted', sourceId: 'src-1' });
    info.mockRestore();
  });

  it('原文里的凭据不会进 detail，也就不会进日志', () => {
    const notice = recordUpstreamNotice('鉴权失败 Cookie: __pus=1a2b3c4d5e6f7g8h', {
      origin: 'business_response',
      httpStatus: 403,
    });
    expect(notice.detail).toContain('__pus=***');
    expect(notice.detail).not.toContain('1a2b3c4d5e6f7g8h');
    expect(notice.kind).toBe('auth');
  });

  it('Retry-After 从原文里读出来，作为独立字段而不是塞进文案', () => {
    const notice = recordUpstreamNotice('请求过于频繁 Retry-After: 60', { origin: 'system_toast' });
    expect(notice.kind).toBe('rate_limited');
    expect(notice.retryAfterSec).toBe(60);
  });

  it('空原文也要能登记（缺项记 null，不猜）', () => {
    const notice = recordUpstreamNotice('', { origin: 'video_frame' });
    expect(notice.detail).toBe('');
    expect(notice.httpStatus).toBeNull();
    expect(notice.businessCode).toBeNull();
    expect(NOTICE_ORIGIN_LABELS[notice.noticeOrigin]).toBe('视频画面');
  });
});
