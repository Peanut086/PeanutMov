import { Capacitor, CapacitorHttp } from '@capacitor/core';

import { AppError } from '@/shared/errors';
import { isAndroid } from '@/shared/platform';

import {
  isNativeDownloadAvailable,
  nativeDownloadCancel,
  nativeDownloadStart,
  nativeDownloadTruncatePart,
  onCompleted,
  onError,
  onProgress,
} from '@/native/downloadPlugin';
import { AppUpdate } from '@/native/updatePlugin';
import type { CurrentAppVersion, DownloadedApk } from '@/native/updatePlugin';

const GITHUB_OWNER = 'Peanut086';
const GITHUB_REPO = 'PeanutMov';
const MANIFEST_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/update.json`;
const CHECK_TIMEOUT_MS = 12_000;

export interface UpdateManifest {
  versionName: string;
  versionCode: number;
  notes: string;
  apk: {
    name: string;
    url: string;
    sha256: string;
    sizeBytes: number;
  };
}

export type UpdateCheckResult =
  | { status: 'unsupported' }
  | { status: 'up-to-date'; currentVersion: CurrentAppVersion }
  | { status: 'available'; currentVersion: CurrentAppVersion; update: UpdateManifest };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionCodeOf(versionName: string): number | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(versionName);
  if (!match || Number(match[1]) > 199 || Number(match[2]) > 99 || Number(match[3]) > 99) return null;
  return Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]);
}

function parseManifest(value: unknown): UpdateManifest {
  if (!isRecord(value) || !isRecord(value['apk'])) {
    throw new AppError('E_PARSE', '更新清单格式不正确');
  }
  const apk = value['apk'];
  const versionName = value['versionName'];
  const versionCode = value['versionCode'];
  const notes = value['notes'];
  const name = apk['name'];
  const url = apk['url'];
  const sha256 = apk['sha256'];
  const sizeBytes = apk['sizeBytes'];

  if (typeof versionName !== 'string'
      || !Number.isSafeInteger(versionCode)
      || (versionCode as number) <= 0
      || versionCodeOf(versionName) !== versionCode
      || typeof notes !== 'string'
      || typeof name !== 'string'
      || typeof url !== 'string'
      || typeof sha256 !== 'string'
      || !/^[0-9a-f]{64}$/i.test(sha256)
      || !Number.isSafeInteger(sizeBytes)
      || (sizeBytes as number) <= 0) {
    throw new AppError('E_PARSE', '更新清单字段不完整或版本号不正确');
  }

  const expectedName = `PeanutMov-${versionName}-release.apk`;
  const expectedUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${versionName}/${expectedName}`;
  if (name !== expectedName || url !== expectedUrl) {
    throw new AppError('E_PARSE', '更新清单中的安装包地址不受信任');
  }

  return {
    versionName,
    versionCode: versionCode as number,
    notes,
    apk: {
      name,
      url,
      sha256,
      sizeBytes: sizeBytes as number,
    },
  };
}

async function fetchManifest(): Promise<UpdateManifest> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AppError('E_TIMEOUT', '检查更新超时，请检查网络后重试'));
    }, CHECK_TIMEOUT_MS);
  });

  try {
    let data: unknown;
    if (Capacitor.isNativePlatform()) {
      const response = await Promise.race([
        CapacitorHttp.request({
          url: MANIFEST_URL,
          method: 'GET',
          headers: { Accept: 'application/json' },
          responseType: 'json',
          connectTimeout: CHECK_TIMEOUT_MS,
          readTimeout: CHECK_TIMEOUT_MS,
        }),
        timedOut,
      ]);
      if (response.status < 200 || response.status >= 300) {
        throw new AppError('E_NETWORK', `检查更新失败（HTTP ${response.status}）`);
      }
      data = response.data;
    } else {
      const response = await Promise.race([
        fetch(MANIFEST_URL, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }),
        timedOut,
      ]);
      if (!response.ok) {
        throw new AppError('E_NETWORK', `检查更新失败（HTTP ${response.status}）`);
      }
      try {
        data = await response.json();
      } catch {
        throw new AppError('E_PARSE', '无法读取 GitHub 更新清单');
      }
    }
    return parseManifest(data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) {
      throw new AppError('E_TIMEOUT', '检查更新超时，请检查网络后重试');
    }
    throw new AppError('E_NETWORK', '无法连接 GitHub，请检查网络或代理设置');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function assertAndroid(): void {
  if (!isAndroid()) throw new AppError('E_NOT_IMPLEMENTED', '仅 Android 客户端支持应用内更新');
}

async function assertDownloader(): Promise<void> {
  if (!(await isNativeDownloadAvailable())) {
    throw new AppError('E_NOT_IMPLEMENTED', '当前安装包不支持原生更新下载，请手动下载安装');
  }
}

let downloadInProgress = false;

async function performDownloadUpdate(
  update: UpdateManifest,
  onPercent: (percent: number) => void,
): Promise<DownloadedApk> {
  await assertDownloader();
  const permission = await AppUpdate.canInstallPackages();
  if (!permission.allowed) {
    throw new AppError('E_INVALID_STATE', 'INSTALL_PERMISSION_REQUIRED');
  }

  const filePath = `updates/PeanutMov-${update.versionCode}-${update.apk.sha256.slice(0, 12)}.apk`;
  const taskId = `app-update-${update.versionCode}-${Date.now()}`;
  try {
    await nativeDownloadTruncatePart(`${filePath}.part`, 0);
  } catch {
    // 首次下载没有 .part；已存在的失败分片会在上面被清空。
  }

  let started = false;
  let offProgress = () => {};
  let offCompleted = () => {};
  let offError = () => {};
  const completion = new Promise<void>((resolve, reject) => {
    offProgress = onProgress((event) => {
      if (event.taskId !== taskId) return;
      const percent = update.apk.sizeBytes > 0
        ? Math.min(100, (event.downloadedBytes / update.apk.sizeBytes) * 100)
        : 0;
      onPercent(Math.max(0, Math.round(percent)));
    });
    offCompleted = onCompleted((event) => {
      if (event.taskId !== taskId) return;
      if (event.totalBytes > 0 && event.totalBytes !== update.apk.sizeBytes) {
        reject(new AppError('E_PARSE', '更新包大小与清单不一致'));
        return;
      }
      onPercent(100);
      resolve();
    });
    offError = onError((event) => {
      if (event.taskId !== taskId) return;
      reject(new AppError('E_NETWORK', event.errorMessage || '更新包下载失败，请重试'));
    });
  });

  try {
    started = true;
    await Promise.all([
      nativeDownloadStart({
        taskId,
        url: update.apk.url,
        filePath,
        headers: { Accept: 'application/vnd.android.package-archive' },
        startBytes: 0,
        totalBytes: update.apk.sizeBytes,
      }),
      completion,
    ]);
  } catch (error) {
    if (started) {
      try {
        await nativeDownloadCancel(taskId);
      } catch {
        // 下载失败后的取消仅用于释放资源，不覆盖原始错误。
      }
    }
    throw error;
  } finally {
    offProgress();
    offCompleted();
    offError();
  }

  return {
    path: filePath,
    sha256: update.apk.sha256,
    versionCode: update.versionCode,
  };
}

export const updateService = {
  async checkForUpdate(): Promise<UpdateCheckResult> {
    if (!isAndroid()) return { status: 'unsupported' };
    const currentVersion = await AppUpdate.getCurrentVersion();
    const update = await fetchManifest();
    if (update.versionCode <= currentVersion.versionCode) {
      return { status: 'up-to-date', currentVersion };
    }
    return { status: 'available', currentVersion, update };
  },

  async canInstallPackages(): Promise<boolean> {
    assertAndroid();
    const result = await AppUpdate.canInstallPackages();
    return result.allowed === true;
  },

  async openUnknownSourcesSettings(): Promise<void> {
    assertAndroid();
    await AppUpdate.openUnknownSourcesSettings();
  },

  async downloadUpdate(
    update: UpdateManifest,
    onPercent: (percent: number) => void,
  ): Promise<DownloadedApk> {
    assertAndroid();
    if (downloadInProgress) {
      throw new AppError('E_INVALID_STATE', 'UPDATE_DOWNLOAD_ACTIVE');
    }
    downloadInProgress = true;
    try {
      return await performDownloadUpdate(update, onPercent);
    } finally {
      downloadInProgress = false;
    }
  },

  async installDownloadedUpdate(apk: DownloadedApk): Promise<void> {
    assertAndroid();
    await AppUpdate.installApk(apk);
  },
};

export function updateErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const code = message.split(':', 1)[0];
  const messages: Record<string, string> = {
    INSTALL_PERMISSION_REQUIRED: '请先允许 PeanutMov 安装未知应用',
    UPDATE_DOWNLOAD_ACTIVE: '更新包正在下载，请等待当前下载完成',
    APK_HASH_MISMATCH: '更新包校验失败，请重新下载',
    APK_HASH_FAILED: '无法校验更新包，请重新下载',
    APK_PACKAGE_MISMATCH: '更新包与当前应用不匹配',
    APK_VERSION_MISMATCH: '更新包版本与清单不一致',
    APK_VERSION_NOT_NEWER: '当前版本不低于更新包版本',
    APK_SIGNATURE_MISMATCH: '更新包签名与当前应用不一致，已停止安装',
    APK_SIGNATURE_FAILED: '无法验证更新包签名，已停止安装',
    INVALID_APK: '下载文件不是有效的 APK',
    INVALID_APK_PATH: '更新包保存路径无效',
    INVALID_APK_SHA256: '更新清单中的 SHA256 无效',
  };
  return messages[code] ?? (message || '更新失败，请稍后重试');
}
