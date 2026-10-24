import { beforeEach, describe, expect, it, vi } from 'vitest';

import { extractUrls, subscriptionEvalService } from '@/services/subscriptionEvalService';

/** 批量订阅评测（CHG-12） */
const { previewFromUrl, httpRequest } = vi.hoisted(() => ({
  previewFromUrl: vi.fn(),
  httpRequest: vi.fn(),
}));

vi.mock('@/services/importService', () => ({
  importService: { previewFromUrl },
}));
vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: httpRequest, requestWithMeta: httpRequest },
}));

function previewOf(entries: Array<Record<string, unknown>>, opts: { repos?: string[]; name?: string } = {}) {
  return Promise.resolve({
    origin: 'url',
    sourceUrl: 'https://sub.example.com/x.json',
    fileName: null,
    fetchedAt: 1,
    name: opts.name ?? '测试订阅',
    total: entries.length,
    entries: entries.map((e) => ({
      key: e.key,
      name: e.name,
      type: e.type,
      enabled: true,
      selected: true,
      valid: true,
      duplicateOf: null,
      warning: null,
      issues: [],
      normalized: {
        key: e.key,
        name: e.name,
        type: e.type,
        baseUrl: e.api ?? null,
        ext: e.ext ?? null,
      },
    })),
    globalIssues: [],
    repos: opts.repos ?? [],
  });
}

const SITE = { key: 's1', name: '站点', type: 'site', api: 'https://cms.example.com/api.php' };
const SITE2 = { key: 's2', name: '站点2', type: 'site', api: 'https://cms2.example.com/api.php' };
const SPIDER = {
  key: 'p1',
  name: '爬虫',
  type: 'spider',
  api: 'csp_X',
  ext: { kind: 'jar', api: 'csp_X', jarUrl: 'https://cdn.example.com/a.jar', initExt: '' },
};

describe('extractUrls', () => {
  it('从带编号/杂文字的清单里抽取 URL', () => {
    const text = [
      '1\t小盒子4K\thttp://xhztv.top/4k.json\t● 200',
      '2  王二小 https://9280.kstore.vip/newwex.json 检测',
      '这不是链接的一行',
      'https://gist.githubusercontent.com/u/1/raw/g.txt 尾随',
    ].join('\n');
    expect(extractUrls(text)).toEqual([
      'http://xhztv.top/4k.json',
      'https://9280.kstore.vip/newwex.json',
      'https://gist.githubusercontent.com/u/1/raw/g.txt',
    ]);
  });
});

describe('subscriptionEvalService.evaluate', () => {
  beforeEach(() => {
    previewFromUrl.mockReset();
    httpRequest.mockReset();
    httpRequest.mockResolvedValue({ data: undefined, status: 200, headers: new Headers() });
  });

  it('站点 + 爬虫订阅：分类计数、抽测存活、jar 判死汇总', async () => {
    previewFromUrl.mockResolvedValue(
      await previewOf([SITE, SITE2, SPIDER, { key: 'bad', name: 'JS 爬虫', type: 'spider', api: 'https://x.example.com/drpy.js' }]),
    );
    httpRequest.mockImplementation(async (url: string) => {
      // 站点2 返回 404（throwOnHttpError:false 不抛错，按状态计死）；其余 2xx
      if (String(url).includes('cms2')) return { data: undefined, status: 404, headers: new Headers() };
      return { data: undefined, status: 200, headers: new Headers() };
    });

    const [result] = await subscriptionEvalService.evaluate(['https://sub.example.com/x.json']);

    expect(result.status).toBe('ok');
    expect(result.total).toBe(4);
    expect(result.siteCount).toBe(2);
    expect(result.spiderCount).toBe(2);
    expect(result.jsCount).toBe(1);
    expect(result.siteChecked).toBe(2);
    expect(result.siteAlive).toBe(1);
    expect(result.jarTotal).toBe(1);
    expect(result.jarDead).toBe(0);
  });

  it('jar 403 计入判死；错误订阅产出 error 结果不影响其它', async () => {
    const { AppError } = await import('@/shared/errors');
    previewFromUrl.mockImplementation(async (url: string) => {
      if (url === 'https://dead.example.com/x.json') {
        throw new AppError('E_NETWORK', '网络不可用');
      }
      return previewOf([SPIDER], { name: 'jar 死' });
    });
    httpRequest.mockImplementation(async () => {
      throw new AppError('E_HTTP_403', undefined, { httpStatus: 403 });
    });

    const results = await subscriptionEvalService.evaluate([
      'https://dead.example.com/x.json',
      'https://sub.example.com/x.json',
    ]);

    const dead = results.find((r) => r.url === 'https://dead.example.com/x.json');
    const ok = results.find((r) => r.url === 'https://sub.example.com/x.json');
    expect(dead?.status).toBe('error');
    expect(dead?.error?.code).toBe('E_NETWORK');
    expect(ok?.jarDead).toBe(1);
    expect(ok?.jarTotal).toBe(1);
  });

  it('多仓索引只标记不展开；结果按活条目估计降序', async () => {
    previewFromUrl.mockImplementation(async (url: string) => {
      if (url === 'https://multi.example.com/dc.json') {
        return previewOf([], { repos: ['https://a.json', 'https://b.json'], name: '多仓' });
      }
      return previewOf([SITE], { name: '单站' });
    });

    const results = await subscriptionEvalService.evaluate([
      'https://multi.example.com/dc.json',
      'https://sub.example.com/x.json',
    ]);

    expect(results[0]?.url).toBe('https://sub.example.com/x.json');
    const multi = results.find((r) => r.url === 'https://multi.example.com/dc.json');
    expect(multi?.isMultiRepo).toBe(true);
    expect(multi?.repoCount).toBe(2);
    expect(multi?.total).toBeNull();
  });

  it('进度回调逐条递增', async () => {
    previewFromUrl.mockResolvedValue(await previewOf([SITE]));
    const progress: Array<[number, number]> = [];
    await subscriptionEvalService.evaluate(
      ['https://a.json', 'https://b.json', 'https://c.json'],
      undefined,
      (done, total) => progress.push([done, total]),
    );
    expect(progress).toHaveLength(3);
    expect(progress.at(-1)).toEqual([3, 3]);
  });
});
