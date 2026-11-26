import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeDownloadTask } from '@/native/downloadPlugin';
import type { UpdateManifest } from '@/services/updateService';
import { updateErrorMessage, updateService } from '@/services/updateService';

const mocks = vi.hoisted(() => ({
  isAndroid: vi.fn(),
  getCurrentVersion: vi.fn(),
  canInstallPackages: vi.fn(),
  openUnknownSourcesSettings: vi.fn(),
  installApk: vi.fn(),
  isNativeDownloadAvailable: vi.fn(),
  nativeDownloadStart: vi.fn(),
  nativeDownloadCancel: vi.fn(),
  nativeDownloadTruncatePart: vi.fn(),
  onProgress: vi.fn(),
  onCompleted: vi.fn(),
  onError: vi.fn(),
}));

const listeners = vi.hoisted(() => ({
  progress: undefined as undefined | ((event: unknown) => void),
  completed: undefined as undefined | ((event: unknown) => void),
  error: undefined as undefined | ((event: unknown) => void),
}));

vi.mock('@/shared/platform', () => ({ isAndroid: mocks.isAndroid }));
vi.mock('@/native/updatePlugin', () => ({
  AppUpdate: {
    getCurrentVersion: mocks.getCurrentVersion,
    canInstallPackages: mocks.canInstallPackages,
    openUnknownSourcesSettings: mocks.openUnknownSourcesSettings,
    installApk: mocks.installApk,
  },
}));
vi.mock('@/native/downloadPlugin', () => ({
  isNativeDownloadAvailable: mocks.isNativeDownloadAvailable,
  nativeDownloadStart: mocks.nativeDownloadStart,
  nativeDownloadCancel: mocks.nativeDownloadCancel,
  nativeDownloadTruncatePart: mocks.nativeDownloadTruncatePart,
  onProgress: mocks.onProgress,
  onCompleted: mocks.onCompleted,
  onError: mocks.onError,
}));

const MANIFEST: UpdateManifest = {
  versionName: '0.2.0',
  versionCode: 200,
  notes: '修复若干问题',
  apk: {
    name: 'PeanutMov-0.2.0-release.apk',
    url: 'https://github.com/Peanut086/PeanutMov/releases/download/v0.2.0/PeanutMov-0.2.0-release.apk',
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
  },
};

function responseWith(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('updateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    listeners.progress = undefined;
    listeners.completed = undefined;
    listeners.error = undefined;
    mocks.isAndroid.mockReturnValue(true);
    mocks.getCurrentVersion.mockResolvedValue({ versionName: '0.1.0', versionCode: 100 });
    mocks.canInstallPackages.mockResolvedValue({ allowed: true });
    mocks.isNativeDownloadAvailable.mockResolvedValue(true);
    mocks.nativeDownloadTruncatePart.mockResolvedValue(undefined);
    mocks.onProgress.mockImplementation((callback) => {
      listeners.progress = callback;
      return vi.fn();
    });
    mocks.onCompleted.mockImplementation((callback) => {
      listeners.completed = callback;
      return vi.fn();
    });
    mocks.onError.mockImplementation((callback) => {
      listeners.error = callback;
      return vi.fn();
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('checks the stable GitHub manifest and reports an available update', async () => {
    vi.mocked(fetch).mockResolvedValue(responseWith(MANIFEST));

    const result = await updateService.checkForUpdate();

    expect(result).toEqual({
      status: 'available',
      currentVersion: { versionName: '0.1.0', versionCode: 100 },
      update: MANIFEST,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/Peanut086/PeanutMov/releases/latest/download/update.json',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('reports up-to-date when the manifest versionCode is not newer', async () => {
    vi.mocked(fetch).mockResolvedValue(responseWith(MANIFEST));
    mocks.getCurrentVersion.mockResolvedValue({ versionName: '0.2.0', versionCode: 200 });

    await expect(updateService.checkForUpdate()).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: { versionName: '0.2.0', versionCode: 200 },
    });
  });

  it('does not contact GitHub outside Android', async () => {
    mocks.isAndroid.mockReturnValue(false);

    await expect(updateService.checkForUpdate()).resolves.toEqual({ status: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a manifest whose versionCode does not match versionName', async () => {
    vi.mocked(fetch).mockResolvedValue(responseWith({ ...MANIFEST, versionCode: 201 }));

    await expect(updateService.checkForUpdate()).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('rejects an APK URL outside the expected GitHub release path', async () => {
    vi.mocked(fetch).mockResolvedValue(responseWith({
      ...MANIFEST,
      apk: { ...MANIFEST.apk, url: 'https://example.com/update.apk' },
    }));

    await expect(updateService.checkForUpdate()).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('surfaces GitHub HTTP failures', async () => {
    vi.mocked(fetch).mockResolvedValue(responseWith({}, 404));

    await expect(updateService.checkForUpdate()).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: '检查更新失败（HTTP 404）',
    });
  });

  it('times out a stalled manifest request', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const result = updateService.checkForUpdate();
    const assertion = expect(result).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
  });

  it('downloads through the native downloader and reports progress', async () => {
    mocks.nativeDownloadStart.mockImplementation(async (task: NativeDownloadTask) => {
      listeners.progress?.({
        taskId: task.taskId,
        downloadedBytes: 1024,
        totalBytes: 2048,
        speedBps: 1024,
      });
      listeners.completed?.({ taskId: task.taskId, filePath: task.filePath, totalBytes: 2048 });
    });
    const onPercent = vi.fn();

    const result = await updateService.downloadUpdate(MANIFEST, onPercent);

    expect(mocks.nativeDownloadTruncatePart).toHaveBeenCalledWith(
      'updates/PeanutMov-200-aaaaaaaaaaaa.apk.part',
      0,
    );
    expect(mocks.nativeDownloadStart).toHaveBeenCalledWith(expect.objectContaining({
      url: MANIFEST.apk.url,
      filePath: 'updates/PeanutMov-200-aaaaaaaaaaaa.apk',
      startBytes: 0,
      totalBytes: 2048,
    }));
    expect(onPercent.mock.calls.map(([percent]) => percent)).toEqual([50, 100]);
    expect(result).toEqual({
      path: 'updates/PeanutMov-200-aaaaaaaaaaaa.apk',
      sha256: MANIFEST.apk.sha256,
      versionCode: 200,
    });
  });

  it('rejects a second download while the first update file is still being written', async () => {
    let finishFirst = () => {};
    mocks.nativeDownloadStart.mockImplementation(() => new Promise<void>((resolve) => {
      finishFirst = resolve;
    }));

    const first = updateService.downloadUpdate(MANIFEST, vi.fn());
    try {
      await vi.waitFor(() => expect(mocks.nativeDownloadStart).toHaveBeenCalledTimes(1));
      await expect(updateService.downloadUpdate(MANIFEST, vi.fn())).rejects.toMatchObject({
        code: 'E_INVALID_STATE',
        message: 'UPDATE_DOWNLOAD_ACTIVE',
      });
      expect(mocks.nativeDownloadStart).toHaveBeenCalledTimes(1);
    } finally {
      const task = mocks.nativeDownloadStart.mock.calls[0]![0] as NativeDownloadTask;
      listeners.completed?.({ taskId: task.taskId, filePath: task.filePath, totalBytes: 2048 });
      finishFirst();
      await first;
    }
  });

  it('stops before downloading when install permission is missing', async () => {
    mocks.canInstallPackages.mockResolvedValue({ allowed: false });

    await expect(updateService.downloadUpdate(MANIFEST, vi.fn())).rejects.toMatchObject({
      code: 'E_INVALID_STATE',
      message: 'INSTALL_PERMISSION_REQUIRED',
    });
    expect(mocks.nativeDownloadStart).not.toHaveBeenCalled();
  });

  it('rejects a completed APK whose size differs from the manifest', async () => {
    mocks.nativeDownloadStart.mockImplementation(async (task: NativeDownloadTask) => {
      listeners.completed?.({ taskId: task.taskId, filePath: task.filePath, totalBytes: 1024 });
    });

    await expect(updateService.downloadUpdate(MANIFEST, vi.fn())).rejects.toMatchObject({ code: 'E_PARSE' });
    expect(mocks.nativeDownloadCancel).toHaveBeenCalled();
  });

  it('propagates native download errors and cancels the task', async () => {
    mocks.nativeDownloadStart.mockImplementation(async (task: NativeDownloadTask) => {
      listeners.error?.({
        taskId: task.taskId,
        errorCode: 'E_NETWORK',
        errorMessage: '连接中断',
      });
    });

    await expect(updateService.downloadUpdate(MANIFEST, vi.fn())).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: '连接中断',
    });
    expect(mocks.nativeDownloadCancel).toHaveBeenCalled();
  });

  it('delegates installation with the downloaded path, hash, and versionCode', async () => {
    const apk = { path: 'updates/test.apk', sha256: MANIFEST.apk.sha256, versionCode: 200 };

    await updateService.installDownloadedUpdate(apk);

    expect(mocks.installApk).toHaveBeenCalledWith(apk);
  });

  it('maps native security failures to actionable messages', () => {
    expect(updateErrorMessage(new Error('APK_SIGNATURE_MISMATCH: signature differs')))
      .toBe('更新包签名与当前应用不一致，已停止安装');
    expect(updateErrorMessage(new Error('INSTALL_PERMISSION_REQUIRED')))
      .toBe('请先允许 PeanutMov 安装未知应用');
    expect(updateErrorMessage(undefined)).toBe('更新失败，请稍后重试');
  });
});
