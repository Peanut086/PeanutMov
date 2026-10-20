import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.qoder.cinema',
  appName: 'PeanutMov',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
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
    },
  },
};

export default config;
