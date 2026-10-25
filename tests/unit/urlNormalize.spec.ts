/**
 * urlNormalize 单测（v1.7 / CHG-18，AC-112 / AC-114）
 */
import { describe, expect, it } from 'vitest';

import { normalizeImportUrl, isLikelyLiveListUrl } from '@/shared/urlNormalize';
import { proxyStripVariants, withGithubMirrorFallback } from '@/shared/githubMirror';
import { AppError } from '@/shared/errors';

describe('normalizeImportUrl（AC-112）', () => {
  it('普通合法 URL 原样通过（零改写）', () => {
    const result = normalizeImportUrl('https://example.com/tv.json');
    expect(result.url).toBe('https://example.com/tv.json');
    expect(result.variants).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.strippedProxy).toBeNull();
  });

  it('gitee blob 页重写为 raw 首选地址并给提示', () => {
    const result = normalizeImportUrl('https://gitee.com/pp-pangpang/2026/blob/master/mylive.webp');
    expect(result.url).toBe('https://gitee.com/pp-pangpang/2026/raw/master/mylive.webp');
    expect(result.notes.some((n) => n.includes('raw'))).toBe(true);
  });

  it('github blob 页重写为 raw.githubusercontent', () => {
    const result = normalizeImportUrl('https://github.com/user/repo/blob/main/config.json');
    expect(result.url).toBe('https://raw.githubusercontent.com/user/repo/main/config.json');
  });

  it('gitlab/jihulab 的 -/blob/ 重写为 -/raw/', () => {
    const result = normalizeImportUrl('https://jihulab.com/ymz1231/xymz/-/blob/main/ymshaoer');
    expect(result.url).toBe('https://jihulab.com/ymz1231/xymz/-/raw/main/ymshaoer');
  });

  it('cnb.cool 的 -/blob/ 重写为 -/git/raw/', () => {
    const result = normalizeImportUrl('https://cnb.cool/srka/aow/-/blob/main/config');
    expect(result.url).toBe('https://cnb.cool/srka/aow/-/git/raw/config');
  });

  it('gh-proxy 前缀：首选保留原地址，变体含剥前缀直连 + 镜像', () => {
    const raw = 'https://raw.githubusercontent.com/xyq254245/xyqonlinerule/main/XYQTVBox.json';
    const result = normalizeImportUrl(`https://gh-proxy.org/${raw}`);
    expect(result.url).toBe(`https://gh-proxy.org/${raw}`);
    expect(result.strippedProxy).toBe('gh-proxy.org');
    expect(result.variants[0]).toBe(raw);
    expect(result.variants.some((v) => v.startsWith('https://ghfast.top/'))).toBe(true);
  });

  it('裸 GitHub raw：变体含全部镜像', () => {
    const result = normalizeImportUrl('https://raw.githubusercontent.com/u/r/main/a.json');
    expect(result.variants).toContain('https://gh-proxy.org/https://raw.githubusercontent.com/u/r/main/a.json');
    expect(result.variants).toContain('https://ghfast.top/https://raw.githubusercontent.com/u/r/main/a.json');
  });

  it('jsdelivr ↔ raw 互换变体', () => {
    const jsd = normalizeImportUrl('https://cdn.jsdelivr.net/gh/liu673cn/box@main/m.json');
    expect(jsd.variants).toContain('https://raw.githubusercontent.com/liu673cn/box/main/m.json');

    const raw = normalizeImportUrl('https://raw.githubusercontent.com/u/r/main/m.json');
    expect(raw.variants.some((v) => v.startsWith('https://cdn.jsdelivr.net/gh/u/r@main/'))).toBe(true);
  });

  it('查询串拼写提示不改写（AC-114）', () => {
    const result = normalizeImportUrl('https://xn--sdds.v.nxog.top/apitv.php?id-3');
    expect(result.url).toBe('https://xn--sdds.v.nxog.top/apitv.php?id-3');
    expect(result.notes.some((n) => n.includes('拼写'))).toBe(true);
  });

  it('正常 query 不误报拼写提示', () => {
    const result = normalizeImportUrl('https://tv.nxog.top/apitv.php?id=2');
    expect(result.notes).toEqual([]);
  });
});

describe('isLikelyLiveListUrl', () => {
  it('m3u/m3u8 后缀命中', () => {
    expect(isLikelyLiveListUrl('https://a.com/tv/ipv6.m3u')).toBe(true);
    expect(isLikelyLiveListUrl('http://x/live/index.m3u8?token=1')).toBe(true);
  });
  it('普通 JSON 地址不命中', () => {
    expect(isLikelyLiveListUrl('https://example.com/tv.json')).toBe(false);
  });
});

describe('githubMirror 代理前缀集成', () => {
  it('proxyStripVariants 只对「前缀 + GitHub raw」生效', () => {
    const raw = 'https://raw.githubusercontent.com/u/r/main/a.json';
    expect(proxyStripVariants(`https://gh-proxy.com/${raw}`)).toEqual([raw]);
    expect(proxyStripVariants('https://gh-proxy.org/https://example.com/a.json')).toEqual([]);
    expect(proxyStripVariants(raw)).toEqual([]);
  });

  it('withGithubMirrorFallback：前缀地址失败先剥前缀直连', async () => {
    const raw = 'https://raw.githubusercontent.com/u/r/main/a.json';
    const tried: string[] = [];
    const result = await withGithubMirrorFallback(
      `https://ghfast.top/${raw}`,
      async (url) => {
        tried.push(url);
        if (tried.length === 1) throw new AppError('E_NETWORK');
        return 'ok';
      },
    );
    expect(result.viaMirror).toBe(raw); // 命中的是「剥前缀」变体
    expect(result.value).toBe('ok');
    expect(tried).toEqual([`https://ghfast.top/${raw}`, raw]);
  });
});
