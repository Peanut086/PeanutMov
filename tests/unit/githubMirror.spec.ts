import { describe, expect, it } from 'vitest';

import { AppError } from '@/shared/errors';
import { isGithubRawUrl, mirrorVariants, withGithubMirrorFallback } from '@/shared/githubMirror';

/** GitHub raw 镜像回退（CHG-11） */
describe('isGithubRawUrl / mirrorVariants', () => {
  it('raw / gist / github.com raw 形态识别为 GitHub 地址', () => {
    expect(isGithubRawUrl('https://raw.githubusercontent.com/a/b/main/x.json')).toBe(true);
    expect(isGithubRawUrl('https://gist.githubusercontent.com/u/1/raw/g.txt')).toBe(true);
    expect(isGithubRawUrl('https://github.com/owner/repo/raw/main/box.json')).toBe(true);
    expect(isGithubRawUrl('https://github.com/owner/repo')).toBe(false);
    expect(isGithubRawUrl('http://xhztv.top/4k.json')).toBe(false);
    expect(isGithubRawUrl('not-a-url')).toBe(false);
  });

  it('镜像变体按序生成且保留原始路径；非 GitHub 地址为空', () => {
    const url = 'https://raw.githubusercontent.com/a/b/main/x.json';
    expect(mirrorVariants(url)).toEqual([
      'https://gh-proxy.org/https://raw.githubusercontent.com/a/b/main/x.json',
      'https://ghfast.top/https://raw.githubusercontent.com/a/b/main/x.json',
      'https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/x.json',
    ]);
    expect(mirrorVariants('http://xhztv.top/4k.json')).toEqual([]);
  });
});

describe('withGithubMirrorFallback', () => {
  const RAW = 'https://raw.githubusercontent.com/a/b/main/x.json';
  const CMS = 'http://xhztv.top/4k.json';

  it('直连成功不触发镜像', async () => {
    const calls: string[] = [];
    const result = await withGithubMirrorFallback(RAW, async (u) => {
      calls.push(u);
      return 'ok';
    });
    expect(result).toEqual({ value: 'ok', viaMirror: null });
    expect(calls).toEqual([RAW]);
  });

  it('直连网络失败 → 按序换镜像，第二个镜像命中', async () => {
    const calls: string[] = [];
    const result = await withGithubMirrorFallback(RAW, async (u) => {
      calls.push(u);
      if (calls.length < 3) throw new AppError('E_NETWORK');
      return 'ok';
    });
    expect(result.viaMirror).toBe(calls[2]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('gh-proxy.org');
  });

  it('全部镜像都网络失败 → 抛最后一个错误', async () => {
    await expect(
      withGithubMirrorFallback(RAW, async () => {
        throw new AppError('E_TIMEOUT');
      }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });

  it('HTTP 类失败（403）不触发镜像，直接抛出', async () => {
    const calls: string[] = [];
    await expect(
      withGithubMirrorFallback(RAW, async (u) => {
        calls.push(u);
        throw new AppError('E_HTTP_403', undefined, { httpStatus: 403 });
      }),
    ).rejects.toMatchObject({ code: 'E_HTTP_403' });
    expect(calls).toEqual([RAW]);
  });

  it('镜像上返回 HTTP 类失败 → 立即抛出，不再换下一个镜像', async () => {
    const calls: string[] = [];
    await expect(
      withGithubMirrorFallback(RAW, async (u) => {
        calls.push(u);
        if (calls.length === 1) throw new AppError('E_NETWORK');
        throw new AppError('E_HTTP_404', undefined, { httpStatus: 404 });
      }),
    ).rejects.toMatchObject({ code: 'E_HTTP_404' });
    expect(calls).toHaveLength(2);
  });

  it('非 GitHub 地址网络失败不换镜像（原样抛出）', async () => {
    const calls: string[] = [];
    await expect(
      withGithubMirrorFallback(CMS, async (u) => {
        calls.push(u);
        throw new AppError('E_NETWORK');
      }),
    ).rejects.toMatchObject({ code: 'E_NETWORK' });
    expect(calls).toEqual([CMS]);
  });
});
