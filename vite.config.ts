import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 直接读取 package.json 版本号，避免 npx vite build 时 process.env.npm_package_version 为 "0.0.0"
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const appVersion = pkg.version ?? '0.0.0';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/hls.js')) return 'hls';
          if (id.includes('node_modules/vue/') || id.includes('node_modules/@vue/')) return 'vue';
          if (id.includes('node_modules/vue-router')) return 'vue-router';
          if (id.includes('node_modules/pinia')) return 'pinia';
          if (id.includes('node_modules/idb')) return 'idb';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
