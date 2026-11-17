import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 11-17「本地文件不可用，无法继续下载」排查结论：
 * Capacitor 7 的 Filesystem 在 Android 侧 reject 的是 `{code, message}` **普通对象**
 * （`OS-PLUG-FILE-00NN`），不是 Error。旧分类器只认 `e instanceof Error`，于是
 * - `mkdir` 的「目录已存在」(0010) 没被咽掉 → 抛错；
 * - 任何一次写盘/删除抖动都落到兜底 `E_FILE_MISSING`；
 * - `stat` 把配额/权限故障一律当成「文件不存在」。
 * 用户看到的就是与真因无关的一句「本地文件不可用，请重新下载」。
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

import { deleteFile, ensureDir, renameFile, stat } from '@/native/fs';

/** Capacitor 7 的真实拒绝形态：普通对象，没有 Error 原型 */
function pluginRejection(code: string, message: string): unknown {
  return { code, message };
}

describe('原生文件系统异常分类（Capacitor 7 plain object）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.deleteFile.mockResolvedValue(undefined);
    fs.stat.mockResolvedValue({ type: 'file', size: 10, mtime: 1 });
  });

  it('mkdir「目录已存在」按幂等吞掉，不再冒泡成错误', async () => {
    fs.mkdir.mockRejectedValue(pluginRejection('OS-PLUG-FILE-0010', 'Directory Exists'));
    await expect(ensureDir('downloads/media-1')).resolves.toBeUndefined();
  });

  it('删除不存在的文件仍视为成功', async () => {
    fs.deleteFile.mockRejectedValue(pluginRejection('OS-PLUG-FILE-0008', 'File does not exist'));
    await expect(deleteFile('downloads/media-1/ep-1.ts.part')).resolves.toBeUndefined();
  });

  it('stat 的「不存在」返回 exists:false，其它故障原样抛出', async () => {
    fs.stat.mockRejectedValueOnce(pluginRejection('OS-PLUG-FILE-0008', 'File does not exist'));
    await expect(stat('downloads/media-1/ep-1.ts.part')).resolves.toEqual({
      exists: false,
      size: 0,
      mtime: null,
    });

    fs.stat.mockRejectedValueOnce(pluginRejection('OS-PLUG-FILE-0012', 'No space left on device'));
    await expect(stat('downloads/media-1/ep-1.ts.part')).rejects.toMatchObject({
      code: 'E_STORAGE_QUOTA',
    });
  });

  it('删除写盘失败不再谎报「本地文件不可用」', async () => {
    fs.deleteFile.mockRejectedValue(pluginRejection('OS-PLUG-FILE-0011', 'Permission denied'));
    await expect(deleteFile('downloads/media-1/ep-1.ts.part')).rejects.toMatchObject({
      code: 'E_UNKNOWN',
      detail: 'Permission denied',
    });
  });

  it('旧形态（Error 实例 / 字符串）依然能分类，保证非原生回退可用', async () => {
    fs.mkdir.mockRejectedValue(new Error('Directory Exists'));
    await expect(ensureDir('downloads/media-1')).resolves.toBeUndefined();

    fs.mkdir.mockRejectedValue('something broke');
    await expect(ensureDir('downloads/media-1')).rejects.toMatchObject({ code: 'E_UNKNOWN' });
  });

  /**
   * 真机日志里的第二个现场：Android 的 rename 不覆盖已存在目标（0010），
   * 而下载完成正是 `.part` → 最终文件改名。上一次会话留下过最终文件的任务，
   * 于是每次都在最后一步撞墙，被写成「本地文件不可用，请重新下载」——重下再撞一次。
   */
  it('改名遇到「目标已存在」：清掉旧产物后重试一次，任务照常完成', async () => {
    fs.rename
      .mockRejectedValueOnce(pluginRejection('OS-PLUG-FILE-0010', 'Destination already exists'))
      .mockResolvedValueOnce(undefined);

    await expect(renameFile('downloads/media-1/ep-1.ts.part', 'downloads/media-1/ep-1.ts')).resolves.toBeUndefined();

    expect(fs.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'downloads/media-1/ep-1.ts' }),
    );
    expect(fs.rename).toHaveBeenCalledTimes(2);
  });

  it('改名重试仍失败时按真因抛出，不把原始对象漏给调用方', async () => {
    fs.rename.mockRejectedValueOnce(pluginRejection('OS-PLUG-FILE-0010', 'Destination already exists'));
    fs.rename.mockRejectedValueOnce(pluginRejection('OS-PLUG-FILE-0011', 'Permission denied'));

    await expect(renameFile('downloads/media-1/ep-1.ts.part', 'downloads/media-1/ep-1.ts')).rejects.toMatchObject({
      code: 'E_UNKNOWN',
      detail: 'Permission denied',
    });
  });

  it('.part 确实不在时仍按文件缺失上报（这句是真话）', async () => {
    fs.rename.mockRejectedValueOnce(pluginRejection('OS-PLUG-FILE-0008', 'File does not exist'));

    await expect(renameFile('downloads/media-1/ep-1.ts.part', 'downloads/media-1/ep-1.ts')).rejects.toMatchObject({
      code: 'E_FILE_MISSING',
    });
    expect(fs.deleteFile).not.toHaveBeenCalled();
  });
});
