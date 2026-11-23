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
    // S-01：@capacitor/splash-screen 未安装（开屏由 Android 12+ 系统 splash +
    // res/values/styles.xml 的 AppTheme.NoActionBarLaunch 承担），
    // 这一段没有任何插件消费，留着只会让人以为底色和时长在这里调。
    StatusBar: {
      style: 'DARK',
      // 与 --color-bg-base / windowSplashScreenBackground 同值：状态栏、开屏、页面是同一个黑
      backgroundColor: '#000000',
      // CHG-29：Android WebView 的 env(safe-area-inset-top) 恒为 0，且 StatusBar 插件
      // 默认 overlaysWebView=true 会把 WebView 铺到状态栏下。关闭 overlay 让 WebView
      // 回到状态栏下方，避免播放器顶栏/弹幕 HUD 压进状态栏。Android 15+ 的 edge-to-edge
      // 由 adjustMarginsForEdgeToEdge:'auto' 继续处理。
      overlaysWebView: false,
    },
  },
};

export default config;
