import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 版本号只有一个来源：仓库根的 package.json。
 * 前端不写死数字，否则改了版本之后界面上的版本一定会漂移。
 *
 * 用 new URL 而不是 process.cwd()：`pnpm build` 可能在 web/ 里跑，
 * 也可能被根目录的 script 调起，cwd 不可靠，而 import.meta.url 永远指向本文件。
 */
const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 看板数据来自 waker 网关，开发环境走代理避免跨域
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
