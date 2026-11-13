import { describe, expect, it } from 'vitest';

import {
  IMG_W_BLUR,
  IMG_W_CARD,
  IMG_W_COMPACT,
  IMG_W_INLINE,
  IMG_W_POSTER,
  sizedImage,
} from '@/shared/imageSize';

/**
 * 海报尺寸协商（P2-15）
 *
 * 关键契约是**fail-open**：认不出的主机一个字节都不改。给未知图床加参数，
 * 轻则被忽略（白花一次 URL 拼接），重则对方校验参数直接 400——那是把
 * 「省流量」做成「图裂」的低级事故。所以这里一半的用例在验「不该动的时候没动」。
 */

const OSS = 'https://mov-cover.oss-cn-shenzhen.aliyuncs.com/poster/1.jpg';
const COS = 'https://cover-1250000000.picsh.myqcloud.com/poster/1.jpg';

describe('sizedImage：认得出的主机', () => {
  it('阿里云 OSS 下发 x-oss-process（resize + 质量）', () => {
    expect(sizedImage(OSS, IMG_W_CARD)).toBe(
      'https://mov-cover.oss-cn-shenzhen.aliyuncs.com/poster/1.jpg?x-oss-process=image/resize,w_540/quality,q_80',
    );
  });

  it('腾讯云 COS 用 imageMogr2（分隔符风格与 OSS 不通用）', () => {
    expect(sizedImage(COS, IMG_W_INLINE)).toBe(
      'https://cover-1250000000.picsh.myqcloud.com/poster/1.jpg?imageMogr2/thumbnail/160x/quality/80',
    );
  });

  it('已有查询串时用 & 追加，不覆盖原参数（签名图靠 query 才能取到）', () => {
    const signed = `${OSS}?Expires=1&Signature=abc`;
    expect(sizedImage(signed, IMG_W_POSTER)).toBe(
      'https://mov-cover.oss-cn-shenzhen.aliyuncs.com/poster/1.jpg?Expires=1&Signature=abc&x-oss-process=image/resize,w_320/quality,q_80',
    );
  });

  it('host 大小写与协议大小写都算命中', () => {
    expect(sizedImage('HTTPS://B.ALIYUNCS.COM/x.jpg', 200)).toContain('x-oss-process=image/resize,w_200');
  });

  it('hash 保留在追加段之后', () => {
    expect(sizedImage('https://b.aliyuncs.com/x.jpg#frag', 200)).toBe(
      'https://b.aliyuncs.com/x.jpg?x-oss-process=image/resize,w_200/quality,q_80#frag',
    );
  });

  it('非整数宽度取整，避免 w_540.5 这种非法参数', () => {
    expect(sizedImage('https://b.aliyuncs.com/x.jpg', 540.6)).toContain('w_541');
  });
});

describe('sizedImage：认不出的一律原样（fail-open）', () => {
  it('未知主机不改写', () => {
    for (const url of ['https://img.doubanio.com/view/x.jpg', 'https://a.com/p.png', OSS.replace('aliyuncs', 'aliyuncss')]) {
      expect(sizedImage(url, IMG_W_CARD)).toBe(url);
    }
  });

  it('子串伪装的主机不算命中（必须是真的后缀）', () => {
    const fake = 'https://evil.aliyuncs.com.not-a-cdn.net/p.jpg';
    expect(sizedImage(fake, IMG_W_CARD)).toBe(fake);
  });

  it('已协商过的地址不重复加参数（同一张图可能被多个入口处理）', () => {
    const once = sizedImage(OSS, IMG_W_CARD)!;
    expect(sizedImage(once, IMG_W_INLINE)).toBe(once);
    const cosOnce = sizedImage(COS, IMG_W_CARD)!;
    expect(sizedImage(cosOnce, IMG_W_COMPACT)).toBe(cosOnce);
  });

  it('data: / blob: / 相对地址不动（演示海报与本地帧图）', () => {
    for (const url of [
      'data:image/svg+xml;base64,AAAA',
      'blob:https://localhost/8e1c',
      '/assets/brand/logo.png',
      '//img.a.com/x.jpg',
    ]) {
      expect(sizedImage(url, IMG_W_CARD)).toBe(url);
    }
  });

  it('宽度 ≤ 0 表示不协商', () => {
    expect(sizedImage(OSS, 0)).toBe(OSS);
    expect(sizedImage(OSS, -1)).toBe(OSS);
  });

  it('null / undefined 原样返回 null', () => {
    expect(sizedImage(null, IMG_W_CARD)).toBeNull();
    expect(sizedImage(undefined, IMG_W_CARD)).toBeNull();
  });

  it('畸形地址不抛错，原样交回', () => {
    // 过得了协议正则、过不了 URL 解析：交给浏览器自己处理，这里不添乱
    const bad = 'http://不 合法/x.jpg';
    expect(() => sizedImage(bad, IMG_W_CARD)).not.toThrow();
    expect(sizedImage(bad, IMG_W_CARD)).toBe(bad);
  });
});

describe('尺寸档位', () => {
  it('由小到大，且都是可直接下发给对象存储的整数', () => {
    const buckets = [IMG_W_INLINE, IMG_W_POSTER, IMG_W_COMPACT, IMG_W_BLUR, IMG_W_CARD];
    expect(buckets).toEqual([...buckets].sort((a, b) => a - b));
    buckets.forEach((w) => expect(Number.isInteger(w)).toBe(true));
    // 最窄的档也够 46 CSS px 的行内封面（DPR 1 时 160 > 46）
    expect(IMG_W_INLINE).toBeGreaterThan(46);
  });
});
