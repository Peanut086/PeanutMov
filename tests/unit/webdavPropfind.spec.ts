import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebDAVClient } from '@/services/webdavService';

/**
 * OPT-11：PROPFIND 响应的命名空间兼容
 *
 * WebDAV 只固定元素本地名，前缀由服务端自选。备份客户端的正则此前写死了 `D:`
 * （只有 `D:` / `d:` 两种大小写能碰上），于是声明默认命名空间、直接写 `<response>` 的
 * 服务端解析出 0 条——UI 表现为"远程目录为空 / 找不到已有备份"，与服务器实际内容无关。
 */

const CONFIG = {
  serverUrl: 'https://dav.example.com/remote.php/dav/files/u',
  username: 'u',
  password: 'p',
  backupPath: '/backup',
};

/** 一个目录 + 一个备份文件；`prefix` 决定标签写法（'D:' / 'd:' / ''＝默认命名空间） */
function multistatus(prefix: string): string {
  const p = (name: string): string => `${prefix}${name}`;
  const decl = prefix ? `xmlns:${prefix.slice(0, -1)}="DAV:"` : 'xmlns="DAV:"';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<${p('multistatus')} ${decl}>`,
    `<${p('response')}><${p('href')}>/remote.php/dav/files/u/backup/</${p('href')}>`,
    `<${p('propstat')}><${p('prop')}><${p('resourcetype')}><${p('collection')}/></${p('resourcetype')}></${p('prop')}>`,
    `<${p('status')}>HTTP/1.1 200 OK</${p('status')}></${p('propstat')}></${p('response')}>`,
    `<${p('response')}><${p('href')}>/remote.php/dav/files/u/backup/%E5%A4%87%E4%BB%BD-2026-11-16.json</${p('href')}>`,
    `<${p('propstat')}><${p('prop')}><${p('getcontentlength')}>4096</${p('getcontentlength')}>`,
    `<${p('getlastmodified')}>Mon, 16 Nov 2026 08:00:00 GMT</${p('getlastmodified')}></${p('prop')}>`,
    `<${p('status')}>HTTP/1.1 200 OK</${p('status')}></${p('propstat')}></${p('response')}>`,
    `</${p('multistatus')}>`,
  ].join('');
}

function stubBody(xml: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 207, text: async () => xml }) as unknown as Response),
  );
}

function client(): WebDAVClient {
  return new WebDAVClient(CONFIG);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebDAV PROPFIND 解析（OPT-11）', () => {
  it('标准 D: 前缀仍然可解析', async () => {
    stubBody(multistatus('D:'));
    const entries = await client().listDirectory();
    expect(entries).toHaveLength(2);
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].name).toBe('备份-2026-11-16.json');
    expect(entries[1].size).toBe(4096);
    expect(entries[1].lastModified).toBeGreaterThan(0);
  });

  it('小写 d: 前缀可解析（旧正则靠 i 标志命中，留作回归）', async () => {
    stubBody(multistatus('d:'));
    const entries = await client().listDirectory();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.isDirectory)).toEqual([true, false]);
    expect(entries[1].size).toBe(4096);
  });

  it('默认命名空间（无前缀）同样可解析', async () => {
    stubBody(multistatus(''));
    const entries = await client().listDirectory();
    expect(entries).toHaveLength(2);
    expect(entries[1].name).toBe('备份-2026-11-16.json');
  });

  it('任意自定义前缀同样可解析', async () => {
    stubBody(multistatus('s:'));
    const entries = await client().listDirectory();
    expect(entries).toHaveLength(2);
    expect(entries[1].size).toBe(4096);
  });

  it('href 以 / 结尾且未给 resourcetype 时按目录处理', async () => {
    stubBody(
      [
        '<?xml version="1.0"?>',
        '<response xmlns="DAV:">',
        '<href>/remote.php/dav/files/u/backup/sub/</href>',
        '<propstat><prop><getcontentlength>0</getcontentlength></prop></propstat>',
        '</response>',
      ].join(''),
    );
    const entries = await client().listDirectory();
    expect(entries).toHaveLength(1);
    expect(entries[0].isDirectory).toBe(true);
  });

  it('无法识别的日期与非数字长度不产生 NaN', async () => {
    stubBody(
      [
        '<?xml version="1.0"?>',
        '<d:multistatus xmlns:d="DAV:">',
        '<d:response><d:href>/remote.php/dav/files/u/backup/x.json</d:href>',
        '<d:propstat><d:prop><d:getcontentlength>abc</d:getcontentlength>',
        '<d:getlastmodified>not-a-date</d:getlastmodified></d:prop></d:propstat></d:response>',
        '</d:multistatus>',
      ].join(''),
    );
    const entries = await client().listDirectory();
    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(0);
    expect(entries[0].lastModified).toBe(0);
  });

  it('空响应与非 WebDAV 文本返回空列表', async () => {
    stubBody('');
    expect(await client().listDirectory()).toEqual([]);
    stubBody('<html><body>502 Bad Gateway</body></html>');
    expect(await client().listDirectory()).toEqual([]);
  });
});
