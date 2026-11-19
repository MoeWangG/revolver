/// <reference types="vite/client" />

/**
 * 构建时由 vite.config.ts 注入：仓库根 package.json 的 version。
 * 前端不写死版本号，避免和发布版本漂移。
 */
declare const __APP_VERSION__: string;
