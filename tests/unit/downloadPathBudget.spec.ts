import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 下载落盘路径的两条硬约束（真机实测 DL-P0-1 / DL-P1-1）。
 *
 * - 单个名字（目录名与文件名）不能超过文件系统的 255 **字节**上限。爬虫源的 `mediaId`
 *   是「站点前缀 + 片名」，中文按 3 字节算，实测能直接越过 255；旧实现不做长度预算，
 *   首次写盘就抛 ENAMETOOLONG，而重试算出来的还是同一个超长路径，用户只能反复撞墙。
 * - `.part` 晋升成成品之前必须按磁盘真实大小对账。旧实现先 rename 再比较，而且两边
 *   比的都是内存计数器——自己跟自己对账恒相等，真截断反而查不出来，照样标「已完成」。
 */
vi.mock('@/shared/platform', () => ({
  isNative: vi.fn(() => true),
}));

const fs = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  deleteFile: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: fs,
}));

import { NativeFsSink, nativeFilePathOf } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';

/** 只填路径构造真正读到的字段 */
function pathTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    url: 'https://cdn.example.com/720p.m3u8',
    format: 'hls',
    ...overrides,
  } as DownloadTask;
}

/** 按字节记账的假文件系统：这里只关心每个路径的实际长度 */
let store: Map<string, number>;
/** 设成数字后，下一次 append 只落这么多字节（模拟写盘丢字节） */
let truncateAppendTo: number | null;

function installFakeFs(): void {
  store = new Map();
  truncateAppendTo = null;
  fs.mkdir.mockResolvedValue(undefined);
  fs.deleteFile.mockImplementation(async ({ path }: { path: string }) => {
    store.delete(path);
  });
  fs.writeFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    store.set(path, Buffer.from(data, 'base64').length);
  });
  fs.appendFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    const append = truncateAppendTo ?? Buffer.from(data, 'base64').length;
    store.set(path, (store.get(path) ?? 0) + append);
  });
  fs.stat.mockImplementation(async ({ path }: { path: string }) => {
    if (!store.has(path)) return Promise.reject({ code: 'OS-PLUG-FILE-0008', message: 'File does not exist' });
    return { type: 'file', size: store.get(path) as number, mtime: 1 };
  });
  fs.rename.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
    store.set(to, store.get(from) ?? 0);
    store.delete(from);
  });
}

function byteLength(value: string): number {
  return Buffer.from(value, 'utf8').length;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentDirNameOf(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/'));
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/** 超长 ID：40 个汉字（120 字节）× 2 段，中间还带 `:` 与 `~`，合计 339 字节 */
const LONG_ID = `${'绝命毒师全集完整版高清无删减'.repeat(4)}:${'第一季第一集国语配音双语字幕'.repeat(4)}~1`;

beforeEach(() => {
  vi.resetAllMocks();
  installFakeFs();
});

describe('下载路径长度预算（DL-P0-1）', () => {
  it('未超预算的 ID 原样使用，不改名', () => {
    expect(nativeFilePathOf(pathTask())).toBe('downloads/demo_m1/demo_m1_e1.ts');
  });

  it('超长 ID 的目录名与文件名都收进 255 字节上限（含 .part 与扩展名）', () => {
    const path = nativeFilePathOf(pathTask({ mediaId: LONG_ID, episodeId: LONG_ID }));
    expect(byteLength(parentDirNameOf(path))).toBeLessThanOrEqual(255);
    // 最终名与下载期的 `.part` 名都要能放进单个目录项
    expect(byteLength(nameOf(path))).toBeLessThanOrEqual(255);
    expect(byteLength(`${nameOf(path)}.part`)).toBeLessThanOrEqual(255);
  });

  it('截断保持确定性：同一条任务永远得到同一个路径（续传/去重依赖它）', () => {
    const task = pathTask({ mediaId: LONG_ID, episodeId: `${LONG_ID}e2` });
    expect(nativeFilePathOf(task)).toBe(nativeFilePathOf(task));
  });

  it('前缀相同、尾段不同的长 ID 不会被截成同一个文件', () => {
    const left = nativeFilePathOf(pathTask({ mediaId: LONG_ID, episodeId: `${LONG_ID}#ep1` }));
    const right = nativeFilePathOf(pathTask({ mediaId: LONG_ID, episodeId: `${LONG_ID}#ep2` }));
    expect(left).not.toBe(right);
  });

  it('写盘遇到 ENAMETOOLONG 时不再谎报「文件不可用」，也不留给退避重试', async () => {
    fs.appendFile.mockRejectedValue({ code: 'OS-PLUG-FILE-0013', message: 'File name too long' });

    const sink = new NativeFsSink();
    await sink.begin({ task: pathTask(), startBytes: 0 });

    await expect(sink.write(new Uint8Array(600 * 1024))).rejects.toMatchObject({
      code: 'E_NAME_TOO_LONG',
      retryable: false,
    });
  });
});

describe('.part 晋升成品的磁盘对账（DL-P1-1）', () => {
  it('落盘字节数与计数一致时正常改名，并按磁盘大小回报', async () => {
    const sink = new NativeFsSink();
    await sink.begin({ task: pathTask(), startBytes: 0 });
    await sink.write(new Uint8Array(2000).fill(7));
    const result = await sink.finish();

    expect(result.size).toBe(2000);
    expect(store.get('downloads/demo_m1/demo_m1_e1.ts')).toBe(2000);
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });

  it('磁盘实际大小小于写入计数：不改名、不产出成品，判成本集文件异常', async () => {
    const sink = new NativeFsSink();
    await sink.begin({ task: pathTask(), startBytes: 0 });
    await sink.write(new Uint8Array(2000).fill(7));
    truncateAppendTo = 1000; // 最后一段缓冲刷盘时少了一半

    await expect(sink.finish()).rejects.toMatchObject({ code: 'E_LOCAL_CORRUPT' });
    expect(fs.rename).not.toHaveBeenCalled();
    // 半截数据留在 .part 里供续传，不以成品名出现
    expect(store.has('downloads/demo_m1/demo_m1_e1.ts.part')).toBe(true);
    expect(store.has('downloads/demo_m1/demo_m1_e1.ts')).toBe(false);
  });

  it('.part 被外部清理掉时按「文件缺失」上报，不冒充可续传的大小不一致', async () => {
    // 模拟下载中途 .part 被系统清理/存储优化删掉：刷盘之后这个路径已经不存在
    fs.appendFile.mockImplementation(async ({ path }: { path: string }) => {
      store.delete(path);
    });

    const sink = new NativeFsSink();
    await sink.begin({ task: pathTask(), startBytes: 0 });
    await sink.write(new Uint8Array(2000).fill(7));

    await expect(sink.finish()).rejects.toMatchObject({ code: 'E_FILE_MISSING' });
    expect(fs.rename).not.toHaveBeenCalled();
  });
});
