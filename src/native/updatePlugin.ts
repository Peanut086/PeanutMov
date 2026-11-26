import { registerPlugin } from '@capacitor/core';

export interface CurrentAppVersion {
  versionName: string;
  versionCode: number;
}

export interface DownloadedApk {
  path: string;
  sha256: string;
  versionCode: number;
}

export interface AppUpdateNativePlugin {
  getCurrentVersion(): Promise<CurrentAppVersion>;
  canInstallPackages(): Promise<{ allowed: boolean }>;
  openUnknownSourcesSettings(): Promise<void>;
  installApk(options: DownloadedApk): Promise<{ started: boolean }>;
}

export const AppUpdate = registerPlugin<AppUpdateNativePlugin>('AppUpdate');
