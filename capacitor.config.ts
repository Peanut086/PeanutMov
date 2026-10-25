import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.qoder.cinema',
  appName: 'PeanutMov',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
    // CHG-28：targetSdk 35 在 Android 15+ 被系统强制 edge-to-edge（WebView 铺到
    // 状态栏下），而 Android WebView 的 env(safe-area-inset-top) 恒为 0，
    // CSS --safe-top 兜不住。auto 让 Capacitor 按系统栏 insets 给 WebView 加边距，
    // 顶（状态栏）/底（手势条）一次解决
    adjustMarginsForEdgeToEdge: 'auto',
  },
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 300,
      backgroundColor: '#0b0b0f',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b0b0f',
    },
  },
};

export default config;
